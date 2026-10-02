// The AGE forecast slug (catalogue §2.6), shared by LU-3 (its file names) and LU-4 (a page's `forecastsFileName`,
// else its station `id`): trim, lowercase, strip accents, turn `/` with any spaces around it and any other run of
// spaces into `-`, collapse repeated `-` and drop one at either end. `Ettelbrück-/-Alzette` → `ettelbruck-alzette`,
// `Gemünd / Our` → `gemund-our`. The capture never builds a URL from it: the slugs it fetches are pinned in registry/seed/lu-3.csv.
export function slugOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s*\/\s*/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}
