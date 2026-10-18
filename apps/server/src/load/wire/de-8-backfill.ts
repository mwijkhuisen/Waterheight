import { type Registry, SchemaDrift } from '@rws/core';
import { type BackfillRows, normaliseBackfill } from '../../adapters/de-8/normalise.ts';
import {
  BACKFILL_MAX_LINE,
  BACKFILL_ZIP,
  backfillSink,
  TIME as DE8_TIME,
  type Held,
  MEMBER_RE,
  memberStation,
} from '../../adapters/de-8/parse.ts';
import { checkZip, GuardFailure, lineSplitter } from '../../http/guards.ts';
import type { Backfilled, SpecLoader } from '../adapters.ts';

// P14b: the DE-8 backfill spec (de-8-backfill-w: the verified NRW decade ZIPs of hydro/w), merged into the DE-8 entry
// of load/adapters.ts beside its station and gauge-zero specs. Its rows are step-held onto the DE-7 W series of the
// tier-1 gauges (`obsTarget: 'DE-7'`); a decade file is one archive object that about 120 slice lines load.
// A wiring file may use the guards (an adapter may not).

/** DE-8's time convention (A§7.4): the hydro CSV states a fixed +01:00 all year (ungated). */
export const TIME = DE8_TIME;

const MIB = 1024 * 1024;

/** The tier-1 gauges of the target's registry: `<no>/W` with `tier` 1. Only their members are parsed row by row. */
function selected(registry: Registry): Set<string> {
  const out = new Set<string>();
  for (const [key, decl] of registry) if (decl.tier === 1 && key.endsWith('/W')) out.add(key.slice(0, -2));
  return out;
}

/**
 * One decade ZIP, read once under the ZIP guard with this spec's caps (200 members, 640 MiB inflated, ratio 50): the
 * rows of the selected stations as columns, every other member's data rows counted (its header is still checked).
 */
async function readZip(body: Uint8Array, pick: ReadonlySet<string>): Promise<BackfillRows> {
  const rows = new Map<string, Held>();
  const counted = new Map<string, number>();
  try {
    await checkZip(Buffer.from(body.buffer, body.byteOffset, body.byteLength), {
      names: (name) => !name.includes('/') && MEMBER_RE.test(name),
      maxMembers: BACKFILL_ZIP.members,
      maxTotal: BACKFILL_ZIP.total,
      onMember: (name) => {
        const no = memberStation(name) as string;
        // Two members of one station would overwrite each other's rows.
        if (rows.has(no) || counted.has(no)) throw new SchemaDrift('zip_name');
        const keep = pick.has(no);
        const sink = backfillSink(no, { keep });
        const split = lineSplitter(sink.line, 'utf-8', BACKFILL_MAX_LINE, { fatal: true });
        return {
          data: split.push,
          end: () => {
            split.end();
            const done = sink.end();
            if (keep) rows.set(no, { ts: done.ts, value: done.value });
            else counted.set(no, done.rows);
          },
        };
      },
    });
  } catch (err) {
    if (err instanceof GuardFailure) throw new SchemaDrift(err.reason);
    throw err;
  }
  return { rows, counted };
}

/**
 * The parse of the last object, kept across lines: the slices of one decade file (~122 lines of P30D) share one archive
 * key, so the file is inflated once. An LRU of one: the runner works through one file at a time. The key is the
 * archive key with the adapter version (`ctx.memoKey`): equal keys are the same bytes parsed the same way. The
 * selection comes from the registry of the first line that parsed it.
 */
let memo: { key: string; parsed: BackfillRows } | undefined;

const run: SpecLoader['run'] = async (b, c): Promise<Backfilled> => {
  if (c.backfill === undefined) throw new SchemaDrift('backfill_window');
  let parsed = c.memoKey !== undefined && memo?.key === c.memoKey ? memo.parsed : undefined;
  const fresh = parsed === undefined;
  if (parsed === undefined) {
    parsed = await readZip(b, selected(c.registry));
    memo = c.memoKey === undefined ? undefined : { key: c.memoKey, parsed };
  }
  const out = normaliseBackfill(parsed, { registry: c.registry, window: c.backfill });
  // The raw drops are the file's, not the slice's: reported by the line that parsed it, so a log sums to the file.
  return fresh ? out : { ...out, raw_dropped: {} };
};

export const SPECS: Readonly<Record<string, SpecLoader>> = {
  'de-8-backfill-w': { maxBytes: 25 * MIB, needsVariant: false, backfill: true, obsTarget: 'DE-7', run },
};
