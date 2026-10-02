import type { Adapter } from '../../http/types.ts';

// FR-1 Hub'Eau observations_tr (catalogue §2.5): wildcard code_entite over the
// NL-bound basins plus any explicit Belgian partner codes; a window from the
// last success − 4 h (at least 4 h, under one month: a value may reach Hub'Eau
// hours after its own time, #53); follow `next`
// (a provider-supplied URL, re-checked by the client); 206 is a success.

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** The only path a `next` may name (review SR-7: exactly, not by its suffix). */
const OBSERVATIONS_TR = '/api/v2/hydrometrie/observations_tr';

export const adapter: Adapter = {
  coverage(doc) {
    const data = (doc as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return null;
    // A loop, not Math.min(...ts): a spread of an unbounded body throws a RangeError past about 125,000 values.
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const d of data as { date_obs?: unknown }[]) {
      const t = Date.parse(String(d?.date_obs));
      if (t < min) min = t;
      if (t > max) max = t;
    }
    if (max === Number.NEGATIVE_INFINITY) return null;
    return { from: new Date(min).toISOString(), to: new Date(max).toISOString() };
  },
  build({ req, window, params, now }) {
    const url = new URL(req.url);
    if (params.explicit_codes) {
      url.searchParams.set('code_entite', `${url.searchParams.get('code_entite')},${params.explicit_codes}`);
    }
    if (window !== null) {
      url.searchParams.set('date_debut_obs', utc(window.from));
      // A closed window (the day-by-day seed) also sets its end.
      if (now.getTime() - window.to.getTime() > 60_000) url.searchParams.set('date_fin_obs', utc(window.to));
    }
    return { ...req, url: url.href };
  },
  expand({ req, doc, checkUrl }) {
    const next = (doc as { next?: unknown } | null)?.next;
    if (next === null || next === undefined) return { reqs: [] };
    // A `next` we will not follow cuts the walk: the runner treats it like a capped walk, never as its end (P5a).
    if (typeof next !== 'string' || next === '') return { reqs: [], refused: true };
    const url = checkUrl(next);
    if (url === null || new URL(url).pathname !== OBSERVATIONS_TR) return { reqs: [], refused: true };
    const page = Number(/#(\d+)$/.exec(req.variant)?.[1] ?? 1) + 1;
    return { reqs: [{ url, method: 'GET', variant: `${req.variant.replace(/#\d+$/, '')}#${page}` }] };
  },
};
