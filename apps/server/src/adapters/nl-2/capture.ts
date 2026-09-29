import type { Adapter } from '../../http/types.ts';

// NL-2 RWS WFS (catalogue §2.1): always CQL-filtered (941,735 features
// otherwise). TIJDSTIP_LAATSTE_METING is Amsterdam wall-clock time labelled
// Z, so the filter reaches 12 h back (well over the 2 h padding needed).

const PAD_MS = 12 * 3_600_000;
const STEP_MS = 10 * 60_000;

export const adapter: Adapter = {
  build({ req, now }) {
    const since = new Date(Math.floor((now.getTime() - PAD_MS) / STEP_MS) * STEP_MS).toISOString().slice(0, 16);
    const cql = `COMPARTIMENTCODE='OW' AND GROOTHEIDCODE IN ('WATHTE','Q') AND TIJDSTIP_LAATSTE_METING > '${since}'`;
    return { ...req, url: `${req.url}&CQL_FILTER=${encodeURIComponent(cql)}` };
  },
};
