// B3, A24g: the load error (card, one-line form, retry in progress) and the 404 page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadError } from '../app/_components/Shell';

const html = (props = {}) =>
  renderToStaticMarkup(
    createElement(LoadError, { message: 'The bank did not respond.', onRetry() {}, ...props }),
  );

test('B3 the load error names the failure and offers Retry, as a card and in one line', () => {
  for (const inline of [false, true]) {
    const out = html({ inline });
    assert.match(out, /class="[^"]*\bload-error\b[^"]*" role="alert"/);
    assert.match(out, /We could not load your banking/);
    assert.match(out, /The bank did not respond\./);
    assert.match(out, /<button[^>]*>Retry<\/button>/);
    assert.doesNotMatch(out, /disabled/);
  }
  assert.match(html({ inline: true }), /class="alert error load-error"/);
  assert.match(html({ inline: true }), /Your conversations can still be read\./);
});

test('B3 while a retry runs the button is disabled and says so', () => {
  assert.match(html({ busy: true }), /<button[^>]*disabled=""[^>]*>Retrying…<\/button>/);
});

test('A24g the 404 page: mark and wordmark, the message, one link back to the Overview', async () => {
  // Loaded here: the page imports its stylesheet, which node cannot load without this hook.
  const { registerHooks } = await import('node:module');
  registerHooks({
    load: (url, context, next) =>
      url.endsWith('.css')
        ? { format: 'module', source: '', shortCircuit: true }
        : next(url, context),
  });
  const { default: NotFound, metadata } = await import('../app/not-found');
  const out = renderToStaticMarkup(createElement(NotFound));
  assert.match(out, /class="logo-tile"><svg/);
  assert.match(out, /banana<span class="brand-dot">\.<\/span>/);
  assert.match(out, /<h1>This page does not exist\.<\/h1>/);
  assert.match(out, /<a class="primary-button" href="\/">Back to Overview<\/a>/);
  assert.equal(out.match(/<a /g)?.length, 2); // the brand (home) and the button
  assert.doesNotMatch(out, /<script|style=/); // nothing the nonce CSP would have to allow
  assert.match(String(metadata.title), /Page not found/);
});
