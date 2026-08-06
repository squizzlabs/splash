#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LATEST_URL="https://developers.eveonline.com/static-data/tranquility/latest.jsonl"
ARCHIVE_URL="https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip"
CURRENT_VERSION_FILE="${REPO_ROOT}/data/sde-version.json"
FORCE=false

if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--force]" >&2
  exit 2
fi

for command in curl unzip node mktemp find; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Missing required command: ${command}" >&2
    exit 1
  fi
done

tmp_dir="$(mktemp -d)"
cleanup() {
  if [[ -n "${tmp_dir}" && -d "${tmp_dir}" && "${tmp_dir}" == /tmp/* ]]; then
    rm -rf "${tmp_dir}"
  fi
}
trap cleanup EXIT

latest_file="${tmp_dir}/latest.json"
archive_file="${tmp_dir}/sde.zip"
unpack_dir="${tmp_dir}/sde"
graph_file="${tmp_dir}/universe.json"
version_file="${tmp_dir}/sde-version.json"

echo "Checking the current EVE Online SDE release..."
curl -fsSL "${LATEST_URL}" -o "${latest_file}"

if [[ "${FORCE}" != true && -f "${CURRENT_VERSION_FILE}" ]]; then
  if node -e '
    const fs = require("fs");
    const current = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const latest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.exit(current.buildNumber === latest.buildNumber ? 0 : 1);
  ' "${CURRENT_VERSION_FILE}" "${latest_file}"; then
    build_number="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).buildNumber)' "${latest_file}")"
    echo "SDE build ${build_number} is already installed. Use --force to rebuild it."
    exit 0
  fi
fi

echo "Downloading the current JSONL SDE..."
curl -fSL "${ARCHIVE_URL}" -o "${archive_file}"
mkdir -p "${unpack_dir}"
unzip -q "${archive_file}" -d "${unpack_dir}"

systems_file="$(find "${unpack_dir}" -type f -name mapSolarSystems.jsonl -print -quit)"
stargates_file="$(find "${unpack_dir}" -type f -name mapStargates.jsonl -print -quit)"
regions_file="$(find "${unpack_dir}" -type f -name mapRegions.jsonl -print -quit)"
constellations_file="$(find "${unpack_dir}" -type f -name mapConstellations.jsonl -print -quit)"
stations_file="$(find "${unpack_dir}" -type f -name npcStations.jsonl -print -quit)"
moons_file="$(find "${unpack_dir}" -type f -name mapMoons.jsonl -print -quit)"
corporations_file="$(find "${unpack_dir}" -type f -name npcCorporations.jsonl -print -quit)"
station_operations_file="$(find "${unpack_dir}" -type f -name stationOperations.jsonl -print -quit)"
if [[ -z "${systems_file}" || -z "${stargates_file}" || -z "${regions_file}" || -z "${constellations_file}" || -z "${stations_file}" || -z "${moons_file}" || -z "${corporations_file}" || -z "${station_operations_file}" ]]; then
  echo "The SDE archive did not contain all required map graph and area files." >&2
  exit 1
fi

echo "Building the browser route graph..."
node "${SCRIPT_DIR}/build-sde.mjs" \
  --systems "${systems_file}" \
  --stargates "${stargates_file}" \
  --regions "${regions_file}" \
  --constellations "${constellations_file}" \
  --stations "${stations_file}" \
  --moons "${moons_file}" \
  --corporations "${corporations_file}" \
  --station-operations "${station_operations_file}" \
  --latest "${latest_file}" \
  --out "${graph_file}" \
  --version-out "${version_file}"

echo "Validating the generated graph..."
node "${SCRIPT_DIR}/validate-sde.mjs" --graph "${graph_file}"

mkdir -p "${REPO_ROOT}/data"
mv "${graph_file}" "${REPO_ROOT}/data/universe.json"
mv "${version_file}" "${CURRENT_VERSION_FILE}"

echo "Running the application tests..."
(cd "${REPO_ROOT}" && npm test)
echo "Local SDE update complete."
