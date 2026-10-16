import type { Metadata } from 'next';
import { Brand } from './_components/Shell';
import './styles/not-found.css';
// A24g: the 404 of the app, for any URL no route answers (Next file convention `not-found`,
// rendered inside the root layout, so fonts, tokens and the nonce CSP of every page apply). A
// Server Component with no script of its own; a plain link, so "Back to Overview" loads `/` anew.
export const metadata: Metadata = { title: 'Page not found · Banana Bank' };
export default function NotFound() {
  return (
    <main className="not-found">
      <a className="brand" href="/" aria-label="Banana Bank home">
        <Brand />
      </a>
      <h1>This page does not exist.</h1>
      <p>The address may be mistyped, or the page may have moved.</p>
      <a className="primary-button" href="/">
        Back to Overview
      </a>
    </main>
  );
}
