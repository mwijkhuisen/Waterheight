import { statSync, utimesSync, writeFileSync } from 'node:fs';

// The contract heartbeat: every long-running role touches /tmp/rws-heartbeat
// every 30 s from its main loop; `healthcheck` exits 0 iff it is < 120 s old
// (a Compose healthcheck in distroless, without a shell).

export const HEARTBEAT_PATH = '/tmp/rws-heartbeat';
export const HEARTBEAT_EVERY_MS = 30_000;
export const HEARTBEAT_MAX_AGE_MS = 120_000;

export function touch(path = HEARTBEAT_PATH): void {
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    writeFileSync(path, '', { mode: 0o644 });
  }
}

/** Touches now and every 30 s; the timer does not keep the process alive by itself. */
export function startHeartbeat(path = HEARTBEAT_PATH): () => void {
  touch(path);
  const timer = setInterval(() => touch(path), HEARTBEAT_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function healthy(path = HEARTBEAT_PATH, now = Date.now()): boolean {
  try {
    return now - statSync(path).mtimeMs < HEARTBEAT_MAX_AGE_MS;
  } catch {
    return false;
  }
}
