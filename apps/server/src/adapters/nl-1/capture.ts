import { durationMs } from '@rws/core';
import type { Adapter } from '../../http/types.ts';

// NL-1 RWS WaterWebservices (catalogue §2.1): POST OphalenWaarnemingen, one
// Locatie per request, Periode in UTC. H is OW/WATHTE/NAP with ProcesType and
// no method filter (F155 on the Vecht); Q is Q with ProcesType and no method.
// A spec with `params.hoedanigheid: TAW` asks for the TAW duplicate instead
// (the Eijsden-grens twin, §4.1). Forecasts use ProcesType `verwachting` over
// T−10 min … T+48 h.
// P16a: a seed row may carry its own `hoedanigheid` (H: NAP, MSL, TAW, PLAATSLR; Q: NVT), a `groepering` (the
// high and low water groupings) and a `method`; `params.proces` may also be `astronomisch`, and
// `params.ahead` asks a window forward from now (the astronomical tide). Seed values are registry data,
// still enum-guarded: anything else throws, so no request is built from an unknown string.

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const MINUTE = 60_000;
const PROCES = new Set(['meting', 'verwachting', 'astronomisch']);
const H_DATUM = new Set(['NAP', 'MSL', 'TAW', 'PLAATSLR']);
const GROEPERING = new Set(['GETETM2', 'GETETMSL2', 'GETETBRKD2', 'GETETBRKDMSL2']);
const METHOD = /^other:F\d{3}$/;
/** RWS answers at most 160,000 values per request (catalogue §2.1); the finest step asked is 10 minutes. */
const MAX_VALUES = 160_000;
const STEP_MS = 10 * MINUTE;

export const adapter: Adapter = {
  build({ req, row, now, window, params }) {
    const proces = params.proces ?? 'meting';
    if (!PROCES.has(proces)) throw new Error('nl-1: bad proces');
    const q = row.quantity === 'Q';
    const own = row.hoedanigheid ?? '';
    if (own !== '' && !(q ? own === 'NVT' : H_DATUM.has(own))) throw new Error('nl-1: bad hoedanigheid');
    const groepering = row.groepering ?? '';
    if (groepering !== '' && !GROEPERING.has(groepering)) throw new Error('nl-1: bad groepering');
    const method = row.method ?? '';
    if (method !== '' && !METHOD.test(method)) throw new Error('nl-1: bad method');
    // The Q body has no place for either: a seed row that names one is a registry mistake, not something to ignore.
    if (q && (groepering !== '' || method !== '')) throw new Error('nl-1: groepering or method on a Q row');
    if (params.ahead !== undefined && proces !== 'astronomisch') throw new Error('nl-1: ahead needs astronomisch');
    const aquo = q
      ? {
          Grootheid: { Code: 'Q' },
          // Only the backfill and the P16a rows name it (NVT); live bodies stay as they were.
          ...(own !== ''
            ? { Hoedanigheid: { Code: own } }
            : params.hoedanigheid === undefined
              ? {}
              : { Hoedanigheid: { Code: params.hoedanigheid } }),
          ProcesType: proces,
        }
      : {
          Compartiment: { Code: 'OW' },
          Grootheid: { Code: 'WATHTE' },
          ...(groepering === '' ? {} : { Groepering: { Code: groepering } }),
          Hoedanigheid: { Code: own !== '' ? own : params.hoedanigheid === 'TAW' ? 'TAW' : 'NAP' },
          ProcesType: proces,
          ...(method === '' ? {} : { WaardeBepalingsMethode: { Code: method } }),
        };
    let from: Date;
    let to: Date;
    // Whole minutes, so a repeated fetch of the same run hashes the same.
    const t = Math.floor(now.getTime() / MINUTE) * MINUTE;
    if (params.ahead !== undefined) {
      const ahead = durationMs(params.ahead);
      if (ahead / STEP_MS > MAX_VALUES) throw new Error('nl-1: ahead exceeds 160000 values');
      from = new Date(t);
      to = new Date(t + ahead);
    } else if (proces === 'verwachting') {
      from = new Date(t - 10 * MINUTE);
      to = new Date(t + 48 * 60 * MINUTE);
    } else if (window !== null) {
      from = new Date(Math.floor(window.from.getTime() / MINUTE) * MINUTE);
      to = new Date(Math.ceil(window.to.getTime() / MINUTE) * MINUTE);
    } else {
      throw new Error('nl-1: an observation spec needs a window');
    }
    const body = {
      Locatie: { Code: row.code },
      AquoPlusWaarnemingMetadata: { AquoMetadata: aquo },
      Periode: { Begindatumtijd: utc(from), Einddatumtijd: utc(to) },
    };
    return { ...req, body: JSON.stringify(body) };
  },
};

/**
 * The `CheckWaarnemingenAanwezig` body (P14a probe, research nl-rws §2.6): is there any value of this series'
 * method in [from, to)? The method is the series' live one, so the probe finds where that method starts. The row
 * carries `code`, `quantity` and `hoedanigheid` (NAP for H, NVT for Q when it names none).
 */
export function buildCheck(row: Readonly<Record<string, string>>, from: Date, to: Date, method?: string): string {
  const q = row.quantity === 'Q';
  return JSON.stringify({
    LocatieLijst: [{ Code: row.code }],
    AquoMetadataLijst: [
      {
        Compartiment: { Code: 'OW' },
        Grootheid: { Code: q ? 'Q' : 'WATHTE' },
        Hoedanigheid: { Code: row.hoedanigheid ?? (q ? 'NVT' : 'NAP') },
        ProcesType: 'meting',
        ...(method === undefined ? {} : { WaardeBepalingsMethode: { Code: method } }),
      },
    ],
    Periode: { Begindatumtijd: utc(from), Einddatumtijd: utc(to) },
  });
}
