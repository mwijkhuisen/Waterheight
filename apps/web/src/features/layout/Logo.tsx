// The logomark (P10f, docs/design/BRAND.md §4): a radar scope over water. A round outline with a range ring and a
// sweep whose trail is Waterblauw; the lower part is water with a wave as its top edge and a white blip, the gauge
// the sweep has found. Decorative: the name beside it is the text. 'light' is the full 64 px drawing for the off-white
// (the Lichtwater wave line, the ring's arc in the water and the white blip); 'dark' is the drawing for Rivierblauw,
// with the lighter water and a dark blip. The colours are the document's, here only.
export function Logo({ variant, size }: { variant: 'light' | 'dark'; size: number }) {
  const dark = variant === 'dark';
  const line = dark ? '#F4F1EA' : '#0E3A4B';
  const water = dark ? '#4FB3C9' : '#1A7F96';
  const wave = 'M11.36 56 Q20.52 49 29.68 56 T48 56 T66.32 56 T84.64 56';
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M48 48 L35.17 12.76 A37.5 37.5 0 0 1 72.1 19.27 Z" fill={water} />
      <path d={`${wave} A37.5 37.5 0 0 1 11.36 56 Z`} fill={water} />
      <path d="M25.37 56 A24 24 0 1 1 70.63 56" fill="none" stroke={line} strokeWidth={2.5} strokeLinecap="round" />
      {!dark && (
        <>
          <path
            d="M70.63 56 A24 24 0 0 1 25.37 56"
            fill="none"
            stroke="#8FD0DE"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <path d={wave} fill="none" stroke="#8FD0DE" strokeWidth={2.5} strokeLinecap="round" />
        </>
      )}
      <circle cx="48" cy="48" r="40" fill="none" stroke={line} strokeWidth={5} />
      <path d="M48 48 L72.1 19.27" stroke={line} strokeWidth={3.5} strokeLinecap="round" />
      <circle cx="48" cy="48" r="4" fill={line} />
      <circle cx="63" cy="68" r="2.8" fill={dark ? '#0E3A4B' : '#FFFFFF'} />
    </svg>
  );
}
