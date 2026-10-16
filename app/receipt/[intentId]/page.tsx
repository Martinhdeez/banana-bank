import type { Metadata } from 'next';
import { Receipt } from '../../_components/Receipt';
// CF1-ui: a standalone page (no sidebar or topbar), so it prints as the receipt alone.
export const metadata: Metadata = { title: 'Transfer receipt · Banana Bank' };
export default async function ReceiptPage({ params }: PageProps<'/receipt/[intentId]'>) {
  const { intentId } = await params;
  // Page params arrive still percent-encoded ("lucia%3Arc-…"); Receipt encodes the raw id again.
  let id = intentId;
  try {
    id = decodeURIComponent(intentId);
  } catch {}
  return <Receipt intentId={id} />;
}
