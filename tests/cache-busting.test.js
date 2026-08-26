import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const indexHtml = readFileSync(new URL('index.html', root), 'utf8');
const authHtml = readFileSync(new URL('auth.html', root), 'utf8');
const version = indexHtml.match(/\.\/css\/app\.css\?v=([^"']+)/)?.[1] || '';

test('browser CSS and JavaScript share one cache-busting version', () => {
  assert.match(version, /^\d{8}-\d+$/);
  [indexHtml, authHtml].forEach((html) => {
    const assets = [...html.matchAll(/(?:href|src)="(\.\/(?:css|js)\/[^"?]+)(?:\?v=([^"&]+))?"/g)];
    assert.ok(assets.length >= 2);
    assets.forEach(([, asset, assetVersion]) => {
      assert.equal(assetVersion, version, `${asset} must use cache version ${version}`);
    });
  });

  readdirSync(new URL('js/', root)).filter((name) => name.endsWith('.js')).forEach((name) => {
    const source = readFileSync(new URL(`js/${name}`, root), 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.\/[^"']+\.js)(?:\?v=([^"']+))?["']/g)];
    imports.forEach(([, importedModule, importVersion]) => {
      assert.equal(importVersion, version, `${name} -> ${importedModule} must use cache version ${version}`);
    });
  });
});
