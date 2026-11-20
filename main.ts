// Entry point: the harness lifecycle for this forge.
//
// The env (a separate server the harness starts beside this process) is the only
// thing this file talks to at startup. It tells the env which port our HTTP server
// bound, then waits until the env says the trial is over. Everything the trial
// scores lives in app.ts; this file only keeps the process alive for exactly as
// long as the trial runs.
//
// Steps:
//   1. Read MAKEFUN_ENV_URL. No env URL means there is nothing to register with,
//      so exit 1 right away.
//   2. Start the app server on an ephemeral port (listen(0)); the kernel picks
//      one. Port 8080 belongs to the env and must never be bound here.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. A 200 accepts it; a 409
//      means another entry registered first and this one just waits. A 400 or
//      405 is a contract error and ends the process. Anything else (network
//      error, timeout, other status) is retried with backoff, because the env
//      may still be coming up.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers immediately either way, so this is a plain poll with backoff.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin.length === 0) {
  process.stderr.write('entry: MAKEFUN_ENV_URL is not set, nothing to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT = 30_000;
const FIRST_BACKOFF = 250;
const MAX_BACKOFF = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(failures: number): number {
  const capped = failures > 8 ? 8 : failures;
  const wait = FIRST_BACKOFF * 2 ** capped;
  return wait > MAX_BACKOFF ? MAX_BACKOFF : wait;
}

/** A contract error from the env: not retried, ends the process. */
class Fatal extends Error {}

/** POST the bound port; true when the env has accepted (or already has) it. */
async function announce(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${envOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new Fatal(`register failed with HTTP ${res.status}: ${await res.text()}`);
    }
    return false;
  } catch (err) {
    if (err instanceof Fatal) throw err;
    return false;
  }
}

/** GET /done; true only when the body says the trial is over. */
async function isDone(): Promise<boolean> {
  try {
    const res = await fetch(`${envOrigin}/done`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  } catch {
    return false;
  }
}

/** Run `step` until it returns true, waiting longer after each false. */
async function untilTrue(step: () => Promise<boolean>): Promise<void> {
  let failures = 0;
  for (;;) {
    if (await step()) return;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  process.stdout.write(`entry: listening on ${address.port}\n`);

  await untilTrue(() => announce(address.port));
  process.stdout.write('entry: registered, waiting for done\n');

  await untilTrue(isDone);
  server.close();
  process.stdout.write('entry: done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`entry: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
