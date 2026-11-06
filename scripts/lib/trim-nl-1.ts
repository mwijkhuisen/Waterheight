// #184 stage 2: the cut rules of the NL-1 backfill recordings (`scripts/smoke-capture.ts --backfill`, 2026-11-06).
// A rule keeps, in every list of `WaarnemingenLijst`, the measurements whose `Tijdstip` lies in a stated UTC window,
// and never edits one: the kept measurements, every list and every other field are the recording's own, re-serialised
// by `JSON.stringify` (as scripts/trim-fixtures.ts does for CH-2 and CH-3). A cut that would leave a list empty stops
// the run, so every list the recording holds stays in the fixture. It reads the recording from the git-ignored
// `.smoke/<name>.raw` and the recording's meta from the fixture's own `.meta.json` (written by smoke-capture beside
// its whole copy, which the cut then replaces), and writes the fixture with a meta (`from: 'trimmed'` with the rule,
// or `trimmed: false` for a whole recording; `source_sha256` of the recording). Run by
// `node scripts/trim-fixtures.ts --p184`; a missing recording is skipped and said so. Public data only.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Cut = { name: string; window: readonly [string, string] | null; why: string };

const CUTS: readonly Cut[] = [
  {
    name: 'nl-1-backfill-megen-q-20240301',
    window: ['2024-03-01T00:00:00Z', '2024-03-03T00:00:00Z'],
    why: 'D-1: the 10-minute readings labelled GEM24H under F103, the F006 daily means at 11:00Z, no NVT list',
  },
  {
    name: 'nl-1-backfill-megen-q-20231228',
    window: ['2023-12-30T12:00:00Z', '2024-01-01T00:00:00Z'],
    why: 'D-1 boundary: the NVT list to 22:50Z, the F103 readings from 23:00Z and the F103 daily means at 23:00Z',
  },
  {
    name: 'nl-1-backfill-lobith-q-20170101',
    window: ['2017-01-01T00:00:00Z', '2017-01-03T00:00:00Z'],
    why: 'F230 beside the F216 history and its daily mean',
  },
  {
    name: 'nl-1-backfill-lith-h-19930904',
    window: null,
    why: '42 KB: F001 hourly and its daily mean, then F007 and its daily mean from 1993-09-06T23:00Z',
  },
  {
    name: 'nl-1-backfill-maastricht-q-20160301',
    window: ['2016-03-01T00:00:00Z', '2016-03-03T00:00:00Z'],
    why: 'D-6: the F006 daily mean as two lists, stamped 23:00Z and 11:00Z, beside an NVT list of quality 1004',
  },
];

type Meting = { Tijdstip: string };
type List = { MetingenLijst: Meting[] };
type Doc = { WaarnemingenLijst: List[] };

/** The document with only the measurements in [lo, hi) of every list; a list left empty is an error. */
function cutDoc(doc: Doc, lo: number, hi: number, name: string): Doc {
  if (!Array.isArray(doc.WaarnemingenLijst)) throw new Error(`nl-1 trim ${name}: not an OphalenWaarnemingen answer`);
  return {
    ...doc,
    WaarnemingenLijst: doc.WaarnemingenLijst.map((l, i) => {
      const kept = l.MetingenLijst.filter((m) => {
        const t = Date.parse(m.Tijdstip);
        if (Number.isNaN(t)) throw new Error(`nl-1 trim ${name}: list ${i} has an unreadable Tijdstip`);
        return t >= lo && t < hi;
      });
      if (kept.length === 0) throw new Error(`nl-1 trim ${name}: the window leaves list ${i} empty`);
      return { ...l, MetingenLijst: kept };
    }),
  };
}

/** `smoke`: the `.smoke/` directory; `fixtures`: apps/server/src/adapters/nl-1/fixtures. */
export function trim(smoke: string, fixtures: string, cuts: readonly Cut[] = CUTS): void {
  for (const c of cuts) {
    const rawFile = join(smoke, `${c.name}.raw`);
    if (!existsSync(rawFile)) {
      console.log(`${c.name}: no recording in ${smoke}, skipped`);
      continue;
    }
    const raw = readFileSync(rawFile);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const metaFile = join(fixtures, `${c.name}.meta.json`);
    const recording = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    // A second run reads the meta the first one wrote: it must name this very recording.
    if (recording.source_sha256 !== undefined && recording.source_sha256 !== sha256)
      throw new Error(`nl-1 trim ${c.name}: the recording is not the one its meta names`);
    if (recording.source_sha256 === undefined && recording.bytes !== raw.length)
      throw new Error(`nl-1 trim ${c.name}: the recording is not the one smoke-capture wrote`);
    const rule =
      c.window === null
        ? false
        : `the measurements of every list with Tijdstip in [${c.window[0]}, ${c.window[1]}), JSON.stringify of the kept document (${c.why})`;
    const body =
      c.window === null
        ? raw
        : Buffer.from(
            JSON.stringify(
              cutDoc(JSON.parse(raw.toString('utf8')) as Doc, Date.parse(c.window[0]), Date.parse(c.window[1]), c.name),
            ),
          );
    const meta = {
      spec: recording.spec,
      source: recording.source,
      synthetic: false,
      ...(rule === false ? {} : { from: 'trimmed' }),
      recorded_at: recording.recorded_at,
      status: recording.status,
      content_type: recording.content_type,
      url: recording.url,
      bytes: raw.length,
      request: recording.request,
      source_sha256: sha256,
      trimmed: rule,
    };
    writeFileSync(join(fixtures, `${c.name}.raw`), body);
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${c.name}: ${rule === false ? `whole (${c.why})` : `${body.length} of ${raw.length} B`}`);
  }
}
