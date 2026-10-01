import { HealthSources } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { readSources } from '../../src/api/health.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { computeHealth, findOutages } from '../../src/load/health.ts';
import { EMMERICH_W, type Harness, harness, measurements, SERIES_URL } from './harness.ts';

// The outage drill's measure (issue #17 [owner] criterion; A§8 Q7): the last
// gap in a source's loaded payloads, and the expected buckets still empty inside
// it once the recorder has refilled.

let h: Harness;
const DAY = '2026-09-30';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00Z`);
const NOW = at('11:30');
const cadenceS = new Map([['DE-1', 900]]);
/** A 15-minute EMMERICH W series from `from` to `to` (UTC hh:mm, inclusive), as PEGELONLINE writes it (+02:00). */
const points = (from: string, to: string, skip: readonly string[] = []): [string, number][] => {
  const out: [string, number][] = [];
  for (let t = at(from).getTime(); t <= at(to).getTime(); t += 900_000) {
    const hhmm = new Date(t).toISOString().slice(11, 16);
    if (!skip.includes(hhmm)) out.push([`${new Date(t + 7_200_000).toISOString().slice(0, 19)}+02:00`, 100]);
  }
  return out;
};
const fetched = (hhmm: string, body: [string, number][]) =>
  writePayload(h.archive, {
    source: 'DE-1',
    spec: 'de-1-series',
    variant: EMMERICH_W,
    at: at(hhmm),
    body: measurements(...body),
    url: SERIES_URL(EMMERICH_W),
  });
const health = async (outages: Awaited<ReturnType<typeof findOutages>>) => {
  await computeHealth(h.load.db, {
    cadenceS,
    lagP95Ms: new Map(),
    backlog: { files: 0, bytes: 0, age_s: null },
    badLines: 0,
    now: NOW,
    outages,
  });
  const { rows } = await h.t.admin.query("SELECT detail FROM source_health WHERE source_id = 'DE-1'");
  return rows[0]?.detail;
};

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.close();
});

describe('capture outage and Q7 over it', () => {
  it('regular fetches, and a gap under three cadences, are no outage', async () => {
    await fetched('06:30', points('05:00', '06:15'));
    await fetched('06:45', points('05:00', '06:30'));
    // 40 minutes without a payload: under 3 × 15 min.
    await fetched('07:25', points('05:00', '07:15'));
    await h.loader({ now: NOW }).tick();
    expect(await findOutages(h.load.db, cadenceS, NOW)).toEqual(new Map());
    expect((await health(new Map())).outage).toBeUndefined();
  });

  it('a stopped recorder: the gap is the outage, and its unfilled buckets are counted', async () => {
    // 07:25 → 10:00: two and a half hours without a payload. The first fetch after it refills, but for 08:45.
    await fetched('10:00', points('07:15', '09:45', ['08:45']));
    await fetched('10:15', points('09:00', '10:00'));
    await h.loader({ now: NOW }).tick();
    const outages = await findOutages(h.load.db, cadenceS, NOW);
    expect(outages).toEqual(new Map([['DE-1', { from: at('07:25'), to: at('10:00') }]]));
    // Only EMMERICH W had data before the gap: the series without any are not counted as gaps of the outage.
    expect((await health(outages)).outage).toEqual({
      from: `${DAY}T07:25:00.000Z`,
      to: `${DAY}T10:00:00.000Z`,
      missing_buckets: 1,
    });
  });

  it('once the missing value arrives, the outage window has no empty bucket', async () => {
    await fetched('10:30', points('08:30', '10:15'));
    await h.loader({ now: NOW }).tick();
    const outages = await findOutages(h.load.db, cadenceS, NOW);
    expect(outages.get('DE-1')).toEqual({ from: at('07:25'), to: at('10:00') });
    expect((await health(outages)).outage).toMatchObject({ missing_buckets: 0 });
  });

  it('a gap is measured against the source’s own cadence, and only inside the last 168 hours', async () => {
    // With a one-hour cadence the threshold is three hours: 2 h 35 min is no outage.
    expect(await findOutages(h.load.db, new Map([['DE-1', 3600]]), NOW)).toEqual(new Map());
    // A source without a cadence is not looked at.
    expect(await findOutages(h.load.db, new Map(), NOW)).toEqual(new Map());
    // Eight days later the gap is history.
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(await findOutages(h.load.db, cadenceS, later)).toEqual(new Map());
  });

  it('the health API shows the outage of a public source, and the health pass drops it when it is gone', async () => {
    const api = h.dbAs('rws_api');
    const doc = await readSources(api.db, NOW);
    expect(HealthSources.safeParse(doc).success).toBe(true);
    expect(doc.sources.find((s) => s.id === 'DE-1')?.outage).toEqual({
      from: `${DAY}T07:25:00.000Z`,
      to: `${DAY}T10:00:00.000Z`,
      missing_buckets: 0,
    });
    expect(doc.sources.find((s) => s.id === 'NL-1')?.outage).toBeNull();
    expect((await health(new Map())).outage).toBeUndefined();
    const again = await readSources(api.db, NOW);
    expect(again.sources.find((s) => s.id === 'DE-1')?.outage).toBeNull();
    // Through the view only: the reader has no other way to the detail.
    const client = await h.t.connectAs('rws_api');
    const { rows } = await client.query(`SELECT detail FROM ${VIEWS.public.sourceHealth} WHERE source_id = 'DE-1'`);
    expect(rows[0]?.detail.outage).toBeUndefined();
  });
});
