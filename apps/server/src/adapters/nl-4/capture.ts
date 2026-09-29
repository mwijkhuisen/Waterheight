import type { Adapter } from '../../http/types.ts';

// NL-4 (catalogue §2.1): the waterdata page links the class-boundary workbook.
// A new file name (a new edition) or a missing link pages the owner, because
// the registry URL must then be updated (CTD switch on 2026-11-05).

export const adapter: Adapter = {
  alertKey(doc) {
    if (typeof doc !== 'string') return null;
    // Bounded: an unbounded run here is quadratic on a page that repeats the prefix.
    const names = new Set(doc.match(/grenswaarden-en-legendakleuren[^"'<>\s]{0,200}\.xlsx/g) ?? []);
    return [...names].sort().join(',') || null;
  },
};
