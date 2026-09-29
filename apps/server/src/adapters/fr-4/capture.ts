import type { Adapter } from '../../http/types.ts';

// FR-4 Vigicrues forecasts (catalogue §2.5): the national list, then each
// listed station while it is listed. Station codes come from the provider,
// so each is checked against the Sandre pattern before it fills the
// registry's own URL (the list's `Link` is never followed).

const CODE = /^[A-Z][0-9A-Z]{9}$/;

export const adapter: Adapter = {
  expand({ req, doc }) {
    const list = (doc as { ListEntVigiCru?: unknown } | null)?.ListEntVigiCru;
    if (!Array.isArray(list)) return { reqs: [] };
    const base = new URL(req.url);
    const grd = base.searchParams.get('GrdSimul') === 'Q' ? 'Q' : 'H';
    const reqs = [];
    for (const item of list as { CdEntVigiCru?: unknown; TypEntVigiCru?: unknown }[]) {
      const code = item?.CdEntVigiCru;
      if (typeof code !== 'string' || !CODE.test(code) || String(item.TypEntVigiCru) !== '7') continue;
      const url = new URL(base.pathname, base.origin);
      url.search = new URLSearchParams({
        CdEntVigiCru: code,
        TypEntVigiCru: '7',
        FormatDate: 'iso',
        GrdSimul: grd,
      }).toString();
      reqs.push({ url: url.href, method: 'GET' as const, variant: `${code}/${grd}` });
    }
    return { reqs };
  },
};
