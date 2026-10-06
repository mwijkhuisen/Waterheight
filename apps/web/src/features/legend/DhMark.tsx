// The direction mark of a 24-hour change (▲ ▼, and ► for steady): an icon, not a lone character, because axe cannot
// judge the contrast of text that holds no letter ("incomplete", P4b review round 2, the same reason as the close
// buttons). Decorative: the word that follows it carries the meaning.

const PATH: Record<string, string> = { '▲': 'M5 1L9 9H1Z', '▼': 'M5 9L1 1H9Z', '►': 'M1 1L9 5L1 9Z' };

export function DhMark({ glyph }: { glyph: string }) {
  const d = PATH[glyph];
  if (d === undefined) return null;
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
      <path d={d} fill="currentColor" />
    </svg>
  );
}
