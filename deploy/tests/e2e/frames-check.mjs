// CI only (deploy/tests/e2e/run.sh, P11b issue #26 OV), run inside the server image on the rws_edge network like
// api-sweep.mjs: no dependency, node:https and node:zlib. The hourly frames of the owner site carry the owner series
// (the SPW gauges of BE-3); none of them, and no owner canary rendering, may be in any public frames output.
//   1. the SPW series ids are read from the OWNER stations.json (the site's own file, through caddy-owner);
//   2. the owner /api/v1/frames answer for the last 48 hours names at least one of them (the check is not vacuous: run.sh
//      seeds synthetic hourly values for two SPW gauges first);
//   3. every public frames output (frames/recent.json, every frames/<day>/v<n>.json from the public meta.json's
//      displayStart, at most 30 days back, and the public /api/v1/frames answer for the same 48 hours) is, in identity,
//      gzip and zstd, free of every one of those ids (as a series entry of its `series` array) and of the canary's two
//      renderings (as text, anywhere in the bytes).
// Prints PASS/FAIL lines naming the path and a fixed code, never a value or the password; exit 1 on a failure.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const domain = env('RWS_DOMAIN');
const password = env('OWNER_PW');
const publicCa = readFileSync(env('PUBLIC_CA'));
const ownerCa = readFileSync(env('OWNER_CA'));
const sides = {
  public: { host: 'caddy', port: 443, servername: domain, ca: publicCa, authority: domain },
  owner: { host: 'caddy-owner', port: 8443, servername: `owner.${domain}`, ca: ownerCa, authority: `owner.${domain}` },
};
const CANARIES = ['777777.777', '777777.75'];
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(side, path, encoding) {
  const s = sides[side];
  const headers = { host: s.authority, 'accept-encoding': encoding };
  if (side === 'owner') headers.authorization = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: s.host, port: s.port, servername: s.servername, ca: s.ca, path, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const enc = res.headers['content-encoding'];
          let body = raw;
          try {
            if (enc === 'gzip') body = gunzipSync(raw);
            else if (enc === 'zstd') body = zstdDecompressSync(raw);
            else if (enc === 'br') body = brotliDecompressSync(raw);
          } catch {
            return reject(new Error('undecodable'));
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
/** One GET; a 429 is honoured once. */
async function get(side, path, encoding = 'identity') {
  let res = await once(side, path, encoding);
  if (res.status === 429) {
    const after = Number(res.headers['retry-after']);
    await sleep((Number.isInteger(after) && after >= 1 && after <= 30 ? after : 5) * 1000 + 100);
    res = await once(side, path, encoding);
  }
  return res;
}
const json = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
};

// 1. The SPW series ids, from the owner stations.json.
const ownerStations = json(await get('owner', '/data/v1/stations.json'));
const spw = new Set(
  (ownerStations?.stations ?? [])
    .filter((s) => typeof s.id === 'string' && s.id.startsWith('be.spw.'))
    .flatMap((s) => (s.series ?? []).map((x) => x.id)),
);
check(spw.size > 0, 'frames: the owner stations.json lists SPW series (BE-3)');

// 2. The owner answer, over the last 48 whole hours.
const hour = 3_600_000;
const to = Math.floor(Date.now() / hour) * hour;
const range = `from=${new Date(to - 48 * hour).toISOString()}&to=${new Date(to).toISOString()}&step=1h`;
const ownerFrames = await get('owner', `/api/v1/frames?${range}`);
const ownerBody = json(ownerFrames);
check(
  ownerFrames.status === 200 && Array.isArray(ownerBody?.series) && ownerBody.series.some((id) => spw.has(id)),
  'frames: the owner /api/v1/frames answer names SPW series',
);

// 3. Every public frames output.
const meta = json(await get('public', '/data/v1/meta.json'));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const nowMs = Date.parse(meta?.now ?? '');
const startMs = Math.max(Date.parse(meta?.displayStart ?? ''), nowMs - 30 * 24 * hour);
check(Number.isFinite(nowMs) && Number.isFinite(startMs), 'frames: the public meta.json has now and displayStart');
const paths = ['/data/v1/frames/recent.json', `/api/v1/frames?${range}`];
for (let d = Math.floor(startMs / (24 * hour)) * 24 * hour; d <= nowMs; d += 24 * hour) {
  const day = dayOf(d);
  const v = meta?.dayVersions?.[day] ?? 1;
  if (v !== 0) paths.push(`/data/v1/frames/${day}/v${v}.json`);
}
let seen = 0;
let leaked = 0;
for (const path of paths) {
  for (const encoding of ['identity', 'gzip', 'zstd']) {
    const res = await get('public', path, encoding);
    if (res.status === 404) continue; // a day the archive does not have
    seen += 1;
    const doc = json(res);
    const ids = Array.isArray(doc?.series) ? doc.series : [];
    const hit = ids.some((id) => spw.has(id)) || CANARIES.some((c) => res.body.includes(c));
    if (hit) {
      leaked += 1;
      console.log(`FAIL frames: ${path} (${encoding}) holds an owner series or the owner canary`);
    }
  }
}
check(seen > 0, 'frames: at least one public frames output was read');
check(leaked === 0, `frames: no SPW series id and no owner canary in ${seen} public frames bodies`);
console.log(`frames: ${paths.length} public paths, ${seen} bodies read, ${spw.size} SPW series ids`);

if (failures.length > 0) {
  console.error(`frames-check: ${failures.length} failed`);
  process.exit(1);
}
console.log('PASS frames-check');
