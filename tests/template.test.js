import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTemplateLink, normalizeTemplateUrl } from '../js/template.js';

test('template URLs allow relative and HTTP(S) stylesheets but reject active content', () => {
  assert.equal(
    normalizeTemplateUrl('./brand.css', 'https://splash.example/css/app.css'),
    'https://splash.example/css/brand.css'
  );
  assert.equal(
    normalizeTemplateUrl('https://cdn.example/theme.css', 'https://splash.example/'),
    'https://cdn.example/theme.css'
  );
  assert.equal(normalizeTemplateUrl('javascript:alert(1)', 'https://splash.example/'), null);
  assert.equal(normalizeTemplateUrl('data:text/css,body{}', 'https://splash.example/'), null);
});

test('template links normalize relative assets and constrain image sizes', () => {
  const link = normalizeTemplateLink({
    href: '/about',
    label: ' About us ',
    imageSrc: './logo.svg',
    imageAlt: 'Logo',
    imageHeight: 200,
    newTab: true
  }, 'https://splash.example/tools/');

  assert.deepEqual(link, {
    href: 'https://splash.example/about',
    label: 'About us',
    title: '',
    imageSrc: 'https://splash.example/tools/logo.svg',
    imageAlt: 'Logo',
    imageHeight: 48,
    newTab: true
  });
});

test('template links reject unsafe destinations and allow text-only links', () => {
  assert.equal(normalizeTemplateLink({ href: 'javascript:alert(1)', label: 'Unsafe' }), null);
  assert.equal(normalizeTemplateLink({ href: 'https://example.com' }), null);

  const link = normalizeTemplateLink({ href: 'mailto:hello@example.com', label: 'Email us' });
  assert.equal(link.href, 'mailto:hello@example.com');
  assert.equal(link.imageSrc, null);
  assert.equal(link.imageAlt, 'Email us');
  assert.equal(link.newTab, false);
});
