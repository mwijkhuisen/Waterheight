// CI only (P12a, issue #27): the fake upstream of the loadtest, drill and chaos stacks. Never part of a deployment.
// Plain Node (no dependency), run as `/nodejs/bin/node /fake/server.mjs` in the distroless server image (uid 65532,
// read-only root). It answers three things on TLS :443:
//   1. a narrow set of provider specs, replayed from the repository's recorded payloads: /fake/routes.json maps
//      host + path (+ exact query or query prefix) to a status, headers and a body file under /fake/bodies
//      (written by prepare.ts, never by hand);
//   2. a fake healthchecks.io: hc-ping.com /<key>/<check>, /<key>/<check>/start|fail|log -> 200 "OK";
//   3. a per-host blackhole: a host named in /control/blackhole (one hostname per line, read on every request)
//      gets its connection accepted and never answered; the client gives up on its own timeout.
// Every request is appended to /state/hits.jsonl as {"t","host","method","path","status"} (status 0: blackholed;
// the query string and all headers and bodies are never logged; the ping key is a CI throw-away). Anything else
// is a 404. Malformed requests are dropped without a crash.
//
// Environment (all optional): FAKE_DIR /fake, FAKE_STATE /state, FAKE_CONTROL /control, FAKE_PORT 443 (0 = any,
// printed on stdout), FAKE_PLAIN=1 serves plain HTTP: ONLY for test/fake-upstream.test.ts, which has no certificate.
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { basename, join } from 'node:path';

const dir = process.env.FAKE_DIR ?? '/fake';
const stateDir = process.env.FAKE_STATE ?? '/state';
const controlDir = process.env.FAKE_CONTROL ?? '/control';
const port = Number(process.env.FAKE_PORT ?? 443);
const plain = process.env.FAKE_PLAIN === '1';

const HC_HOST = 'hc-ping.com';
const HC_PATH = /^\/[\w-]{1,64}\/[\w-]{1,64}(\/(start|fail|log))?$/;

const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8')).map((r) => ({
  host: String(r.host).toLowerCase(),
  path: String(r.path),
  ...(typeof r.query === 'string' ? { query: r.query } : {}),
  ...(typeof r.query_prefix === 'string' ? { query_prefix: r.query_prefix } : {}),
  status: Number(r.status),
  headers: r.headers ?? {},
  body: readFileSync(join(dir, 'bodies', basename(String(r.body)))),
}));

/** The hosts to blackhole right now; an absent or unreadable file is none. */
function blackholed() {
  try {
    return new Set(
      readFileSync(join(controlDir, 'blackhole'), 'utf8')
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l !== '' && !l.startsWith('#')),
    );
  } catch {
    return new Set();
  }
}

function hit(host, method, path, status) {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), host, method, path, status });
    appendFileSync(join(stateDir, 'hits.jsonl'), `${line}\n`);
  } catch {
    // The state directory is not writable: serving goes on, the checks that read the hits will say so.
  }
}

function handle(req, res) {
  const host = String(req.headers.host ?? '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  const method = String(req.method ?? '');
  const raw = String(req.url ?? '');
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? '' : raw.slice(q + 1);
  req.resume();

  // The container healthcheck (loopback only): not a hit, never blackholed.
  if (path === '/_health' && (host === '127.0.0.1' || host === 'localhost')) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (blackholed().has(host)) {
    hit(host, method, path, 0);
    return;
  }
  let status = 404;
  let headers = { 'content-type': 'text/plain' };
  let body = Buffer.from('not found');
  if (host === HC_HOST && HC_PATH.test(path)) {
    status = 200;
    body = Buffer.from('OK');
  } else if (method === 'GET' || method === 'HEAD') {
    const r = routes.find(
      (x) =>
        x.host === host &&
        x.path === path &&
        (x.query !== undefined ? x.query === query : x.query_prefix === undefined || query.startsWith(x.query_prefix)),
    );
    if (r !== undefined) ({ status, headers, body } = r);
  }
  hit(host, method, path, status);
  res.writeHead(status, { ...headers, 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : body);
}

const onRequest = (req, res) => {
  try {
    handle(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
};
const server = plain
  ? createHttp(onRequest)
  : createHttps(
      {
        key: readFileSync(join(dir, 'server.key')),
        cert: readFileSync(join(dir, 'server.crt')),
        minVersion: 'TLSv1.2',
      },
      onRequest,
    );
server.on('clientError', (_err, socket) => socket.destroy());
process.on('uncaughtException', (err) => console.error('fake-upstream: uncaught', err?.code ?? err?.name));
process.on('SIGTERM', () => process.exit(0));
server.listen(port, plain ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(`fake-upstream listening on ${server.address().port}`);
});
