// The logomark (P10c, docs/design/BRAND.md §4): an eye with a river as its iris. Decorative: the name beside it is the
// text. 'light' is the full 64 px drawing for the off-white (wave line and highlight); 'dark' is the drawing for
// Rivierblauw (the footer), with the lighter water and a dark highlight. The colours are the document's, here only.
export function Logo({ variant, size }: { variant: 'light' | 'dark'; size: number }) {
  const dark = variant === 'dark';
  const line = dark ? '#F4F1EA' : '#0E3A4B';
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        d="M6 48 C22 16 74 16 90 48 C74 80 22 80 6 48 Z"
        fill="none"
        stroke={line}
        strokeWidth={5}
        strokeLinejoin="round"
      />
      <circle cx="48" cy="48" r="16" fill={line} />
      <path d="M32 48 Q40 41 48 48 T64 48 A16 16 0 0 1 32 48 Z" fill={dark ? '#4FB3C9' : '#1A7F96'} />
      {!dark && (
        <path d="M32 48 Q40 41 48 48 T64 48" fill="none" stroke="#8FD0DE" strokeWidth={2.5} strokeLinecap="round" />
      )}
      <circle cx="54.5" cy="40.5" r="2.4" fill={dark ? '#0E3A4B' : '#FFFFFF'} />
    </svg>
  );
}
