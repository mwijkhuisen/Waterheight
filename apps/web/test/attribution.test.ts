import { describe, expect, it } from 'vitest';
import { attributionText } from '../src/lib/attribution.ts';
import { formatDay, ZONE } from '../src/lib/time/time.ts';

// The date duty of the attributions (review SR-1): Etalab (FR-1, FR-3) and BAFU (CH-1, CH-3) ask for a date; the
// footer gives the date of the instant the page shows, in place of the registry's placeholder or after the text.

const DATE = '26 oktober 2026';

describe('attributionText', () => {
  it('replaces each registry placeholder with the date: FR-3, and CH-1 in German, English and Dutch', () => {
    expect(
      attributionText(
        'Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0',
        true,
        DATE,
      ),
    ).toBe('Source : © VIGICRUES – www.vigicrues.gouv.fr, 26 oktober 2026, Licence Ouverte Etalab 2.0');
    expect(
      attributionText(
        'Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum)',
        true,
        DATE,
      ),
    ).toBe('Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (26 oktober 2026)');
    expect(attributionText('Swiss river data (raw, unverified data; retrieved <date>)', true, DATE)).toBe(
      'Swiss river data (raw, unverified data; retrieved 26 oktober 2026)',
    );
    expect(attributionText('Zwitserse riviergegevens (opgehaald <datum>)', true, DATE)).toBe(
      'Zwitserse riviergegevens (opgehaald 26 oktober 2026)',
    );
  });

  it('appends the date to a text without a placeholder (FR-1), and leaves a text without the duty as it is', () => {
    expect(attributionText("Données hydrométriques : Hub'Eau / SCV", true, DATE)).toBe(
      "Données hydrométriques : Hub'Eau / SCV (26 oktober 2026)",
    );
    expect(attributionText('Bron: Rijkswaterstaat <datum>', false, DATE)).toBe('Bron: Rijkswaterstaat <datum>');
  });

  it('takes the date as text: a `$` pattern in it is never a replacement pattern', () => {
    expect(attributionText('retrieved <date>', true, "$& $' $1")).toBe("retrieved $& $' $1");
  });
});

describe('formatDay in the Amsterdam zone (the attribution date)', () => {
  it('is the Amsterdam day of the instant, in the page language', () => {
    // 23:30Z on 25 October is already 26 October in Amsterdam (00:30 CET).
    const ms = Date.parse('2026-10-25T23:30:00Z');
    expect(formatDay(ms, 'nl', ZONE)).toBe('26 oktober 2026');
    expect(formatDay(ms, 'en', ZONE)).toBe('26 October 2026');
    expect(formatDay(ms, 'nl')).toBe('25 oktober 2026');
  });
});
