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
