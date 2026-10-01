// Child process for kill.test.ts: writes one capture through the real
// archive writer and pauses at the requested stage until it is killed.
import { Archive, sha256 } from '../../src/archive/writer.ts';

const [root = '', stage = 'tmp'] = process.argv.slice(2);
const pause = () =>
  new Promise<void>(() => {
    // Keeps the event loop alive: without it the child exits on its own (code 13,
    // unsettled top-level await) and can beat the test's SIGKILL.
    setInterval(() => {}, 60_000);
    process.send?.('paused');
  });
const archive = new Archive(root, stage === 'tmp' ? { afterTmpWrite: pause } : { afterRename: pause });
const body = Buffer.from(JSON.stringify({ Succesvol: true, WaarnemingenLijst: ['x'.repeat(50_000)] }));
const hash = sha256(body);
const at = new Date('2026-10-02T12:01:07Z');
const { key, stored } = await archive.put('NL-1', 'nl-1-obs-key', at, body, hash);
await archive.append({
  v: 1,
  source: 'NL-1',
  spec: 'nl-1-obs-key',
  spec_version: 1,
  variant: 'lobith.bovenrijn.tolkamer/H',
  request: { method: 'POST', url: 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/x' },
  fetched_at: { start: at.toISOString(), end: at.toISOString() },
  status: 200,
  headers: {},
  sha256: hash,
  bytes: body.length,
  stored_bytes: stored,
  key,
  dup_of: null,
  gate: { kind: 'hash', key: null, open: true },
  shape: null,
  shape_changed: false,
  validity: { ok: true, reason: null, count: 1 },
  retention: 'obs',
  error: null,
});
process.send?.('done');
