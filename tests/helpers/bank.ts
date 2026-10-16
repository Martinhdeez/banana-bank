// Shared setup for transfer tests: temp data dir + the simulator on a free port.
// Call setupEnv() before importing any src/ module (config reads env at import time).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
export async function freePort() {
  return new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
export async function setupEnv(prefix: string, port?: number) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  port ??= await freePort();
  // SEC1: existing suites fire many transfers per customer; tests/sec1-rate-limits.test.ts
  // covers the limits.
  process.env.RATE_LIMIT_SCALE ??= '0';
  // SI4: reading the dashboard classifies movements; no test calls a model unless it asks to.
  process.env.DECIDER ??= 'none';
  process.env.DATA_DIR = temp;
  process.env.BANK_DATA_DIR = temp;
  process.env.BANK_PORT = String(port);
  process.env.BANK_URL = `http://127.0.0.1:${port}`;
  return { temp, port };
}
// BANK_IMPL=alt starts the independent contract bank (tests/alt-bank/server.ts) instead.
export async function startSimulator(
  impl = process.env.BANK_IMPL === 'alt' ? 'alt' : 'simulator',
): Promise<ChildProcess> {
  const entry = impl === 'alt' ? 'tests/alt-bank/server.ts' : 'simulator/server.ts';
  const bank = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: process.env,
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${process.env.BANK_URL}/health`)).ok) return bank;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Bank simulator did not start.');
}
export async function callApi(userId: string, route: string, body?: unknown) {
  const { GET, POST } = await import('../../app/api/[...path]/route');
  const { sessionToken } = await import('../../src/auth');
  const request = new Request(`http://localhost/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `banana_actor=${sessionToken(userId)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await (body === undefined ? GET : POST)(request, {
    params: Promise.resolve({ path: route.split('/') }),
  });
  return { status: response.status, body: (await response.json()) as any };
}
