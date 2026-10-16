import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { connection } from 'next/server';
import './globals.css';
// One stylesheet per content view, loaded after the shell and shared styles.
import './styles/overview.css';
import './styles/assistant.css';
import './styles/transfers.css';
import './styles/approvals.css';
import './styles/cases.css';
import './styles/documents.css';
import './styles/receipt.css';
import './styles/notifications.css';
import './styles/movement-filters.css';
import './styles/spend-insights.css';
import './styles/chat-offers.css';
import './styles/prepared.css';
import './styles/observation.css';
import './styles/plan.css';
import './styles/ai-usage.css';
import './styles/assistant-controls.css';
// Geist (SIL OFL, see app/fonts/OFL.txt), bundled so builds never need network access.
const geist = localFont({ src: './fonts/Geist-Variable.woff2', variable: '--font-geist' });
export const metadata: Metadata = {
  title: 'Banana Bank · A little brighter, every day',
  description: 'A simulated banking environment for the Banana challenge.',
};
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // SEC2: the nonce CSP from proxy.ts needs a per-request render, never a prerendered page.
  await connection();
  return (
    // Extensions such as Dark Reader or Grammarly add attributes to <html>/<body> before React
    // hydrates. This only silences attribute mismatches on these two elements (one level deep);
    // the app itself renders nothing time-, locale- or storage-dependent on the server.
    <html lang="en" className={geist.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
