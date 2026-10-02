import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  attributionCellText,
  readPermissionRecords,
  repoRoot,
  strip,
  table1a,
  table1b,
  table08,
} from '../../../test/catalogue.ts';
import { BASELINE } from '../src/baseline.ts';
import { CHANNELS, defaultChannels, type Source, validateRegistry } from '../src/registry.ts';

const read = (file: string) => readFileSync(`${repoRoot}registry/${file}`, 'utf8');
const permissionRecords = readPermissionRecords(parse);
const today = new Date().toISOString().slice(0, 10);
const rawSources = read('sources.yaml');
const providersInput = parse(read('providers.yaml'));
const sourcesInput = parse(rawSources) as { sources: Record<string, unknown>[] };
const registry = validateRegistry(providersInput, sourcesInput, { permissionRecords, today });
const sources = registry.sources;
const byId = new Map(sources.map((s) => [s.id, s]));
const real = sources.filter((s) => s.canary !== true);

/** Validate a copy of sources.yaml with one source changed. */
function problemsWith(
  id: string,
  change: (s: Record<string, unknown>) => void,
  records: ReadonlyMap<string, unknown> = permissionRecords,
) {
  const copy = structuredClone(sourcesInput);
  const target = copy.sources.find((s) => s.id === id);
  if (target === undefined) throw new Error(`no source ${id}`);
  change(target);
  return validateRegistry(providersInput, copy, { permissionRecords: records, today }).problems.join('\n');
}

/** A well-formed permission record (front matter of registry/permissions/<ID>.md). */
const grant = (source: string, over: Record<string, unknown> = {}) =>
  new Map<string, unknown>([
    [
      source,
      {
        source,
        granted_by: 'Test provider',
        granted_on: '2026-09-01',
        evidence: "e-mail of 2026-09-01, owner's mail archive",
        audience: 'public',
        display: true,
        api: false,
        bulk_export: false,
        history_export: false,
        ...over,
      },
    ],
  ]);

// Initial audiences (catalogue §0.8; ADR-0017; issue #15). A change needs a
// registry/permissions/<ID>.md record (invariant 8).
const OWNER = ['BE-3', 'LU-2', 'LU-3', 'LU-4', 'DE-2', 'DE-3'];
const PUBLIC = [
  ...['NL-1', 'NL-2', 'NL-4', 'DE-1', 'DE-6', 'DE-7', 'DE-8', 'FR-1', 'FR-3', 'FR-4', 'FR-5'],
  ...['LU-1', 'LU-5', 'LU-6', 'CH-1', 'CH-2', 'CH-3', 'CH-4', 'CH-5'],
];
const PERMISSION_BASED = ['BE-1', 'DE-9', 'DE-10', 'DE-12', 'DE-13'];

describe('registry', () => {
  it('validates with no problem', () => {
    expect(registry.problems).toEqual([]);
    expect(sources.length).toBeGreaterThan(0);
  });

  it('lists every §1a source ID exactly once (canaries aside)', () => {
    expect(real.map((s) => s.id).sort()).toEqual([...table1a.keys()].sort());
    expect(real).toHaveLength(52);
  });

  it('gives every source its initial audience unless a permission record exists', () => {
    for (const s of real) {
      const expected = OWNER.includes(s.id) ? 'owner' : PUBLIC.includes(s.id) ? 'public' : 'off';
      if (!permissionRecords.has(s.id)) expect([s.id, s.audience]).toEqual([s.id, expected]);
    }
    for (const id of ['NL-3', 'DE-9', 'DE-10', 'DE-12', 'BE-1', 'BE-2']) expect(byId.get(id)?.audience).toBe('off');
    for (const id of ['CH-2', 'CH-4', 'CH-5']) expect(byId.get(id)?.audience).toBe('public');
  });

  it('keeps no publication key and no dark value', () => {
    expect(rawSources).not.toMatch(/\bpublication\s*:/);
    expect(rawSources).not.toMatch(/:\s*["']?dark["']?\s*$/m);
  });

  it('captures exactly the sources that are not off', () => {
    for (const s of sources) expect([s.id, s.capture_enabled]).toEqual([s.id, s.audience !== 'off']);
  });

  it('narrows the LfU RLP-origin series on the AGE site to off', () => {
    const offKeys = (id: string) =>
      byId
        .get(id)
        ?.series.filter((o) => o.audience === 'off')
        .map((o) => o.key);
    expect(offKeys('LU-1')).toEqual(['bollendorf', 'gemund-our']);
    expect(offKeys('LU-2')).toEqual(['bollendorf', 'gemund-our']);
    expect(offKeys('LU-3')).toEqual(['perl', 'stadtbredimus', 'wasserbillig']);
  });

  it('has one owner canary source and one withheld canary series on a public source', () => {
    const canaries = sources.filter((s) => s.canary === true);
    expect(canaries.map((s) => [s.id, s.audience])).toEqual([['CANARY-OWNER', 'owner']]);
    const series = sources.flatMap((s) =>
      s.series.filter((o) => o.canary === true).map((o) => [s.audience, o.audience]),
    );
    expect(series).toEqual([['public', 'off']]);
  });
});

describe('attribution and licence text (catalogue §1b)', () => {
  it('copies every attribution text verbatim from its §1b attribution cell', () => {
    for (const s of real) {
      const row = attributionCellText(s.id);
      for (const text of [s.attribution_text, ...s.attribution_variants.map((v) => v.text)]) {
        if (text !== null) expect([s.id, row.includes(text)]).toEqual([s.id, true]);
      }
    }
  });

  it.each([
    [
      'NL-1',
      'Waterstanden en afvoeren: Rijkswaterstaat – WaterWebservices (CC0), https://rijkswaterstaatdata.nl/waterdata/',
    ],
    [
      'DE-1',
      'Pegeldaten: WSV/GDWS via PEGELONLINE (pegelonline.wsv.de), Datenlizenz Deutschland – Zero – Version 2.0 (https://www.govdata.de/dl-de/zero-2-0). Ungeprüfte Rohdaten.',
    ],
    ['DE-6', 'Datenquelle: www.hochwasserzentralen.de'],
    [
      'BE-1',
      'Flanders Hydraulics Research. Measurements and forecasts from the database of the Hydrological Information Centre [DATA]. [date of retrieval: dd/mm/jjjj].',
    ],
    ['FR-3', 'Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0'],
    ['CH-1', 'Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum)'],
  ])('%s credit is exact', (id, text) => {
    expect(byId.get(id)?.attribution_text).toBe(text);
  });

  it('marks Suggested and Courtesy credits as not required', () => {
    for (const s of real) {
      const cell = strip(table1b.get(s.id)?.[2] ?? '');
      if (/^(Suggested|Courtesy):/.test(cell)) expect([s.id, s.attribution_required]).toEqual([s.id, false]);
    }
  });

  it('forbids the Vigicrues logo and says nothing about other logos', () => {
    for (const s of real) {
      const expected = s.provider === 'vigicrues' ? false : null;
      expect([s.id, s.logo_allowed]).toEqual([s.id, expected]);
    }
  });

  it('copies the licence cell verbatim, null only where §1b has none', () => {
    for (const s of real) {
      const cell = strip(table1b.get(s.id)?.[1] ?? '');
      expect([s.id, s.licence_text]).toEqual([s.id, cell === '–' ? null : cell]);
    }
  });
});

describe('private_basis (catalogue §0.8)', () => {
  it('is present on exactly the owner sources, and quotes their §0.8 row verbatim', () => {
    for (const s of real) {
      if (s.audience !== 'owner') {
        expect([s.id, s.private_basis]).toEqual([s.id, null]);
        continue;
      }
      const row = table08.get(s.id);
      expect([s.id, row !== undefined]).toEqual([s.id, true]);
      const [, terms = '', clause = ''] = row ?? [];
      expect(s.private_basis?.clause).toBe(strip(clause));
      expect(s.private_basis?.url.startsWith('https://')).toBe(true);
      expect(terms).toContain(s.private_basis?.url);
      expect(terms).toContain(s.private_basis?.retrieved);
    }
  });

  it.each([
    [
      'no private_basis on an owner source',
      (s: Record<string, unknown>) => (s.private_basis = null),
      /needs a private_basis/,
    ],
    [
      'an empty clause',
      (s: Record<string, unknown>) => ((s.private_basis as { clause: string }).clause = '  '),
      /clause/,
    ],
    [
      'a non-https url',
      (s: Record<string, unknown>) => ((s.private_basis as { url: string }).url = 'http://hydrometrie.wallonie.be/'),
      /url/,
    ],
    [
      'a missing retrieved date',
      (s: Record<string, unknown>) => delete (s.private_basis as { retrieved?: string }).retrieved,
      /retrieved/,
    ],
    [
      'a malformed retrieved date',
      (s: Record<string, unknown>) => ((s.private_basis as { retrieved: string }).retrieved = '23.09.2026'),
      /retrieved/,
    ],
  ])('fails with %s', (_, change, message) => {
    expect(problemsWith('BE-3', change)).toMatch(message);
  });

  it.each([
    ['NL-1', 'public'],
    ['DE-9', 'off'],
  ])('fails when %s (%s) carries a private_basis', (id) => {
    const basis = sourcesInput.sources.find((s) => s.id === 'BE-3')?.private_basis;
    expect(problemsWith(id, (s) => (s.private_basis = structuredClone(basis)))).toMatch(/only for the owner audience/);
  });
});

describe('licence channels (catalogue §0.7)', () => {
  it('carries the four channels and the attribution fields on every source', () => {
    for (const s of sourcesInput.sources) {
      for (const key of [
        ...CHANNELS,
        'attribution_text',
        'attribution_url',
        'needs_last_updated',
        'needs_retrieval_date',
      ]) {
        expect([s.id, key in s]).toEqual([s.id, true]);
      }
    }
  });

  it('marks exactly the written-permission sources as permission-based', () => {
    expect(real.filter((s) => s.permission_required).map((s) => s.id)).toEqual(
      expect.arrayContaining(PERMISSION_BASED),
    );
    expect(real.filter((s) => s.permission_required)).toHaveLength(PERMISSION_BASED.length);
  });

  it('matches the §0.7 defaults unless a permission record exists', () => {
    for (const s of sources) {
      if (!permissionRecords.has(s.id)) {
        expect([s.id, pickChannels(s)]).toEqual([s.id, defaultChannels(s)]);
      }
    }
  });

  it.each(['api', 'bulk_export', 'history_export'])('fails when a permission-based source has %s on', (channel) => {
    expect(problemsWith('DE-9', (s) => (s[channel] = true))).toMatch(/permission-based source/);
  });

  it('allows a channel that registry/permissions/<ID>.md grants', () => {
    expect(problemsWith('DE-9', (s) => (s.api = true), grant('DE-9', { audience: 'off', api: true }))).toBe('');
  });

  it('fails when the permission record does not grant the channel', () => {
    expect(problemsWith('DE-9', (s) => (s.api = true), grant('DE-9', { audience: 'off' }))).toMatch(
      /api is on, but its permission record does not grant it/,
    );
  });

  it('fails when an owner source has bulk_export on, even with a record', () => {
    expect(
      problemsWith('LU-3', (s) => (s.bulk_export = true), grant('LU-3', { audience: 'owner', bulk_export: true })),
    ).toMatch(/bulk_export off/);
  });

  it('fails closed on a missing channel flag', () => {
    expect(problemsWith('NL-1', (s) => delete s.display)).toMatch(/display/);
  });
});

describe('permission records and the baseline (invariant 8)', () => {
  it('fail when an audience widens without a record (DE-12 terms forbid even storage)', () => {
    expect(problemsWith('DE-12', (s) => Object.assign(s, { audience: 'public', capture_enabled: true }))).toMatch(
      /audience public differs from off without registry\/permissions\/DE-12\.md/,
    );
  });

  it('accept an audience a well-formed record grants', () => {
    // A permission-based source has history_export off, so a captured one declares its provider's window.
    const flip = (s: Record<string, unknown>) =>
      Object.assign(s, { audience: 'public', capture_enabled: true, history_window: 'P31D' });
    expect(problemsWith('DE-12', flip, grant('DE-12'))).toBe('');
  });

  it('fail when the source goes beyond the audience the record grants', () => {
    const flip = (s: Record<string, unknown>) => Object.assign(s, { audience: 'public', capture_enabled: true });
    expect(problemsWith('DE-12', flip, grant('DE-12', { audience: 'owner' }))).toMatch(
      /audience public exceeds the owner its permission record grants/,
    );
  });

  it.each([
    ['an empty record file', null, /not a valid permission record/],
    ['a record without evidence', { source: 'DE-12', granted_by: 'x', granted_on: '2026-09-01' }, /evidence/],
    ['a record for another source', grant('DE-9').get('DE-9'), /source is DE-9, expected DE-12/],
    ['a record dated in the future', grant('DE-12', { granted_on: '2999-01-01' }).get('DE-12'), /in the future/],
  ])('reject %s', (_, record, message) => {
    const flip = (s: Record<string, unknown>) => Object.assign(s, { audience: 'public', capture_enabled: true });
    const problems = problemsWith('DE-12', flip, new Map([['DE-12', record]]));
    expect(problems).toMatch(message);
    expect(problems).toMatch(/differs from off without/);
  });

  it('never accept a different licence kind, record or not', () => {
    const relabel = (s: Record<string, unknown>) => Object.assign(s, { licence_kind: 'cc0' });
    expect(problemsWith('NL-3', relabel, grant('NL-3', { audience: 'off' }))).toMatch(
      /licence_kind cc0 differs from the baseline unlicensed/,
    );
  });

  it('reject a source that is not in the baseline', () => {
    const copy = structuredClone(sourcesInput);
    copy.sources.push({ ...structuredClone(copy.sources[0]), id: 'NL-99' } as Record<string, unknown>);
    const { problems } = validateRegistry(providersInput, copy, { permissionRecords, today });
    expect(problems.join('\n')).toMatch(/NL-99: not in the approved baseline/);
  });

  it('holds exactly the initial audiences of issue #15', () => {
    for (const s of real) {
      const expected = OWNER.includes(s.id) ? 'owner' : PUBLIC.includes(s.id) ? 'public' : 'off';
      expect([s.id, BASELINE[s.id]?.audience]).toEqual([s.id, expected]);
    }
    expect(Object.keys(BASELINE).sort()).toEqual(sources.map((s) => s.id).sort());
  });
});

describe('withholding records (P5b: registry/permissions/LU-1.md)', () => {
  const withheld = (over: Record<string, unknown> = {}) =>
    new Map<string, unknown>([
      [
        'LU-1',
        {
          source: 'LU-1',
          withheld: ['Bollendorf'],
          audience: 'off',
          basis: 'Third-party gauge inside the CC0 file; until C4 or C11.',
          recorded_on: '2026-10-02',
          ...over,
        },
      ],
    ]);

  it('the committed LU-1 record is a withholding record of the two LfU RLP series, and validates', () => {
    expect(registry.withholdings).toEqual([
      expect.objectContaining({ source: 'LU-1', withheld: ['Bollendorf', 'Gemünd_Our'], audience: 'off' }),
    ]);
    expect(registry.problems).toEqual([]);
  });

  it('narrows only: it is no grant, so a widened audience or channel still fails', () => {
    expect(problemsWith('LU-1', () => undefined, withheld())).toBe('');
    expect(
      problemsWith('DE-12', (s) => Object.assign(s, { audience: 'public', capture_enabled: true }), withheld()),
    ).toMatch(/audience public differs from off without registry\/permissions\/DE-12\.md/);
    expect(
      problemsWith(
        'DE-9',
        (s) => (s.api = true),
        new Map([['DE-9', { ...(withheld().get('LU-1') as object), source: 'DE-9' }]]),
      ),
    ).toMatch(/permission-based source/);
  });

  it.each([
    ['another audience', { audience: 'owner' }, /not a valid permission record/],
    ['no series', { withheld: [] }, /not a valid permission record/],
    ['a future date', { recorded_on: '2999-01-01' }, /recorded_on 2999-01-01 is in the future/],
    ['another source', { source: 'LU-2' }, /source is LU-2, expected LU-1/],
  ])('fails with %s', (_, over, problem) => {
    expect(problemsWith('LU-1', () => undefined, withheld(over))).toMatch(problem);
  });
});

describe('history_window', () => {
  const missing = /history_export is off, so the source must declare its provider's history_window/;
  const withoutHistory = (s: Record<string, unknown>) => (s.history_export = false);

  it('is declared on no source today, because every captured source exports its history', () => {
    for (const s of sources) expect([s.id, s.history_window]).toEqual([s.id, undefined]);
    expect(sources.filter((s) => s.audience !== 'off').every((s) => s.history_export)).toBe(true);
  });

  it('is required on a captured source whose history_export is off', () => {
    expect(problemsWith('NL-1', withoutHistory)).toMatch(missing);
    expect(problemsWith('BE-3', withoutHistory)).toMatch(missing);
  });

  it('is satisfied by an ISO 8601 duration', () => {
    expect(
      problemsWith('NL-1', (s) => Object.assign(s, { history_export: false, history_window: 'P31D' })),
    ).not.toMatch(missing);
  });

  it('is not needed on a source that is not captured', () => {
    expect(problemsWith('DE-9', (s) => Object.assign(s, { history_export: false }))).not.toMatch(missing);
  });

  it.each(['31 days', '31D', 'P', '', 31])('rejects %j', (value) => {
    expect(problemsWith('NL-1', (s) => (s.history_window = value))).toMatch(/history_window/);
  });
});

describe('series overrides', () => {
  const addSeries = (id: string, series: object) => problemsWith(id, (s) => (s.series as object[]).push(series));

  it('fail when they widen the audience', () => {
    expect(addSeries('LU-2', { key: 'x', audience: 'public', reason: 'test' })).toMatch(
      /widens audience owner to public/,
    );
  });

  it('fail when they widen a channel', () => {
    expect(addSeries('LU-2', { key: 'x', bulk_export: true, reason: 'test' })).toMatch(/widens channel bulk_export/);
  });

  it('reject an unknown key', () => {
    expect(addSeries('NL-1', { key: 'x', audience: 'off', publication: 'dark', reason: 'test' })).toMatch(
      /publication/,
    );
  });

  it('may narrow', () => {
    expect(addSeries('NL-1', { key: 'x', audience: 'owner', api: false, reason: 'test' })).toBe('');
  });
});

function pickChannels(s: Source) {
  return Object.fromEntries(CHANNELS.map((c) => [c, s[c]]));
}
