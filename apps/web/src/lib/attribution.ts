// The attribution of a source as the footer shows it (review SR-1). Etalab asks for the date of the last update
// (FR-1, FR-3), BAFU for the reference date (CH-1, CH-3): where an attribution row has `needsDate`, the date of the
// instant the page shows takes the place of the registry's placeholder, or follows the text when it has none.

/** The date placeholders of the registry's attribution texts: FR-3, then CH-1 in German, English and Dutch. */
const PLACEHOLDER = /\[date de mise à jour\]|\(Bezugsdatum\)|<date>|<datum>/;

/** Plain text in, plain text out: the caller renders it as a text node, never as HTML. */
export function attributionText(text: string, needsDate: boolean, date: string): string {
  if (!needsDate) return text;
  if (!PLACEHOLDER.test(text)) return `${text} (${date})`;
  // A function, so that a `$` in the date is never read as a replacement pattern.
  return text.replace(PLACEHOLDER, (found) => (found.startsWith('(') ? `(${date})` : date));
}
