import { FORECAST_SOURCES } from '@rws/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { FAMILY_ROLES, FORECAST_AT } from '../../src/db/audience.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { parseReplayArgs, type ReplayArgs, replay } from '../../src/load/replay.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// Issue #79 (KG-261): DE-3's lead allowance (`leadMs`, 4 days) through the real loader, on the synthetic fixtures of
// apps/server/src/adapters/de-3 (every value invented), their rows moved so that the first lies 3 days and some
// hours before the fetch. A new load keeps every row; and a run stored under the old 2-day bound (its leading rows
// cut) is not repaired by a replay: DE-3 does not drop heads (`headDrops: false`), so the full run is a second run.

const NOW = new Date('2026-10-05T00:00:00Z');
const DAY = 86_400_000;
const EMMERICH = '14-Tage-Vorhersage/Emmerich_Quantile_2790020.csv';
const EMMERICH_KEY = '9598e4cb-0849-401e-bba0-689234b27644/W';
const KAUB = '14-Tage-Vorhersage/Kaub_Quantile_25700100.csv';
const KAUB_KEY = '1d26e504-7f9e-480a-b52c-5932be6549ab/W';

let h: Harness;
const clients: pg.Client[] = [];
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.end()));
  await h.close();
});

type Row = Record<string, unknown>;
const q = async (text: string, args: unknown[] = []): Promise<Row[]> => (await h.t.admin.query(text, args)).rows;
const pad = (n: number) => String(n).padStart(2, '0');
/** A committed synthetic file with its rows on the days from `first` (a CET midnight, `yyyy-mm-dd`). */
const file = (name: string, first: string): Buffer => {
  const t0 = Date.parse(`${first}T00:00:00Z`);
  let i = 0;
  const lines = rawFixture('DE-3', name)
    .body.toString('latin1')
    .split('\n')
    .map((l) => {
      if (!/^\d{2}\.\d{2}\.\d{4} /.test(l)) return l;
      const d = new Date(t0 + i++ * DAY);
      const [, ...cells] = l.split(';');
      return [`${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} 00:00`, ...cells].join(';');
    });
  return Buffer.from(lines.join('\n'), 'latin1');
};
const put = (variant: string, at: string, body: Buffer) =>
  writePayload(h.archive, {
    source: 'DE-3',
    spec: 'de-3-files',
    variant,
    at: new Date(at),
    url: `https://example.invalid/${variant}`,
    body,
    retention: 'forever',
  });
const tick = () => h.loader({ now: NOW }).tick();
const runsOf = (key: string) =>
  q(
    `SELECT r.id::text AS id, r.first_valid, r.fetched_at,
            (SELECT count(*)::int FROM forecast_value v WHERE v.run_id = r.id) AS n
     FROM forecast_run r JOIN series s ON s.id = r.series_id
     WHERE s.provider_key = $1 AND s.source_id = 'DE-1' AND r.source_id = 'DE-3' ORDER BY r.id`,
    [key],
  );
const deps = () => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => NOW,
  adapters: LOAD_ADAPTERS,
});
const beforeWindow = () => h.alerts.filter((a) => a.code === 'before_window');

describe('DE-3 lead allowance (issue #79)', { timeout: 300_000 }, () => {
  it('a file whose first row lies 3 days before the fetch loads whole: no before_window', async () => {
    // Rows from 2026-09-30 CET (2026-09-29T23:00Z), fetched 2026-10-03T10:15Z: the first row 3 days 11 h 15 min before.
    await put(KAUB, '2026-10-03T10:15:00Z', file('de-3-files-kaub.synthetic', '2026-09-30'));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect((await runsOf(KAUB_KEY)).map((r) => [r.first_valid, r.n])).toEqual([[new Date('2026-09-29T23:00:00Z'), 14]]);
    expect(beforeWindow()).toEqual([]);
  });

  it('a run cut under the old 2-day bound: the first replay adds the full run next to it, the second writes nothing', async () => {
    // Rows from 2026-10-01 CET (2026-09-30T23:00Z), fetched 2026-10-04T10:15Z: the first two rows lie more than two
    // days before the fetch. Loaded as the release before #79 did (no leadMs: MAX_LEAD_MS for every source).
    await put(EMMERICH, '2026-10-04T10:15:00Z', file('de-3-files-emmerich.synthetic', '2026-10-01'));
    const de3 = FORECAST_SOURCES['DE-3'] as { leadMs?: number };
    const leadMs = de3.leadMs as number;
    delete de3.leadMs;
    try {
      expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    } finally {
      de3.leadMs = leadMs;
    }
    expect(beforeWindow()).toEqual([{ code: 'before_window', fields: expect.objectContaining({ n: 2 }) }]);
    const [cut] = await runsOf(EMMERICH_KEY);
    expect([cut?.first_valid, cut?.n]).toEqual([new Date('2026-10-02T23:00:00Z'), 12]);

    // The replay after the release: the same archive line, now whole. Its first valid time and hash differ from the
    // cut run's, and DE-3 does not drop heads, so mergeDecision inserts: a second run, the cut one stays.
    const args = parseReplayArgs(['--source', 'DE-3', '--from', '2026-10-04', '--to', '2026-10-04']) as ReplayArgs;
    expect(await replay(deps(), args)).toMatchObject({ lines: 1, loaded: 1, quarantined: 0, n_new: 14, n_changed: 0 });
    expect(beforeWindow()).toHaveLength(1);
    const runs = await runsOf(EMMERICH_KEY);
    expect(runs.map((r) => [r.first_valid, r.fetched_at, r.n])).toEqual([
      [new Date('2026-10-02T23:00:00Z'), new Date('2026-10-04T10:15:00Z'), 12],
      [new Date('2026-09-30T23:00:00Z'), new Date('2026-10-04T10:15:00Z'), 14],
    ]);
    expect(await replay(deps(), args)).toMatchObject({ lines: 1, loaded: 1, quarantined: 0, n_new: 0, n_changed: 0 });
    expect(await runsOf(EMMERICH_KEY)).toHaveLength(2);

    // Q2 (the latest run known as of): both runs have the same issue (inferred) and fetch time, so the tie goes to the
    // greater id: the full run the replay inserted.
    const owner = await h.t.connectAs(FAMILY_ROLES.owner[0]);
    clients.push(owner);
    const emmerich = await h.seriesId(EMMERICH_KEY);
    const at = await owner.query(
      `SELECT run_id::text AS run_id FROM ${FORECAST_AT.owner}($1::timestamptz, $1::timestamptz) WHERE series_id = $2`,
      ['2026-10-04T12:00:00Z', emmerich],
    );
    expect(at.rows.map((r) => r.run_id)).toEqual([runs[1]?.id]);
  });
});
