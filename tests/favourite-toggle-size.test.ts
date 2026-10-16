// Favourite toggle target size (WCAG 2.2 SC 2.5.8, at least 24x24 px) and pointer-only reveal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app/styles/transfers.css', import.meta.url), 'utf8');
const rule = /\.favourite-toggle \{([^}]*)\}/.exec(css)?.[1] ?? '';

test('favourite toggle is at least 24px square', () => {
  const px = (prop: string) => Number(new RegExp(`\\b${prop}:\\s*(\\d+)px`).exec(rule)?.[1] ?? 0);
  assert.ok(px('width') >= 24, `width ${px('width')}px`);
  assert.ok(px('height') >= 24, `height ${px('height')}px`);
});

test('empty stars hide only on pointer devices and stay focusable', () => {
  const media =
    /@media \(hover: hover\) and \(pointer: fine\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(media, /\.favourite-toggle\[aria-pressed='false'\] \{[^}]*opacity: 0/);
  assert.match(media, /:focus-within \.favourite-toggle/);
  assert.doesNotMatch(css, /\.favourite-toggle[^{]*\{[^}]*(display: none|visibility: hidden)/);
});
