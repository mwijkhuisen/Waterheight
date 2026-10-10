import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { args, HOST, MAX_REQUESTS, run, USER_AGENT } from '../scripts/record-frames.ts';
import { synthesize } from '../scripts/synthesize-frames.ts';
import { server } from './msw.setup.ts';

// scripts/record-frames.ts (P11b, D-3): refused under CI, one fixed host, a request cap, the public contracts as the
// gate, provenance beside every file. msw answers with the synthetic flood scene; nothing reaches the network.

const src = mkdtempSync(join(tmpdir(), 'rec-src-'));
synthesize(src, 11);
const body = (name: string) => readFileSync(join(src, 'flood', name));
const out = () => mkdtempSync(join(tmpdir(), 'rec-out-'));
const seen: { url: string; ua: string | null }[] = [];

function serve(over: Record<string, () => Response> = {}) {
  const answer = (path: string, file: string) =>
    http.get(`${HOST}${path}`, ({ request }) => {
      seen.push({ url: request.url, ua: request.headers.get('user-agent') });
      return (
        over[path] ?? (() => new HttpResponse(body(file), { headers: { 'content-type': 'application/json' } }))
      )();
    });
  server.use(
    answer('/data/v1/meta.json', 'meta.json'),
    answer('/data/v1/stations.json', 'stations.json'),
    answer('/data/v1/frames/2026-10-10/v1.json', 'frames-2026-10-10-v1.synthetic.json'),
    answer('/data/v1/frames/2026-10-11/v1.json', 'frames-2026-10-11-v1.synthetic.json'),
  );
}

describe('record-frames', () => {
  it('is refused under CI, before any request', async () => {
    const lines: string[] = [];
    expect(await run(['--out', out(), '--days', '2026-10-10'], { CI: 'true' }, (l) => lines.push(l))).toBe(2);
    expect(seen.length).toBe(0);
  });

  it('refuses bad arguments and more days than the request cap allows, without a request', async () => {
    const many = Array.from({ length: MAX_REQUESTS - 1 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`).join(
      ',',
    );
    for (const argv of [
      [],
      ['--out', out()],
      ['--out', out(), '--days', '2026-8-1'],
      ['--out', out(), '--days', many],
      ['--out', out(), '--days', '2026-10-10', '--host', 'x'],
    ])
      expect(await run(argv, {}, () => {})).toBe(64);
    expect(args(['--days', '2026-10-11,2026-10-10,2026-10-10']).days).toEqual(['2026-10-10', '2026-10-11']);
  });

  it('records meta, stations and the day files, verbatim, with provenance, the UA and a report', async () => {
    serve();
    seen.length = 0;
    const dir = out();
    const lines: string[] = [];
    const code = await run(['--out', dir, '--days', '2026-10-11,2026-10-10', '--report', '1000'], {}, (l) =>
      lines.push(l),
    );
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'frames-2026-10-10-v1.json'))).toEqual(body('frames-2026-10-10-v1.synthetic.json'));
    const m = JSON.parse(readFileSync(join(dir, 'frames-2026-10-10-v1.meta.json'), 'utf8'));
    expect(Object.keys(m).sort()).toEqual(['fetched_at', 'from', 'sha256', 'url']);
    expect([m.from, m.url]).toEqual(['recording', `${HOST}/data/v1/frames/2026-10-10/v1.json`]);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const f of ['meta.json', 'meta.meta.json', 'stations.json', 'stations.meta.json'])
      expect(existsSync(join(dir, f))).toBe(true);
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/data/v1/meta.json',
      '/data/v1/stations.json',
      '/data/v1/frames/2026-10-10/v1.json',
      '/data/v1/frames/2026-10-11/v1.json',
    ]);
    expect(new Set(seen.map((s) => s.ua))).toEqual(new Set([USER_AGENT]));
    expect(USER_AGENT).not.toContain('@maikel');
    expect(USER_AGENT).toBe('Waterheight-fixture-recorder/1 (+https://github.com/mwijkhuisen/Waterheight)');
    expect(lines.filter((l) => /series 1000 mean/.test(l))).toHaveLength(2);
    expect(lines.at(-1)).toBe(`requests: 4/${MAX_REQUESTS}`);
  });

  it('skips an unsettled day and a version-0 day without asking for them', async () => {
    const meta = JSON.parse(body('meta.json').toString());
    meta.dayVersions = { '2026-10-10': 0 };
    serve({ '/data/v1/meta.json': () => HttpResponse.json(meta) });
    seen.length = 0;
    const lines: string[] = [];
    expect(await run(['--out', out(), '--days', '2026-10-10,2026-12-31'], {}, (l) => lines.push(l))).toBe(0);
    expect(seen).toHaveLength(2);
    expect(lines.filter((l) => l.includes('skipped'))).toHaveLength(2);
  });

  it('reads the version from meta.json', async () => {
    const meta = JSON.parse(body('meta.json').toString());
    meta.dayVersions = { '2026-10-10': 2 };
    server.use(
      http.get(`${HOST}/data/v1/meta.json`, () => HttpResponse.json(meta)),
      http.get(`${HOST}/data/v1/stations.json`, () => new HttpResponse(body('stations.json'))),
      http.get(
        `${HOST}/data/v1/frames/2026-10-10/v2.json`,
        () => new HttpResponse(body('frames-2026-10-10-v1.synthetic.json')),
      ),
    );
    const dir = out();
    expect(await run(['--out', dir, '--days', '2026-10-10'], {}, () => {})).toBe(0);
    expect(existsSync(join(dir, 'frames-2026-10-10-v2.json'))).toBe(true);
  });

  it('refuses a redirect to another host and does not write the file', async () => {
    server.use(
      http.get(
        `${HOST}/data/v1/meta.json`,
        () => new HttpResponse(null, { status: 302, headers: { location: 'https://example.org/meta.json' } }),
      ),
    );
    const dir = out();
    const lines: string[] = [];
    expect(await run(['--out', dir, '--days', '2026-10-10'], {}, (l) => lines.push(l))).toBe(1);
    expect(lines).toContain('failed: redirect_off_host');
    expect(existsSync(join(dir, 'meta.json'))).toBe(false);
  });

  it('counts every redirect hop and stops after three', async () => {
    server.use(
      http.get(
        `${HOST}/data/v1/meta.json`,
        () => new HttpResponse(null, { status: 302, headers: { location: '/data/v1/meta.json' } }),
      ),
    );
    const lines: string[] = [];
    expect(await run(['--out', out(), '--days', '2026-10-10'], {}, (l) => lines.push(l))).toBe(1);
    expect(lines).toContain('failed: too_many_redirects');
    expect(lines.at(-1)).toBe(`requests: 4/${MAX_REQUESTS}`);
  });

  it('accepts a day file of either schema (v2 as synthesised, v1 without state) and refuses a v2 without state', async () => {
    const v2 = JSON.parse(body('frames-2026-10-10-v1.synthetic.json').toString());
    expect(v2.schemaVersion).toBe(2);
    const v1 = { ...v2, schemaVersion: 1, state: undefined };
    for (const [file, ok] of [
      [v2, true],
      [v1, true],
      [{ ...v2, state: undefined }, false],
    ] as const) {
      serve({ '/data/v1/frames/2026-10-10/v1.json': () => HttpResponse.json(file) });
      const dir = out();
      expect(await run(['--out', dir, '--days', '2026-10-10'], {}, () => {})).toBe(ok ? 0 : 1);
      expect(existsSync(join(dir, 'frames-2026-10-10-v1.json'))).toBe(ok);
    }
  });

  it('writes nothing for a body that fails the public contract', async () => {
    const bad = JSON.parse(body('frames-2026-10-10-v1.synthetic.json').toString());
    bad.vlast.pop();
    serve({ '/data/v1/frames/2026-10-10/v1.json': () => HttpResponse.json(bad) });
    const dir = out();
    const lines: string[] = [];
    expect(await run(['--out', dir, '--days', '2026-10-10'], {}, (l) => lines.push(l))).toBe(1);
    expect(existsSync(join(dir, 'frames-2026-10-10-v1.json'))).toBe(false);
    expect(lines.some((l) => l.startsWith('failed: '))).toBe(true);
  });
});
