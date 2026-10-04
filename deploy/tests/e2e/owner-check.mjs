// CI only (deploy/tests/e2e/isolation.sh): run inside the server image on the
// rws_edge network. Talks to caddy-owner (SNI owner.<domain>, its internal CA,
// so certificate verification is off) and checks the owner site's gate: every
// request without or with wrong credentials is a 401 with both owner headers,
// and with the right ones the site answers 200 with the same two headers, the
// owner runtime config and the owner canary in latest.json. The password comes
// in through OWNER_PW and is never printed.
import { request } from 'node:https';

const domain = process.env.RWS_DOMAIN;
const password = process.env.OWNER_PW;
if (!domain || !password) throw new Error('RWS_DOMAIN and OWNER_PW are required');
const host = `owner.${domain}`;
const CANARY = /777777\.(777|75)/;

function get(path, auth) {
  return new Promise((resolve, reject) => {
    const headers = { host };
    if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    const req = request(
      { host: 'caddy-owner', port: 8443, path, method: 'GET', servername: host, rejectUnauthorized: false, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const ownerHeaders = (r) =>
  r.headers['cache-control'] === 'private, no-store' && r.headers['x-robots-tag'] === 'noindex, nofollow';

for (const path of [
  '/',
  '/runtime-config.json',
  '/data/v1/meta.json',
  '/data/v1/latest.json',
  '/api/v1/meta',
  '/missing',
]) {
  for (const [label, auth] of [
    ['no credentials', undefined],
    ['wrong credentials', `owner:wrong-${password}`],
  ]) {
    const r = await get(path, auth);
    check(
      r.status === 401 && ownerHeaders(r) && r.body.trim() === '401',
      `${path} with ${label}: 401, private no-store, noindex nofollow, no content`,
    );
    check(!CANARY.test(r.body) && !r.body.includes('audience'), `${path} with ${label}: no owner content in the body`);
  }
}

const auth = `owner:${password}`;
for (const path of [
  '/',
  '/runtime-config.json',
  '/data/v1/meta.json',
  '/data/v1/latest.json',
  '/data/v1/missing.json',
]) {
  const r = await get(path, auth);
  check(ownerHeaders(r), `${path} with credentials: ${r.status}, both owner headers`);
}
const config = await get('/runtime-config.json', auth);
check(
  config.status === 200 && config.body.trim() === '{"audience":"owner"}',
  '/runtime-config.json with credentials is {"audience":"owner"}',
);
const latest = await get('/data/v1/latest.json', auth);
check(
  latest.status === 200 && CANARY.test(latest.body),
  '/data/v1/latest.json with credentials carries the owner canary',
);
const meta = await get('/data/v1/meta.json', auth);
check(
  meta.status === 200 && JSON.parse(meta.body).generatedAt !== undefined,
  "/data/v1/meta.json with credentials is the owner publisher's meta",
);
check((await get('/data/v1/missing.json', auth)).status === 404, 'a missing owner file is a 404');
check((await get('/data/v1/meta.json.zst', auth)).status === 404, 'a precompressed name is a 404');

if (failures.length > 0) {
  console.error(`owner-check: ${failures.length} failed`);
  process.exit(1);
}
