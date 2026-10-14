import type { Adapter } from '../../http/types.ts';

// NL-1 RWS WaterWebservices (catalogue §2.1): POST OphalenWaarnemingen, one
// Locatie per request, Periode in UTC. H is OW/WATHTE/NAP with ProcesType and
// no method filter (F155 on the Vecht); Q is Q with ProcesType and no method.
// A spec with `params.hoedanigheid: TAW` asks for the TAW duplicate instead
// (the Eijsden-grens twin, §4.1). Forecasts use ProcesType `verwachting` over
// T−10 min … T+48 h.

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const MINUTE = 60_000;

export const adapter: Adapter = {
  build({ req, row, now, window, params }) {
    const proces = params.proces === 'verwachting' ? 'verwachting' : 'meting';
    const aquo =
      row.quantity === 'Q'
        ? {
            Grootheid: { Code: 'Q' },
            // Only the backfill names it (P14a: NVT); live bodies stay as they were.
            ...(params.hoedanigheid === undefined ? {} : { Hoedanigheid: { Code: params.hoedanigheid } }),
            ProcesType: proces,
          }
        : {
            Compartiment: { Code: 'OW' },
            Grootheid: { Code: 'WATHTE' },
            Hoedanigheid: { Code: params.hoedanigheid === 'TAW' ? 'TAW' : 'NAP' },
            ProcesType: proces,
          };
    let from: Date;
    let to: Date;
    if (proces === 'verwachting') {
      // Whole minutes, so a repeated fetch of the same run hashes the same.
      const t = Math.floor(now.getTime() / MINUTE) * MINUTE;
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
