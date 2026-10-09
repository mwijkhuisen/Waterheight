// The ETA scan (P11a, issue #26 C1): travel times are indicative sourced ranges, never an arrival time. Pure (no DOM,
// no node: imports), used by Vitest and Playwright. A violation names where and which rule; it never echoes the text.

export interface EtaItem {
  where: string;
  text: string;
  /** A travel-time row: the stricter rules apply. */
  travelRow?: boolean;
}
export interface EtaViolation {
  where: string;
  rule: string;
}

const MONTHS =
  'januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|may|june|july|august|october|jan|feb|mrt|mar|apr|jun|jul|aug|sept|sep|okt|oct|nov|dec';
const DAYS =
  'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const DAY_ABBR = 'ma|di|wo|do|vr|za|zo|mon|tue|wed|thu|fri|sat|sun';
const UNIT = '(?:uur|u|h|hrs?|hours?|min(?:uten|utes)?|dagen|dag|days?|d)';
const NUM = '\\d+(?:[.,]\\d+)?';

const EVERYWHERE: [string, RegExp][] = [
  ['eta', /\bETA\b/i],
  ['aankomst', /aankomst/i],
  ['arrive', /arriv/i],
  ['bereikt-om', /bereikt\b.*\bom\b/i],
  ['verwacht-om', /verwacht\s+om\b/i],
  ['expected-at', /expected\s+at\b/i],
];

const TRAVEL_ROW: [string, RegExp][] = [
  ['clock', /\b\d{1,2}:\d{2}\b/],
  ['day-month', new RegExp(`\\b\\d{1,2}\\.?\\s*(?:${MONTHS})\\b|\\b(?:${MONTHS})\\.?\\s+\\d{1,2}\\b(?!\\d)`, 'i')],
  ['iso-date', /\b\d{4}-\d{2}-\d{2}\b/],
  ['weekday', new RegExp(`\\b(?:${DAYS})\\b|\\b(?:${DAY_ABBR})\\.?\\s+\\d`, 'i')],
  ['countdown', new RegExp(`\\b(?:over|in)\\s+${NUM}\\s*${UNIT}\\b|\\bnog\\s+${NUM}`, 'i')],
];

export function scanEta(items: readonly EtaItem[]): EtaViolation[] {
  const out: EtaViolation[] = [];
  for (const { where, text, travelRow } of items) {
    const rules = EVERYWHERE.filter(([, re]) => re.test(text)).map(([r]) => r);
    if (travelRow) {
      for (const [r, re] of TRAVEL_ROW) if (re.test(text)) rules.push(r);
      if (/\d/.test(text) && !/indicatief|indicative/i.test(text)) rules.push('not-indicative');
    }
    for (const rule of rules) out.push({ where, rule });
  }
  return out;
}
