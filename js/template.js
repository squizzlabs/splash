const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const ASSET_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeTemplateUrl(value, baseUrl, protocols = ASSET_PROTOCOLS) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), baseUrl);
    return protocols.has(url.protocol) ? url.href : null;
  } catch (_) {
    return null;
  }
}

export function normalizeTemplateLink(link, baseUrl = 'https://example.invalid/') {
  if (!link || typeof link !== 'object') return null;
  const href = normalizeTemplateUrl(link.href, baseUrl, LINK_PROTOCOLS);
  const label = typeof link.label === 'string' ? link.label.trim().slice(0, 160) : '';
  if (!href || !label) return null;
  const requestedHeight = Number(link.imageHeight);
  return {
    href,
    label,
    title: typeof link.title === 'string' ? link.title.trim().slice(0, 160) : '',
    imageSrc: normalizeTemplateUrl(link.imageSrc, baseUrl),
    imageAlt: typeof link.imageAlt === 'string' ? link.imageAlt.trim().slice(0, 160) : label,
    imageHeight: Number.isFinite(requestedHeight) ? Math.min(48, Math.max(12, Math.round(requestedHeight))) : 20,
    newTab: link.newTab === true
  };
}

export function applyTemplateStylesheet(stylesheetUrl, targetDocument = document) {
  const id = 'template-stylesheet';
  const href = normalizeTemplateUrl(stylesheetUrl, targetDocument.baseURI);
  let stylesheet = targetDocument.getElementById(id);
  if (!href) {
    stylesheet?.remove();
    return;
  }
  if (!stylesheet) {
    stylesheet = targetDocument.createElement('link');
    stylesheet.id = id;
    stylesheet.rel = 'stylesheet';
    targetDocument.head.append(stylesheet);
  }
  stylesheet.href = href;
}

export function renderTemplateLinks(links, targetDocument = document) {
  const container = targetDocument.getElementById('app-footer-links');
  if (!container) return;
  const fragment = targetDocument.createDocumentFragment();
  (Array.isArray(links) ? links : []).forEach((candidate) => {
    const link = normalizeTemplateLink(candidate, targetDocument.baseURI);
    if (!link) return;
    const anchor = targetDocument.createElement('a');
    anchor.href = link.href;
    anchor.setAttribute('aria-label', link.label);
    if (link.title) anchor.title = link.title;
    if (link.newTab) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
    if (link.imageSrc) {
      const image = targetDocument.createElement('img');
      image.className = 'app-footer-link-image';
      image.src = link.imageSrc;
      image.alt = link.imageAlt;
      image.style.height = `${link.imageHeight}px`;
      anchor.append(image);
    } else {
      const text = targetDocument.createElement('span');
      text.className = 'app-footer-link-label';
      text.textContent = link.label;
      anchor.append(text);
    }
    fragment.append(anchor);
  });
  container.replaceChildren(fragment);
  container.hidden = !container.childElementCount;
}

export function applyTemplate(template = {}, targetDocument = document) {
  applyTemplateStylesheet(template.stylesheetUrl, targetDocument);
  renderTemplateLinks(template.footerLinks, targetDocument);
}
