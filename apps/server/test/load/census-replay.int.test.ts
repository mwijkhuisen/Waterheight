import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine } from '../../../../scripts/fixture-archive.ts';
import { parseWaarnemingen } from '../../src/adapters/nl-1/parse.ts';
import type { ManifestLine } from '../../src/archive/manifest.ts';
import { sha256 } from '../../src/archive/writer.ts';
import { beforeFix, census } from '../../src/backfill/census.ts';
import { loadBackfill } from '../../src/backfill/spec.ts';
import { loadRegistry } from '../../src/capture/specs.ts';
import { LOAD_ADAPTERS, type LoadAdapter, loadNl1Backfill, type SpecLoader } from '../../src/load/adapters.ts';
import { readRegistry } from '../../src/load/registry-sync.ts';
import { replay } from '../../src/load/replay.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// #184 stage 1: the census predicts the production replay. An archive of NL-1 backfill lines (the real Lith 2003 and
// Lobith Q 2010 payloads, a refetch of Lith, and a synthetic Lith copy moved to 2004 with one orphan and one
// requalified row) is loaded as production holds it today (the loader of the code before the fix), then replayed with
// the real loader: the replay's counts must equal `totals.expect` of the census, and a third pass writes nothing.
// The lines have no `backfill_job` row: the ledger step of the loader then writes nothing (recordChunk).

const SPEC = 'nl-1-backfill-obs';
const URL_ = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';
const LITH = 'lith.boven/WATHTE/NAP/other:F007';
const FIRST_FETCH = Date.parse('2026-10-14T01:00:00Z');

type Meting = {
  Tijdstip: string;
  Meetwaarde: { Waarde_Numeriek: number };
  WaarnemingMetadata: { Kwaliteitswaardecode: string; Statuswaarde: string };
};
type Doc = {
  WaarnemingenLijst: { AquoMetadata: { WaardeBewerkingsMethode: { Code: string } }; MetingenLijst: Meting[] }[];
};

/** The 2003 Lith payload moved to 2004, with one orphan and one requalified instant (found, not hard-coded). */
function lith2004(): {
  body: Buffer;
  orphan: { ts: number; value: number };
  requalified: { ts: number; value: number };
} {
  const doc = JSON.parse(rawFixture('NL-1', 'nl-1-backfill-lith-h-20030129').body.toString('utf8')) as Doc;
  const nvt = doc.WaarnemingenLijst.find((l) => l.AquoMetadata.WaardeBewerkingsMethode.Code === 'NVT');
  const mean = doc.WaarnemingenLijst.find((l) => l.AquoMetadata.WaardeBewerkingsMethode.Code === 'GEM24H');
  if (nvt === undefined || mean === undefined) throw new Error('fixture lists changed');
  for (const l of doc.WaarnemingenLijst)
    for (const m of l.MetingenLijst) m.Tijdstip = m.Tijdstip.replaceAll('2003-', '2004-');
  const at = new Map(nvt.MetingenLijst.map((m) => [m.Tijdstip, m] as const));
  const pairs = mean.MetingenLijst.flatMap((g) => {
    const n = at.get(g.Tijdstip);
    return n === undefined ? [] : [{ g, n }];
  });
  const differing = pairs.find((p) => p.g.Meetwaarde.Waarde_Numeriek !== p.n.Meetwaarde.Waarde_Numeriek);
  const equal = pairs.find((p) => p.g.Meetwaarde.Waarde_Numeriek === p.n.Meetwaarde.Waarde_Numeriek);
  if (differing === undefined || equal === undefined) throw new Error('fixture has no such midnight');
  // The instantaneous value at this midnight is a gap: only the daily mean is left (an orphan after the fix).
  differing.n.WaarnemingMetadata.Kwaliteitswaardecode = '99';
  // The same value, but the instantaneous one is unchecked: the row keeps the raw quality instead of the validated.
  equal.n.WaarnemingMetadata.Statuswaarde = 'Ongecontroleerd';
  return {
    body: Buffer.from(JSON.stringify(doc)),
    orphan: { ts: Date.parse(differing.g.Tijdstip), value: differing.g.Meetwaarde.Waarde_Numeriek },
    requalified: { ts: Date.parse(equal.g.Tijdstip), value: equal.g.Meetwaarde.Waarde_Numeriek },
  };
}

let h: Harness;
let fetches = 0;
/** A backfill line as the runner writes it (retention 'backfill'), each a later fetch; no job row behind it. */
async function putBackfill(body: Buffer, from: string, to: string, job: number): Promise<ManifestLine> {
  const when = new Date(FIRST_FETCH + ++fetches * 60_000);
  const hash = sha256(body);
  const { key, stored } = await h.archive.put('NL-1', SPEC, when, body, hash);
  const line = bareLine('NL-1', SPEC, when, {
    request: { method: 'POST', url: URL_ },
    sha256: hash,
    bytes: body.length,
    stored_bytes: stored,
    key,
    validity: { ok: true, reason: null, count: 1 },
    retention: 'backfill',
    backfill: { job, chunk: 0, from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z` },
  });
  await h.archive.append(line);
  return line;
}

/** The loader of the code before the fix: a processed list read as an instantaneous one. */
const BEFORE_FIX: Readonly<Record<string, LoadAdapter>> = (() => {
  const nl1 = LOAD_ADAPTERS['NL-1'] as LoadAdapter;
  const orig = nl1.specs[SPEC] as SpecLoader;
  const spec: SpecLoader = { ...orig, run: (b, c) => loadNl1Backfill(beforeFix(parseWaarnemingen(b)), c) };
  return { ...LOAD_ADAPTERS, 'NL-1': { ...nl1, specs: { ...nl1.specs, [SPEC]: spec } } };
})();

const deps = (adapters?: Readonly<Record<string, LoadAdapter>>) => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => new Date(FIRST_FETCH + 86_400_000),
  ...(adapters === undefined ? {} : { adapters }),
});

/** The stored row of the Lith series at an instant, as the database holds it (never through a view). */
const lithRow = async (ts: number) =>
  (
    await h.t.admin.query<{ value: number; qc: number }>(
      `SELECT o.value, o.qc FROM obs o JOIN series s ON s.id = o.series_id
       WHERE s.provider_key = $1 AND o.ts = $2`,
      [LITH, new Date(ts)],
    )
  ).rows;

type Totals = {
  manifest_from: string;
  manifest_to: string;
  lines: number;
  objects: number;
  duplicate_lines: number;
  duplicate_lines_differing: number;
  restorable: number;
  requalified: number;
  orphan: number;
  expect: { lines: number; n_new: number; n_changed: number; quarantined: number; skipped: number };
};

describe('the census predicts the replay (#184 stage 1)', { timeout: 120_000 }, () => {
  let totals: Totals;
  let printed: unknown[];
  let args: { source: string; spec: string; from: string; to: string; dryRun: false };
  let edited: ReturnType<typeof lith2004>;

  beforeAll(async () => {
    h = await harness();
    edited = lith2004();
    const lith = rawFixture('NL-1', 'nl-1-backfill-lith-h-20030129').body;
    await putBackfill(lith, '2003-01-29', '2003-03-10', 1);
    await putBackfill(lith, '2003-01-29', '2003-03-10', 2); // a refetch of the same window, another job
    await putBackfill(edited.body, '2004-01-29', '2004-03-10', 3);
    await putBackfill(rawFixture('NL-1', 'nl-1-backfill-lobith-q-20100101').body, '2010-01-01', '2010-02-10', 4);

    printed = [];
    const log: string[] = [];
    const code = await census(
      { cmd: 'census', spec: SPEC },
      { config: loadBackfill(loadRegistry().hosts), registry: readRegistry(), reader: h.reader },
      (o) => printed.push(o),
      (s) => log.push(s),
    );
    expect({ code, log }).toEqual({ code: 0, log: [] });
    totals = (printed.at(-1) as { totals: Totals }).totals;
    args = { source: 'NL-1', spec: SPEC, from: totals.manifest_from, to: totals.manifest_to, dryRun: false };
  }, 120_000);
  afterAll(() => h?.close());

  it('the census counts the archive: a refetch is a duplicate, the edits are an orphan and a requalified row', () => {
    expect(totals).toMatchObject({
      lines: 4,
      objects: 3,
      duplicate_lines: 1,
      duplicate_lines_differing: 0,
      // Lith 2003: the 26 midnights where the daily mean differs; Lith 2004: the same 26 less the orphan.
      restorable: 26 + 25,
      requalified: 1,
      orphan: 1,
    });
    expect(totals.expect).toEqual({ lines: 4, n_new: 26 + 25 + 1, n_changed: 0, quarantined: 0, skipped: 0 });
    expect(printed).toContainEqual({
      orphan: { series: LITH, ts: new Date(edited.orphan.ts).toISOString(), value: edited.orphan.value },
    });
  });

  it('replay #1 with the code before the fix loads the database as production holds it today', async () => {
    const r = await replay(deps(BEFORE_FIX), args);
    expect(r).toMatchObject({ lines: 4, loaded: 4, quarantined: 0, skipped: 0, n_changed: 0 });
    // The orphan and the requalified instants are stored from the daily mean: validated (bit 2) plus backfill (512).
    const orphan = await lithRow(edited.orphan.ts);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.value).toBe(edited.orphan.value);
    expect(((orphan[0] as { qc: number }).qc & 2) !== 0).toBe(true);
    const req = await lithRow(edited.requalified.ts);
    expect(req).toHaveLength(1);
    expect(((req[0] as { qc: number }).qc & 2) !== 0).toBe(true);
    expect(((req[0] as { qc: number }).qc & 1) !== 0).toBe(false);
  });

  it('replay #2 with the fixed loader equals totals.expect and leaves the orphan, requalifying the other row', async () => {
    const r = await replay(deps(), args);
    expect({
      lines: r.lines,
      n_new: r.n_new,
      n_changed: r.n_changed,
      quarantined: r.quarantined,
      skipped: r.skipped,
    }).toEqual(totals.expect);
    // Spelled out: 26 + 25 restored rows and the one requalified row, all backfill rows (so none counts as changed).
    expect(r).toEqual({ lines: 4, loaded: 4, quarantined: 0, skipped: 0, n_new: 26 + 25 + 1, n_changed: 0 });

    // A replay never deletes: the orphan keeps the daily mean and its backfill bit.
    const orphan = await lithRow(edited.orphan.ts);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.value).toBe(edited.orphan.value);
    expect(((orphan[0] as { qc: number }).qc & 512) !== 0).toBe(true);
    // The requalified row now has the raw quality (bit 1) of the instantaneous value, not the validated one (bit 2).
    const req = await lithRow(edited.requalified.ts);
    expect(req).toHaveLength(1);
    const qc = (req[0] as { qc: number }).qc;
    expect({ raw: (qc & 1) !== 0, validated: (qc & 2) !== 0, backfill: (qc & 512) !== 0 }).toEqual({
      raw: true,
      validated: false,
      backfill: true,
    });
  });

  it('replay #3 writes nothing', async () => {
    const before = await h.checksums();
    const r = await replay(deps(), args);
    expect(r).toMatchObject({ lines: 4, loaded: 4, quarantined: 0, skipped: 0, n_new: 0, n_changed: 0 });
    expect(await h.checksums()).toEqual(before);
  });
});
