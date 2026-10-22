// The official warning services of the six countries (P10b): the one list the About and Disclaimer pages take their
// links from (parts/OfficialLinks.tsx). Each is the front page of the service itself, https and no path; a new one is
// a reviewed change (test/pages-static.test.ts). No imports: Node reads this file as it is.

export const OFFICIAL = [
  { country: 'NL', hrefs: ['https://waterberichtgeving.rws.nl/', 'https://waterinfo.rws.nl/'] },
  { country: 'DE', hrefs: ['https://www.hochwasserzentralen.de/'] },
  { country: 'BE', hrefs: ['https://www.waterinfo.be/', 'https://hydrometrie.wallonie.be/'] },
  { country: 'FR', hrefs: ['https://www.vigicrues.gouv.fr/'] },
  { country: 'LU', hrefs: ['https://inondations.public.lu/'] },
  { country: 'CH', hrefs: ['https://www.naturgefahren.ch/'] },
] as const;

/**
 * P18b: the official storm-surge warning per sea and estuary body of registry/waterbodies.yaml, a link and never
 * data (no warning text is copied; P19b renders it). The national service's front page, already reviewed in
 * OFFICIAL; [U] until C14's answer or the owner confirms it is the national storm-surge page.
 */
export const STORM_SURGE_WARNING = {
  noordzee: 'https://waterberichtgeving.rws.nl/',
  waddenzee: 'https://waterberichtgeving.rws.nl/',
  oosterschelde: 'https://waterberichtgeving.rws.nl/',
  westerschelde: 'https://waterberichtgeving.rws.nl/',
  'eems-dollard': 'https://waterberichtgeving.rws.nl/',
} as const;
