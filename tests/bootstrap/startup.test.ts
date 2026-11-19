import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { PROVIDER_VARIABLES } from '../../src/config/env.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';
const ENTRY = 'src/bootstrap/container-entry.ts';

function start(overrides: Record<string, string>): ChildProcess {
  const env = { ...process.env };
  const cleared = [
    'APP_ENV',
    'PORT',
    'SHUTDOWN_TIMEOUT_MS',
    'DB_POOL_MAX',
    'DB_IDLE_TIMEOUT_MS',
    'DB_CONNECTION_TIMEOUT_MS',
    'TEST_DATABASE_URL',
    ...Object.values(PROVIDER_VARIABLES).flat(),
  ];
  for (const key of cleared) delete env[key];
  return spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    env: { ...env, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collect(child: ChildProcess): () => string {
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return () => output;
}

function exited(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not obtain a free port'));
      });
    });
  });
}

async function waitUntilHealthy(url: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('service did not become healthy in time');
}

test('exits with code 1 and names APP_ENV when it is missing', { timeout: 20_000 }, async () => {
  const child = start({ PORT: String(await freePort()) });
  const output = collect(child);
  try {
    assert.equal(await exited(child, 8000), 1);
    assert.match(output(), /Invalid configuration: .*APP_ENV/);
  } finally {
    child.kill();
  }
});

test('exits with code 1 and never prints a supplied value', { timeout: 20_000 }, async () => {
  const child = start({ APP_ENV: 'development', PORT: SENTINEL });
  const output = collect(child);
  try {
    assert.equal(await exited(child, 8000), 1);
    assert.match(output(), /Invalid configuration: .*PORT/);
    assert.ok(!output().includes(SENTINEL), 'a supplied value appeared in the output');
  } finally {
    child.kill();
  }
});

test(
  'starts with valid configuration and answers /health and /ready',
  { timeout: 30_000 },
  async () => {
    const port = await freePort();
    const child = start({ APP_ENV: 'development', PORT: String(port) });
    collect(child);
    try {
      const base = `http://127.0.0.1:${port}`;
      await waitUntilHealthy(`${base}/health`);
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/ready`)).status, 200);
    } finally {
      child.kill();
    }
  },
);

test(
  'logs a redacted configuration summary and never a secret value',
  { timeout: 30_000 },
  async () => {
    const port = await freePort();
    const child = start({
      APP_ENV: 'development',
      PORT: String(port),
      CLERK_SECRET_KEY: SENTINEL,
      CLERK_WEBHOOK_SECRET: `${SENTINEL}-2`,
      DATABASE_URL: `postgres://user:${SENTINEL}@db.example.invalid/app`,
    });
    const output = collect(child);
    try {
      await waitUntilHealthy(`http://127.0.0.1:${port}/health`);
      const text = output();
      assert.match(text, /configuration loaded/);
      assert.match(text, /"clerk":"configured"/);
      assert.ok(!text.includes(SENTINEL), 'a supplied secret appeared in the process output');
    } finally {
      child.kill();
    }
  },
);

// Limit: with an unreachable URL, a successful start shows the pool is lazy and that readiness does
// not depend on the database. It does not show that the pool exists or that a connection works.
test(
  'starts with a configured but unreachable database and never prints its credentials',
  { timeout: 30_000 },
  async () => {
    const port = await freePort();
    const child = start({
      APP_ENV: 'development',
      PORT: String(port),
      DATABASE_URL: 'postgres://user:' + SENTINEL + '@127.0.0.1:1/janesis_test',
    });
    const output = collect(child);
    try {
      const base = 'http://127.0.0.1:' + port;
      await waitUntilHealthy(base + '/health');
      assert.equal((await fetch(base + '/health')).status, 200);
      assert.equal((await fetch(base + '/ready')).status, 200);
      assert.match(output(), /"database":"configured"/);
      assert.ok(!output().includes(SENTINEL), 'a supplied credential appeared in the output');
    } finally {
      child.kill();
    }
  },
);
