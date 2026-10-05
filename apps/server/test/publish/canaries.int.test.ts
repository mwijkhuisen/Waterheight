import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANARIES } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelAudience } from '../../src/db/audience.ts';
import { publishTail } from '../../src/load/migrate.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { type Harness, harness } from '../load/harness.ts';
import { contract, walk } from './tree.ts';

// P9a (plan §4.10, "the file canaries"): both publishers on a seeded database, every file of both trees walked
// (siblings decompressed and byte-equal), parsed with its family's contract, and searched for what must never be
// there: the withheld canary anywhere, owner data in a public file, a series without display, and (§9 C5) a series
// without history_export outside latest.json and anything older than its window.

const NOW = Date.parse('2026-10-04T12:00:00Z');
const BASE = Date.parse('2026-10-01T00:00:00Z');
const MARK = { nodisplay: '424242.5', ownerOnly: '313131.5', histOld: '555555.5', histNew: '666666.5' } as const;
let h: Harness;
const ids = {} as Record<'a' | 'b' | 'withheld' | 'nodisplay' | 'ownerOnly' | 'hist', number>;
const dirs: string[] = [];

type Tree = { files: Map<string, string> };
const trees = {} as Record<ChannelAudience, Tree>;

const q = (text: string, values: unknown[] = []) => h.t.admin.query(text, values);
const iso = (ms: number) => new Date(ms).toISOString();

async function mkSeries(
  station: string,
  key: string,
  over: { audience?: string; override?: object } = {},
): Promise<number> {
  await q("INSERT INTO station (id, name, country, tier) VALUES ($1, $2, 'NL', 2)", [station, `name of ${station}`]);
  const r = await q(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role, audience, lic_override)
     VALUES ($1, 'NL-1', 'H', 'stage', $2, 'cm', 1, 'LOCAL', '10 min', '10 min', '45 min', 'primary', $3::audience, $4)
     RETURNING id`,
    [station, key, over.audience ?? null, over.override === undefined ? null : JSON.stringify(over.override)],
  );
  return r.rows[0].id;
}
/** Observations every 10 min from `from` to `to` (ms), value `value(k)`. */
const obs = (series: number, from: number, to: number, value: string) =>
  q(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT $1, to_timestamp(k / 1000.0), ${value}, 0, 0
     FROM generate_series($2::bigint, $3::bigint, 600000) k`,
    [series, from, to],
  );

/** The series ids a parsed file names. */
function idsIn(rel: string, body: Record<string, unknown>): number[] {
  if (rel === 'stations.json')
    return (body.stations as { series: { id: number }[] }[]).flatMap((s) => s.series.map((x) => x.id));
  if (rel.startsWith('series/')) return (body.series as { id: number }[]).map((x) => x.id);
  if (Array.isArray(body.series)) return (body.series as unknown[]).filter((x): x is number => typeof x === 'number');
  return [];
}

beforeAll(async () => {
  h = await harness();
  await q(`UPDATE app_meta SET value = '"2026-10-01T00:00:00Z"' WHERE key = 'display_start'`);
  await q(`SELECT ensure_partitions('2026-09-28'::timestamptz, '2026-10-06'::timestamptz)`);
  // Two real NL-1 stage series (their NL-4 bands classify them, so the files hold bases).
  const real = await q(
    `SELECT s.id FROM series s WHERE s.source_id = 'NL-1' AND s.active AND s.role = 'primary' AND s.quantity = 'H'
       AND NOT EXISTS (SELECT 1 FROM series o WHERE o.station_id = s.station_id AND o.id <> s.id)
     ORDER BY s.id LIMIT 2`,
  );
  ids.a = real.rows[0].id;
  ids.b = real.rows[1].id;
  ids.withheld = await mkSeries('nl.canary.withheld', 'canary-withheld', { audience: 'off' });
  ids.nodisplay = await mkSeries('nl.p9a.nodisplay', 'p9a-nodisplay', { override: { display: false } });
  ids.ownerOnly = await mkSeries('nl.p9a.owneronly', 'p9a-owneronly', { audience: 'owner' });
  ids.hist = await mkSeries('nl.p9a.hist', 'p9a-hist', { override: { history_export: false } });
  await q("UPDATE source SET history_window = '24 hours' WHERE id = 'NL-1'");
  for (const s of [ids.a, ids.b]) await obs(s, BASE, NOW, `100 + (k - ${BASE}) / 600000 * 0.5`);
  await obs(ids.withheld, NOW - 3_600_000, NOW, String(CANARIES.withheld.value));
  await obs(ids.nodisplay, BASE, NOW, MARK.nodisplay);
  await obs(ids.ownerOnly, BASE, NOW, MARK.ownerOnly);
  await obs(ids.hist, NOW - 3 * 86_400_000, NOW - 3 * 86_400_000 + 3_600_000, MARK.histOld);
  await obs(ids.hist, NOW - 4 * 3_600_000, NOW, MARK.histNew);
  // The withheld series also has a reference and a forecast run: its value in every table that can leak.
  await q(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, valid)
     VALUES ($1, 'NL-1', 'MHW', ${CANARIES.withheld.value}, 'cm', 'statistical', tstzrange('2020-01-01', NULL))`,
    [ids.withheld],
  );
  const run = await q(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
     VALUES ($1, 'NL-1', $2, $2, $3, $2, decode(md5('p9a-withheld'), 'hex'), 'deterministic') RETURNING id`,
    [ids.withheld, iso(NOW - 3_600_000), iso(NOW + 86_400_000)],
  );
  await q(
    `INSERT INTO forecast_value (run_id, valid_ts, value)
     SELECT $1, $2::timestamptz + h * interval '1 hour', ${CANARIES.withheld.value} FROM generate_series(0, 20) h`,
    [run.rows[0].id, iso(NOW - 3_600_000)],
  );
  // A visible forecast too, so forecast/latest.json is not empty in the public tree.
  const ok = await q(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
     VALUES ($1, 'NL-1', $2, $2, $3, $2, decode(md5('p9a-a'), 'hex'), 'deterministic') RETURNING id`,
    [ids.a, iso(NOW - 3_600_000), iso(NOW + 86_400_000)],
  );
  await q(
    `INSERT INTO forecast_value (run_id, valid_ts, value)
     SELECT $1, $2::timestamptz + h * interval '1 hour', 150 + h FROM generate_series(0, 20) h`,
    [ok.rows[0].id, iso(NOW - 3_600_000)],
  );
  await publishTail(h.dbAs('rws_migrator', 1).db, new Date(NOW));
  for (const [family, role] of [
    ['public', 'rws_publish'],
    ['owner', 'rws_owner_api'],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), `rws-canary-${family}-`));
    dirs.push(dir);
    await publishOnce(h.dbAs(role, 3).db, family, dir, { now: NOW, render: RENDERERS });
    trees[family] = { files: walk(dir) };
  }
}, 300_000);
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.close();
});

const all = (family: ChannelAudience) => [...trees[family].files];
const parsed = (family: ChannelAudience) =>
  all(family).map(([rel, text]) => [rel, JSON.parse(text) as Record<string, unknown>] as const);

describe('the files of both publishers', { timeout: 300_000 }, () => {
  for (const family of ['public', 'owner'] as const) {
    it(`${family}: every file parses with its family's contract, and the tree is not trivially small`, () => {
      expect(trees[family].files.size).toBeGreaterThan(300);
      for (const [rel, text] of all(family))
        expect(() => contract(family, rel).parse(JSON.parse(text)), rel).not.toThrow();
    });

    it(`${family}: the withheld canary, its station and its series are in no file`, () => {
      for (const [rel, text] of all(family)) {
        for (const s of [CANARIES.withheld.text, CANARIES.withheld.real, 'nl.canary.withheld', 'canary-withheld'])
          expect(text, `${rel} has ${s}`).not.toContain(s);
      }
      for (const [rel, body] of parsed(family)) expect(idsIn(rel, body), rel).not.toContain(ids.withheld);
    });

    it(`${family}: no series without effective lic_display is in any file`, () => {
      for (const [rel, text] of all(family)) {
        for (const s of [MARK.nodisplay, 'nl.p9a.nodisplay']) expect(text, `${rel} has ${s}`).not.toContain(s);
      }
      for (const [rel, body] of parsed(family)) expect(idsIn(rel, body), rel).not.toContain(ids.nodisplay);
    });

    it(`${family}: a series without history_export is in latest.json and stations.json only; nothing older than its window anywhere`, () => {
      for (const [rel, text] of all(family)) {
        expect(text, `${rel} has the value older than the window`).not.toContain(MARK.histOld);
        if (rel !== 'latest.json') expect(text, `${rel} has a history value`).not.toContain(MARK.histNew);
      }
      for (const [rel, body] of parsed(family))
        if (rel !== 'latest.json' && rel !== 'stations.json') expect(idsIn(rel, body), rel).not.toContain(ids.hist);
      // stations.json is metadata: it lists the series while the window (1 day) exceeds its staleness + 1 h.
      expect(idsIn('stations.json', JSON.parse(trees[family].files.get('stations.json') as string))).toContain(
        ids.hist,
      );
      // latest.json carries it only inside its window, and the value of that window is never the old one.
      const latest = JSON.parse(trees[family].files.get('latest.json') as string) as {
        series: number[];
        value: number[];
      };
      const at = latest.series.indexOf(ids.hist);
      if (at >= 0) expect(latest.value[at]).toBe(Number(MARK.histNew));
    });
  }

  it('public: no owner datum in any file (canary value, station, source, attribution, private basis, owner-only series)', async () => {
    const owner = await q("SELECT id, private_basis->>'clause' AS clause FROM source WHERE audience = 'owner'");
    const ownerTexts = await q(
      `SELECT a.text FROM attribution a JOIN source s ON s.id = a.source_id WHERE s.audience = 'owner'
         AND a.text NOT IN (SELECT a2.text FROM attribution a2 JOIN source s2 ON s2.id = a2.source_id WHERE s2.audience = 'public')`,
    );
    expect(owner.rows.length).toBeGreaterThan(3);
    expect(ownerTexts.rows.map((r) => r.text)).toContain('Owner canary: synthetic test data');
    const never = [
      CANARIES.owner.text,
      CANARIES.owner.real,
      'nl.canary.owner',
      'CANARY-OWNER',
      'owner-canary',
      MARK.ownerOnly,
      'nl.p9a.owneronly',
      ...owner.rows.map((r) => r.clause as string),
      ...ownerTexts.rows.map((r) => r.text as string),
    ];
    for (const [rel, text] of all('public')) for (const s of never) expect(text, `${rel} has ${s}`).not.toContain(s);
    for (const [rel, body] of parsed('public')) {
      expect(idsIn(rel, body), rel).not.toContain(ids.ownerOnly);
    }
  });

  it('owner: the canary value, station, source, attribution text and private basis are in the owner files', async () => {
    const files = trees.owner.files;
    const text = (rel: string) => files.get(rel) as string;
    const clause = (await q("SELECT private_basis->>'clause' AS c FROM source WHERE id = 'CANARY-OWNER'")).rows[0]
      .c as string;
    expect(text('latest.json')).toContain(CANARIES.owner.real);
    expect(text('latest.json')).toContain(MARK.ownerOnly);
    expect(text('forecast/latest.json')).toContain(CANARIES.owner.real);
    expect(text('series/nl.canary.owner/recent.json')).toContain(CANARIES.owner.real);
    expect(text('stations.json')).toContain('nl.canary.owner');
    expect(text('stations.json')).toContain('nl.p9a.owneronly');
    expect(text('sources.json')).toContain('CANARY-OWNER');
    expect(text('sources.json')).toContain('Owner canary: synthetic test data');
    // The private basis is in sources.json, escaped as JSON would.
    expect(
      JSON.parse(text('sources.json')).sources.find((s: { id: string }) => s.id === 'CANARY-OWNER').privateBasis.clause,
    ).toBe(clause);
    const recent = [...files.keys()].filter((r) => r.startsWith('recent/') && r.endsWith('.json'));
    expect(recent.length).toBeGreaterThan(100);
    for (const rel of recent.slice(0, 10)) expect(text(rel), rel).toContain(CANARIES.owner.real);
    expect([...files.keys()].some((r) => r.startsWith('settled/') || r.startsWith('frames/'))).toBe(false);
  });
});
