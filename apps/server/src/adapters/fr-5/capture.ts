import type { Adapter } from '../../http/types.ts';

// FR-5 Vigicrues reference data (catalogue §2.5): the sections of territories
// 2, 3 and 29 (`aNMoinsUn` of TerEntVigiCru), then TronEntVigiCru per section,
// whose `aNMoinsUn` is the station → section link P7 needs. Section codes are
// provider data, checked before they fill the registry's own URL.

const SECTION = /^[A-Z0-9]{1,8}$/;

export const adapter: Adapter = {
  expand({ req, doc }) {
    const territories = (doc as { ListEntVigiCru?: unknown } | null)?.ListEntVigiCru;
    if (!Array.isArray(territories)) return { reqs: [] };
    const base = new URL(req.url);
    const codes = new Set<string>();
    for (const t of territories as { aNMoinsUn?: unknown }[]) {
      if (!Array.isArray(t?.aNMoinsUn)) continue;
      for (const s of t.aNMoinsUn as { CdEntVigiCruInferieur?: unknown; TypEntVigiCruInferieur?: unknown }[]) {
        const code = s?.CdEntVigiCruInferieur;
        if (typeof code === 'string' && SECTION.test(code) && String(s.TypEntVigiCruInferieur) === '8') codes.add(code);
      }
    }
    return {
      reqs: [...codes].sort().map((code) => {
        const url = new URL('/services/TronEntVigiCru.json', base.origin);
        url.search = new URLSearchParams({ CdEntVigiCru: code, TypEntVigiCru: '8' }).toString();
        return { url: url.href, method: 'GET' as const, variant: `section/${code}` };
      }),
    };
  },
};
