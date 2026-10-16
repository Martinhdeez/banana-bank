// DV1 (ALT-2): start the bundled simulator only when BANK_URL points to it. BANK_EXTERNAL=1, or a
// BANK_URL on another host or port than the local BANK_PORT, means an external bank is already running.
import { defaults } from '../src/config';
export function usesBundledBank(env: Record<string, string | undefined> = process.env): boolean {
  if (env.BANK_EXTERNAL === '1') return false;
  const url = new URL(env.BANK_URL || defaults.bankUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  return local && port === String(env.BANK_PORT || defaults.bankPort);
}
