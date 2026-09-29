import type { Adapter } from '../../http/types.ts';

// LU-5 LU-Alert CAP dumps on data.public.lu (catalogue §2.6): the dataset's
// resource list, then each new `dump-alert.<epoch>.xml` by its own resource
// `url` on download.data.public.lu (never `latest`, which would need a
// cross-host redirect). URLs come from the provider, so each is re-checked by
// the client and must match the resource path pattern. The seed walks every
// page via `next_page` (also re-checked).

const TITLE = /^dump-alert\.(\d{9,11})\.xml$/;
const FILE_PATH = /^\/resources\/[a-z0-9-]+\/\d{8}-\d{6}\/dump-alert\.\d{9,11}\.xml$/;
const LIST_PATH = /^\/api\/2\/datasets\/67aca67bcaea3ae62308114f\/resources\/$/;

type Resource = { id?: unknown; title?: unknown; url?: unknown };

export const adapter: Adapter = {
  expand({ doc, seen, checkUrl, seed }) {
    const page = doc as { data?: unknown; next_page?: unknown } | null;
    const data = Array.isArray(page?.data) ? (page.data as Resource[]) : [];
    const reqs = [];
    let fresh = 0;
    for (const r of data) {
      if (typeof r?.id !== 'string' || !/^[0-9a-f-]{36}$/.test(r.id) || typeof r.title !== 'string') continue;
      if (!TITLE.test(r.title) || typeof r.url !== 'string') continue;
      if (seen.has(r.id)) continue;
      const url = checkUrl(r.url);
      if (url === null || new URL(url).hostname !== 'download.data.public.lu' || !FILE_PATH.test(new URL(url).pathname))
        continue;
      fresh += 1;
      reqs.push({ url, method: 'GET' as const, variant: `file/${r.id}`, seen_id: r.id });
    }
    // Follow the list in the seed, and while a page still holds an unseen dump (a failed fetch that moved
    // down the list, an outage); the runner's max_expand bounds the walk.
    const next = typeof page?.next_page === 'string' ? checkUrl(page.next_page) : null;
    if (next !== null && LIST_PATH.test(new URL(next).pathname) && (seed || fresh > 0)) {
      reqs.push({ url: next, method: 'GET' as const, variant: 'list' });
    }
    return { reqs };
  },
  coverage(doc) {
    const data = (doc as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return null;
    const epochs = (data as Resource[])
      .map((r) => (typeof r?.title === 'string' ? TITLE.exec(r.title)?.[1] : undefined))
      .filter((x): x is string => x !== undefined)
      .map((e) => Number(e) * 1000);
    if (epochs.length === 0) return null;
    return { from: new Date(Math.min(...epochs)).toISOString(), to: new Date(Math.max(...epochs)).toISOString() };
  },
};
