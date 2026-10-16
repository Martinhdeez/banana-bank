import { config } from '../src/config';
import { profiles } from '../simulator/bank';
const profile = process.argv[2] || 'normal';
if (!profiles.includes(profile as any)) {
  console.error(`Profiles: ${profiles.join(', ')}`);
  process.exit(1);
}
try {
  const response = await fetch(`${config.bankUrl}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminSecret}` },
    body: JSON.stringify({ profile, seed: Number(process.argv[3] || 17) }),
  });
  if (!response.ok) throw new Error(`The bank returned ${response.status}.`);
  console.log(await response.json());
} catch (e) {
  console.error(e instanceof Error ? e.message : 'The scenario could not be configured.');
  process.exitCode = 1;
}
