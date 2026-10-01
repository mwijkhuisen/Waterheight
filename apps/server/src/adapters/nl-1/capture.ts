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
        ? { Grootheid: { Code: 'Q' }, ProcesType: proces }
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
