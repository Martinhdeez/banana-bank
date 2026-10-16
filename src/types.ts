export type Person = {
  id: string;
  name: string;
  role: 'customer' | 'operator';
  initials: string;
  color: string;
};
export type Account = {
  id: string;
  userId: string;
  label: string;
  iban: string;
  balanceCents: number;
};
export type TransferInput = {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  concept: string;
};
// K4: the stored states of a transfer intent (intents.status), and the one derived for display:
// an unconfirmed proposal past its expiry is 'expired' (the row stays 'awaiting_confirmation').
export const INTENT_STATUSES = [
  'created',
  'awaiting_confirmation',
  'processing',
  'completed',
  'pending_verification',
  'failed',
  'cancelled',
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];
export type TransferStatus = IntentStatus | 'expired';
export type Operation = TransferInput & {
  id: string;
  userId: string;
  reference: string;
  createdAt: string;
  status: 'completed';
};
export type ToolContext = {
  userId: string;
  conversationId: string | null;
  runId: string;
  intentId: string;
  approvalId?: string;
};
export type ActionResult = { status: string; [key: string]: unknown };
export type DocumentRecord = {
  id: string;
  title: string;
  file: string;
  version: number;
  validFrom: string;
  validTo: string | null;
  audience: 'public' | 'internal';
  family: string;
};
export type Chunk = {
  id: string;
  documentId: string;
  text: string;
  title: string | null;
  version: number | null;
  validFrom: string | null;
  validTo: string | null;
  audience: string;
  vector?: number[];
};
export type SearchResult = Omit<Chunk, 'vector'> & { score: number };
