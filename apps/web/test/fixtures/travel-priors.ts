import type { TravelPrior } from '../../src/lib/travel.ts';

// Every §3.7 anchor of docs/sources/SOURCE-CATALOGUE.md as a test prior, with the expected nl and en text (P11a, D-A).
// Values are quoted as the catalogue states them, in its unit. These are test priors, not the runtime data: the
// runtime shows only the pairs of reaches-<ver>.json.

export interface PriorCase {
  id: string;
  /** Where the figure stands in the catalogue. */
  ref: string;
  prior: TravelPrior;
  /** The expected text; null for an unverified figure. */
  nl: string | null;
  en: string | null;
}

const lbl = (nl: string, en: string) => ({ nl, en });
const FLOOD = lbl('hoogwatergolf, mediaan', 'flood wave, median');
const LOW = lbl('laagwater aug–sep 2026', 'low water Aug–Sep 2026');
const RWS85 = lbl('RWS 1985, grote spreiding', 'RWS 1985, large spread');
const JUL21 = 'piek juli 2021';

const range = (
  id: string,
  ref: string,
  lo: number,
  hi: number,
  unit: 'h' | 'd',
  nl: string,
  en: string,
): PriorCase => ({
  id,
  ref,
  prior: { kind: 'range', lo, hi, unit },
  nl,
  en,
});
const unverified = (id: string, ref: string): PriorCase => ({
  id,
  ref,
  prior: { kind: 'unverified' },
  nl: null,
  en: null,
});

export const PRIORS: readonly PriorCase[] = [
  // Rhine -> Lobith, flood peak (GWIO 85.006 appendix 1), ranges
  range('emmerich-lobith', '§3.7 Rhine table, Emmerich', 1, 8, 'h', 'indicatief: 1–8 u', 'indicative: 1–8 h'),
  range('wesel-lobith', '§3.7 Rhine table, Wesel', 6, 19, 'h', 'indicatief: 6–19 u', 'indicative: 6–19 h'),
  range('ruhrort-lobith', '§3.7 Rhine table, Ruhrort', 13, 27, 'h', 'indicatief: 13–27 u', 'indicative: 13–27 h'),
  range(
    'duesseldorf-lobith',
    '§3.7 Rhine table, Düsseldorf',
    11,
    34,
    'h',
    'indicatief: 11–34 u',
    'indicative: 11–34 h',
  ),
  range(
    'koeln-lobith',
    '§3.7 Rhine table, Köln; §8 C1 (map-rivers)',
    22,
    46,
    'h',
    'indicatief: 22–46 u',
    'indicative: 22–46 h',
  ),
  range(
    'koeln-lobith-chbafu',
    '§8 C1 (ch-bafu: about 22–40 h)',
    22,
    40,
    'h',
    'indicatief: 22–40 u',
    'indicative: 22–40 h',
  ),
  range('bonn-lobith', '§3.7 Rhine table, Bonn', 24, 49, 'h', 'indicatief: 24–49 u', 'indicative: 24–49 h'),
  range(
    'andernach-lobith-file',
    '§3.7 Rhine table, Andernach (map-rivers / reaches file)',
    28,
    48,
    'h',
    'indicatief: 28–48 u',
    'indicative: 28–48 h',
  ),
  {
    id: 'andernach-lobith-c1',
    ref: '§8 C1: use "about 1.5 days (28–49 h)" for Andernach in the UI',
    prior: { kind: 'range', lo: 28, hi: 49, unit: 'h', label: lbl('ca. 1,5 dag', 'about 1.5 days') },
    nl: 'indicatief: 28–49 u (ca. 1,5 dag)',
    en: 'indicative: 28–49 h (about 1.5 days)',
  },
  // medians (≈) of the same table
  ...(
    [
      ['andernach', 39, 'Andernach'],
      ['bonn', 35, 'Bonn'],
      ['koeln', 30, 'Köln'],
      ['duesseldorf', 23, 'Düsseldorf'],
      ['ruhrort', 19, 'Ruhrort'],
      ['wesel', 11, 'Wesel'],
      ['emmerich', 3, 'Emmerich'],
    ] as const
  ).map(
    ([id, value, name]): PriorCase => ({
      id: `${id}-lobith-median`,
      ref: `§3.7 Rhine table, ${name} (≈)`,
      prior: { kind: 'single', value, unit: 'h', label: FLOOD },
      nl: `indicatief: ca. ${value} u (hoogwatergolf, mediaan)`,
      en: `indicative: about ${value} h (flood wave, median)`,
    }),
  ),
  // low water, Aug-Sep 2026 (map-rivers cross-correlation)
  ...(
    [
      ['kaub-lobith', 64, '§3.7 Rhine table, Kaub (9 + 16 + 37 + 2)'],
      ['koblenz-lobith', 55, '§3.7 Rhine table, Koblenz'],
      ['koeln-lobith', 39, '§3.7 Rhine table, Köln'],
      ['emmerich-lobith', 2, '§3.7 Rhine table, Emmerich (r = 0.78)'],
      ['kaub-koblenz', 9, '§3.7 low-water legs (r 0.57)'],
      ['koblenz-koeln', 16, '§3.7 low-water legs (r 0.67)'],
      ['koeln-emmerich', 37, '§3.7 low-water legs (r 0.57)'],
      ['cochem-koblenz', 5, '§3.7 low-water legs (r 0.45)'],
    ] as const
  ).map(
    ([id, value, ref]): PriorCase => ({
      id: `low-${id}`,
      ref,
      prior: { kind: 'single', value, unit: 'h', label: LOW },
      nl: `indicatief: ca. ${value} u (laagwater aug–sep 2026)`,
      en: `indicative: about ${value} h (low water Aug–Sep 2026)`,
    }),
  ),
  unverified('low-trier-cochem', '§3.7 low-water legs: Trier UP -> Cochem not usable (r 0.22, weir-regulated)'),
  unverified('low-maxau-kaub', '§3.7 Rhine table, Maxau low water: 11 h, r = 0.29 (unreliable)'),
  // upper Rhine
  {
    id: 'basel-maxau',
    ref: '§3.7 Rhine table, Basel (IKSR: reduced from 64 to 23 hours)',
    prior: {
      kind: 'single',
      value: 23,
      unit: 'h',
      label: lbl('na de Boven-Rijnwerken', 'after the Upper Rhine training works'),
    },
    nl: 'indicatief: ca. 23 u (na de Boven-Rijnwerken)',
    en: 'indicative: about 23 h (after the Upper Rhine training works)',
  },
  // derived
  {
    id: 'maxau-lobith-derived',
    ref: '§3.7 Rhine table, Maxau (derived, 1999 floods)',
    prior: { kind: 'range', lo: 4, hi: 5, unit: 'd', derived: true },
    nl: 'indicatief: 4–5 dagen (afgeleid)',
    en: 'indicative: 4–5 days (derived)',
  },
  {
    id: 'kaub-lobith-derived',
    ref: '§3.7 Rhine table, Kaub (derived)',
    prior: { kind: 'single', value: 2, unit: 'd', label: lbl('hoogwater', 'flood'), derived: true },
    nl: 'indicatief: ca. 2 dagen (hoogwater) (afgeleid)',
    en: 'indicative: about 2 days (flood) (derived)',
  },
  {
    id: 'koblenz-lobith-derived',
    ref: '§3.7 Rhine table, Koblenz (derived)',
    prior: { kind: 'range', lo: 40, hi: 45, unit: 'h', derived: true },
    nl: 'indicatief: 40–45 u (afgeleid)',
    en: 'indicative: 40–45 h (derived)',
  },
  // Lobith onward (RWS 1985 appendix 2)
  ...(
    [
      ['nijmegen', 5],
      ['tiel', 13],
      ['zaltbommel', 19],
      ['ijsselkop', 5],
      ['driel', 12],
      ['amerongen', 25],
      ['olst', 40],
      ['katerveer', 48],
    ] as const
  ).map(
    ([id, value]): PriorCase => ({
      id: `lobith-${id}`,
      ref: `§3.7 Lobith onward, ${id}`,
      prior: { kind: 'single', value, unit: 'h', label: RWS85 },
      nl: `indicatief: ca. ${value} u (RWS 1985, grote spreiding)`,
      en: `indicative: about ${value} h (RWS 1985, large spread)`,
    }),
  ),
  // Meuse
  {
    id: 'namur-ourthe-borgharen',
    ref: '§3.7 Meuse table, Namur (Jambes) and Ourthe (Comblain-au-Pont) -> Borgharen (Lodder 1983)',
    prior: {
      kind: 'single',
      value: 7,
      unit: 'h',
      label: lbl('oude RWS-voorspelrelatie', 'old RWS forecasting relation'),
    },
    nl: 'indicatief: ca. 7 u (oude RWS-voorspelrelatie)',
    en: 'indicative: about 7 h (old RWS forecasting relation)',
  },
  {
    id: 'eijsden-stpieter',
    ref: '§3.7 Meuse table, Eijsden-grens -> St. Pieter',
    prior: { kind: 'single', value: 1, unit: 'h', label: lbl('normale omstandigheden', 'normal conditions') },
    nl: 'indicatief: ca. 1 u (normale omstandigheden)',
    en: 'indicative: about 1 h (normal conditions)',
  },
  ...(
    [
      ['borgharen', 3.5, '3,5'],
      ['venlo', 38, '38'],
      ['megen', 82, '82'],
    ] as const
  ).map(
    ([id, value, nl]): PriorCase => ({
      id: `jul2021-${id}`,
      ref: `§3.7 Meuse table, July 2021 peak, ${id} (counted from Eijsden-grens)`,
      prior: { kind: 'single', value, unit: 'h', label: JUL21 },
      nl: `indicatief: ca. ${nl} u (piek juli 2021)`,
      en: `indicative: about ${value} h (piek juli 2021)`,
    }),
  ),
  range(
    'chalaines-chiers',
    '§3.7 Meuse table, Chalaines -> Chiers confluence (Tailliez 2000)',
    4,
    5,
    'd',
    'indicatief: 4–5 dagen',
    'indicative: 4–5 days',
  ),
  // unverified: no text
  unverified('chooz-borgharen', '§3.7 Meuse table, Chooz -> Borgharen about 16 h (UNVERIFIED)'),
  unverified('namur-eijsden', '§3.7 Meuse table, Namur -> Eijsden about 4–6 h (UNVERIFIED)'),
  unverified('trier-koblenz', '§3.7 Moselle: about 20–30 h at flood (UNVERIFIED)'),
  unverified('maxau-andernach', '§3.7 Maxau -> Andernach roughly 1–1.5 days (UNVERIFIED)'),
  unverified('summary-moselle-3d', '§3.7 secondary summary: Moselle about 3 days to the Netherlands (UNVERIFIED)'),
  unverified('summary-upper-rhine-5d', '§3.7 secondary summary: Upper Rhine about 5 days to Lobith (UNVERIFIED)'),
  unverified('blog-basel-lobith-6d', '§3.7 blog: 6 days Basel -> Lobith (not authoritative)'),
];
