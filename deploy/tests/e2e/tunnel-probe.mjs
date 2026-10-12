// CI only (#109): run by deploy/tests/e2e/tunnel.sh inside the cloudflared stand-in (compose.tunnel-ci.yaml), so every
// request leaves from cloudflared's own address on its own networks. Plain Node, no dependency; read from stdin
// (`node --input-type=module -`). Environment: PROBE_DOMAIN; PROBE_CLOSED, PROBE_DROPPED and PROBE_REFUSED, each a
// space-separated list of host:port (closed: anything but a completed connection; dropped: no answer at all, the
// firewall; refused: a reset, so the firewall let it out). Prints one line per check and exits 1 on the first miss.
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const domain = process.env.PROBE_DOMAIN ?? '';
const list = (name) => (process.env[name] ?? '').split(' ').filter((s) => s !== '');
const agent = new http.Agent({ keepAlive: true, maxSockets: 30 });

function check(ok, text) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) process.exit(1);
}

/** GET http://caddy:80<path> with the given Host and extra headers: { status, headers }. */
function get(path, headers = {}, host = domain) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: 'caddy', port: 80, path, method: 'GET', agent, headers: { host, ...headers }, timeout: 10_000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {} }));
    req.end();
  });
}

/** A TCP connection attempt: open, refused, timeout (dropped) or unreachable. */
function connect(target, ms = 4000) {
  const at = target.lastIndexOf(':');
  return new Promise((resolve) => {
    const s = net.connect({ host: target.slice(0, at), port: Number(target.slice(at + 1)) });
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(ms, () => done('timeout'));
    s.on('connect', () => done('open'));
    s.on('error', (e) =>
      done(e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ETIMEDOUT' ? 'timeout' : `unreachable (${e.code})`),
    );
  });
}

// The token: a file secret of the real service definition, readable through the group, never in the environment.
const st = statSync('/run/secrets/cf_tunnel_token');
check(
  (st.mode & 0o777) === 0o440 &&
    st.uid === 0 &&
    st.gid === 61011 &&
    readFileSync('/run/secrets/cf_tunnel_token').length > 0,
  'the token is /run/secrets/cf_tunnel_token, root:61011 0440, readable by the service (gid 61011 added)',
);
check(
  !Object.keys(process.env).some((k) => k === 'TUNNEL_TOKEN' || k.startsWith('TUNNEL_')),
  'no TUNNEL_* variable in the environment',
);

// The site over plain HTTP, the way cloudflared asks it (ingress http://caddy:80, the public Host).
const health = await get('/healthz');
check(health.status === 200, `http://caddy:80/healthz with Host ${domain}: ${health.status}`);
const page = await get('/');
check(
  page.status === 200 &&
    page.headers['strict-transport-security'] === 'max-age=31536000; includeSubDomains' &&
    typeof page.headers['content-security-policy'] === 'string' &&
    page.headers.server === undefined,
  `/ over plain HTTP: ${page.status}, HSTS and the CSP sent for Cloudflare to pass on, no Server`,
);
// Review S6: a plain-HTTP visit Cloudflare forwards (it sets X-Forwarded-Proto) is sent to https, never served.
const plain = await get('/over?x=1', { 'x-forwarded-proto': 'http' });
check(
  plain.status === 308 && plain.headers.location === `https://${domain}/over?x=1`,
  `X-Forwarded-Proto: http: ${plain.status} to ${plain.headers.location} (expected 308 to https)`,
);
const owner = await get('/', {}, `owner.${domain}`);
check(owner.status === 421, `Host owner.${domain}: ${owner.status} from the catch-all (expected 421)`);

// The limiter key: Cloudflare appends the visitor to X-Forwarded-For. A burst whose spoofed prefixes, CF-Connecting-IP
// and X-Real-IP all vary but whose right-most address is one visitor meets 429s (one key, not 300 fresh ones; and not
// cloudflared's own address, which would be the gateway key with 100 times the buckets). A burst right after whose
// right-most address is another visitor (the first one now only a spoofed prefix) starts with a full bucket.
async function burst(xff) {
  const codes = await Promise.all(
    Array.from({ length: 300 }, (_, i) =>
      get('/api/v1/meta', {
        'x-forwarded-for': xff(i),
        'cf-connecting-ip': `192.0.2.${i % 250}`,
        'x-real-ip': `10.9.${i % 250}.1`,
        'x-rws-client': `203.0.113.${i % 250}`,
      }).then((r) => r.status),
    ),
  );
  return { ok: codes.filter((c) => c === 200).length, limited: codes.filter((c) => c === 429).length, codes };
}
const a = await burst((i) => `10.${i % 250}.${(i * 7) % 250}.1, 198.51.100.7`);
check(
  a.limited >= 1 && a.ok + a.limited === 300,
  `300 GETs of /api/v1/meta, varying spoofed prefixes, right-most 198.51.100.7: ${a.ok} x 200, ${a.limited} x 429`,
);
const b = await burst(() => '198.51.100.7, 198.51.100.8');
check(
  b.ok >= 100,
  `then 300 with right-most 198.51.100.8 (198.51.100.7 as a spoofed prefix): ${b.ok} x 200, ${b.limited} x 429 (a fresh key)`,
);
// One marked request for tunnel.sh's log check: the masked client_ip must be 198.51.100.0, the peer 172.30.41.0.
await get('/tunnel-probe-xff', { 'x-forwarded-for': '6.6.6.6, 198.51.100.9' });

// Nothing but caddy:80 and Cloudflare: the internal services, the host and the outside.
for (const t of list('PROBE_CLOSED')) {
  const r = await connect(t);
  check(r !== 'open', `${t}: ${r} (must not connect)`);
}
for (const t of list('PROBE_DROPPED')) {
  const r = await connect(t);
  check(r === 'timeout', `${t}: ${r} (the firewall drops it)`);
}
for (const t of list('PROBE_REFUSED')) {
  const r = await connect(t);
  check(r === 'refused', `${t}: ${r} (the firewall lets it out; nothing listens)`);
}
agent.destroy();
