import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const mapperTokens = css.match(/\.map-workspace\s*\{([\s\S]*?)\n\}/)?.[1] || '';
const jumpPromptTokens = css.match(/\.map-jump-dialog\s*\{([\s\S]*?)\n\}/)?.[1] || '';

function token(name, scope = mapperTokens) {
  const value = scope.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(value, `Missing mapper color token ${name}`);
  return value;
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('mapper information colors exceed enhanced WCAG text contrast on all panel surfaces', () => {
  const foregrounds = ['--text', '--muted', '--muted-strong', '--metadata', '--blue', '--accent'];
  const backgrounds = ['--panel', '--panel-strong', '--panel-soft'];

  for (const foreground of foregrounds) {
    for (const background of backgrounds) {
      const ratio = contrast(token(foreground), token(background));
      assert.ok(ratio >= 7, `${foreground} on ${background} is only ${ratio.toFixed(2)}:1`);
    }
  }
});

test('mapper control boundary token has WCAG non-text contrast on all panel surfaces', () => {
  for (const background of ['--panel', '--panel-strong', '--panel-soft']) {
    const ratio = contrast(token('--line'), token(background));
    assert.ok(ratio >= 3, `--line on ${background} is only ${ratio.toFixed(2)}:1`);
  }
});

test('wormhole jump prompt keeps mapper contrast guarantees', () => {
  for (const foreground of ['--text', '--muted', '--muted-strong', '--metadata', '--blue', '--accent']) {
    for (const background of ['--panel', '--panel-strong', '--panel-soft']) {
      const ratio = contrast(token(foreground, jumpPromptTokens), token(background, jumpPromptTokens));
      assert.ok(ratio >= 7, `${foreground} on ${background} is only ${ratio.toFixed(2)}:1 in jump prompt`);
    }
  }
  for (const background of ['--panel', '--panel-strong', '--panel-soft']) {
    const ratio = contrast(token('--line', jumpPromptTokens), token(background, jumpPromptTokens));
    assert.ok(ratio >= 3, `--line on ${background} is only ${ratio.toFixed(2)}:1 in jump prompt`);
  }
});
