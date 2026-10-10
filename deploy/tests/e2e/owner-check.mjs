// CI only (deploy/tests/e2e/isolation.sh): run inside the server image on the
// rws_owner_public network (P12a: caddy-owner is off the public edge). Talks to caddy-owner (SNI owner.<domain>; the certificate is
// verified against caddy-owner's own `tls internal` root, OWNER_CA) and checks
// the owner site's gate: every
// request without or with wrong credentials is a 401 with both owner headers,
// and with the right ones the site answers 200 with the same two headers, the
// owner runtime config and the owner canary in latest.json. The password comes
// in through OWNER_PW and is never printed.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const domain = process.env.RWS_DOMAIN;
const password = process.env.OWNER_PW;
if (!domain || !password || !process.env.OWNER_CA) throw new Error('RWS_DOMAIN, OWNER_PW and OWNER_CA are required');
const ca = readFileSync(process.env.OWNER_CA);
const host = `owner.${domain}`;
const CANARY = /777777\.(777|75)/;

function get(path, auth) {
  return new Promise((resolve, reject) => {
    const headers = { host };
    if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    const req = request(
      { host: 'caddy-owner', port: 8443, path, method: 'GET', servername: host, ca, headers },
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
// P10b: the document also holds the contact, the operator and the CDN: compare the audience and the four keys, never
// the whole body (the operator's name is personal data, so nothing of it is printed).
const config = await get('/runtime-config.json', auth);
let doc = null;
try {
  doc = JSON.parse(config.body);
} catch {}
check(
  config.status === 200 &&
    doc?.audience === 'owner' &&
    Object.keys(doc).sort().join() === 'audience,cdn,contact,operator',
  '/runtime-config.json with credentials has audience "owner" and exactly the keys audience, contact, operator and cdn',
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

// P11a (issue #26 C5): the owner variant of the reaches file. run.sh installs the fixture release before the stack
// starts; the owner publisher splits it at the BE-3 gauges and writes reaches-<ver>.json into the owner tree, which
// caddy-owner serves in preference to the public file of the same name (owner.caddy). The public bytes are run.sh's
// check (cmp against the installed file, no be.spw. in it or in stations.json). The owner publisher writes it in its
// first cycle; the loop only absorbs the order of that cycle's steps.
const manifest = await get('/data/v1/rivers/manifest.json', auth);
let version = '';
try {
  version = JSON.parse(manifest.body).current.version;
} catch {}
check(
  manifest.status === 200 && /^[0-9]{8}$/.test(version),
  '/data/v1/rivers/manifest.json with credentials names a release',
);
const reachesPath = `/data/v1/rivers/reaches-${version}.json`;
let variant = await get(reachesPath, auth);
for (let i = 0; i < 30 && version !== '' && !variant.body.includes('"be.spw.'); i++) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  variant = await get(reachesPath, auth);
}
let file = null;
try {
  file = JSON.parse(variant.body);
} catch {}
const spw = (file?.stations ?? []).map((s) => s.id).filter((id) => id.startsWith('be.spw.'));
check(
  variant.status === 200 && file?.version === version,
  `${reachesPath} with credentials is the release's reaches file`,
);
check(ownerHeaders(variant), `${reachesPath} with credentials: both owner headers (private, no-store)`);
check(
  ['be.spw.5447', 'be.spw.5451', 'be.spw.8702'].every((id) => spw.includes(id)),
  `${reachesPath} is the owner variant: it places the SPW gauges be.spw.5447, 5451 and 8702 (${spw.length} be.spw. stations)`,
);
check(
  (file?.stations ?? []).some((s) => s.id === 'nl.rws.eijsden.grens'),
  `${reachesPath} keeps the public stations (nl.rws.eijsden.grens)`,
);
check(!CANARY.test(variant.body), `${reachesPath} holds no owner canary value`);

if (failures.length > 0) {
  console.error(`owner-check: ${failures.length} failed`);
  process.exit(1);
}
