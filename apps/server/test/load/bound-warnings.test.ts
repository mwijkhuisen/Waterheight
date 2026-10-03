import { emptyNormalised, type Normalised, type WarningRow } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { boundWarnings, RETAINED, WARNING_BYTES } from '../../src/load/pipeline.ts';

// P7a review SR-2: a warning row keeps its level whatever the size of its geometry or texts; an oversized field is
// left out and counted under a RETAINED code, so a size CHECK never fails a flood warning's transaction.

const row = (over: Partial<WarningRow> = {}): WarningRow => ({
  area_key: 'Moselle',
  name: 'Moselle',
  geometry: '{"type":"Polygon","coordinates":[]}',
  level: 4,
  level_raw: 'ALERT_LVL_2',
  label_raw: null,
  texts: { de: { headline: 'Hochwasser' } },
  valid_from: '2026-02-13T08:56:31.000Z',
  valid_to: null,
  issued_at: null,
  ...over,
});
const of = (rows: WarningRow[]): Normalised => ({
  ...emptyNormalised(),
  warnings: { mode: 'message', sent: '2026-02-13T08:56:31.000Z', rows, cancels: [] },
});

describe('boundWarnings', () => {
  it('leaves a row within the bounds as it is', () => {
    const n = of([row()]);
    boundWarnings(n);
    expect(n.warnings?.rows).toEqual([row()]);
    expect(n.dropped).toEqual({});
  });

  it('a geometry over 2 MiB and texts over the column bound are left out, counted and retained; the level stays', () => {
    const big = `"${'x'.repeat(WARNING_BYTES.geometry)}"`;
    const long = { de: { description: 'é'.repeat(WARNING_BYTES.texts / 2) } };
    const n = of([row({ geometry: big }), row({ area_key: 'Sud', texts: long }), row({ area_key: 'Nord' })]);
    boundWarnings(n);
    expect(n.warnings?.rows.map((r) => [r.area_key, r.level, r.geometry === null, r.texts === undefined])).toEqual([
      ['Moselle', 4, true, false],
      ['Sud', 4, false, true],
      ['Nord', 4, false, false],
    ]);
    expect(n.dropped).toEqual({ geometry_too_big: 1, texts_too_big: 1 });
    expect(RETAINED).toEqual(expect.arrayContaining(['geometry_too_big', 'texts_too_big']));
    // The bound leaves room for PostgreSQL's own jsonb rendering under the 65,536-byte CHECK.
    expect(WARNING_BYTES.texts).toBeLessThan(65_536 - 1024);
  });
});
