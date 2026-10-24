import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CHANNELS, defaultChannels, validateRegistry } from '../packages/contracts/src/registry.ts';
import { attributionCellText, readPermissionRecords, repoRoot, strip, table08 } from './catalogue.ts';

// P12b, E4: docs/launch-checklist.md. Its tables (a) and (c) must equal the registry, so the owner signs what is
// really configured. The §1b texts, the channel defaults and the permission records are tested at their own places
// (packages/contracts/test/registry.test.ts); this adds the checklist's own rows, the channel width, the logo rule,
// the registry state the C-fallbacks lead to, the age of the private bases and the absence of owner data from what
// the launch phase publishes. Offline.

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const LAUNCH_DAY = '2026-12-04';
const MAX_BASIS_AGE_MONTHS = 12;

const providersInput = parse(read('registry/providers.yaml'));
const sourcesInput = parse(read('registry/sources.yaml')) as { sources: Record<string, unknown>[] };
const permissionRecords = readPermissionRecords(parse);
const registry = validateRegistry(providersInput, sourcesInput, { permissionRecords, today: LAUNCH_DAY });
const real = registry.sources.filter((s) => s.canary !== true);
const byId = new Map(real.map((s) => [s.id, s]));
const publicSources = real.filter((s) => s.audience === 'public');
const ownerSources = real.filter((s) => s.audience === 'owner');

const doc = read('docs/launch-checklist.md');

/** The rows of the markdown table under a heading: cell lists, without the header and separator. */
function docTable(heading: string): string[][] {
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`launch checklist: no heading "${heading}"`);
  const rows: string[][] = [];
  for (const line of doc.slice(start + heading.length).split('\n')) {
    if (line.startsWith('#') && rows.length > 0) break;
    if (!line.startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    rows.push(
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replaceAll('\\|', '|')),
    );
  }
  return rows.slice(2);
}

const flags = (s: { display: boolean; api: boolean; bulk_export: boolean; history_export: boolean }) =>
  `${s.display ? 'D' : '-'}${s.api ? 'A' : '-'}${s.bulk_export ? 'B' : '-'}${s.history_export ? 'H' : '-'}`;

describe('the registry the checklist describes', () => {
  it('validates', () => {
    expect(registry.problems).toEqual([]);
  });
});

describe('table (a): public sources', () => {
  const rows = docTable('### (a) Public sources');

  it('lists exactly the public sources, once each', () => {
    expect(rows.map((r) => r[0]).sort()).toEqual(publicSources.map((s) => s.id).sort());
  });

  it('has the licence, the exact §1b attribution and the channels of the registry', () => {
    for (const [id, licence, attribution, channels] of rows) {
      const s = byId.get(id ?? '');
      expect(s, id).toBeDefined();
      expect([id, licence]).toEqual([id, s?.licence_kind]);
      expect([id, attribution]).toEqual([id, s?.attribution_text]);
      expect([id, channels]).toEqual([id, s ? flags(s) : undefined]);
      // The row text is the §1b text (the registry test holds the registry to the same cell).
      expect([id, attributionCellText(id ?? '').includes(attribution ?? '')]).toEqual([id, true]);
    }
  });

  it('has no channel wider than the §0.7 default or the permission record of its source', () => {
    for (const s of publicSources) {
      const defaults = defaultChannels(s);
      const record = permissionRecords.get(s.id) as Record<string, unknown> | null | undefined;
      for (const c of CHANNELS) {
        if (!s[c] || defaults[c]) continue;
        expect([s.id, c, record?.[c] === true]).toEqual([s.id, c, true]);
      }
    }
  });

  it('carries no logo: FR-3, FR-4 and FR-5 forbid it, and no public attribution mentions one', () => {
    for (const id of ['FR-3', 'FR-4', 'FR-5']) expect([id, byId.get(id)?.logo_allowed]).toEqual([id, false]);
    for (const s of publicSources) {
      const texts = [s.attribution_text, s.attribution_url, ...s.attribution_variants.map((v) => v.text)];
      for (const t of texts) expect([s.id, /logo/i.test(t ?? '')]).toEqual([s.id, false]);
    }
    for (const [, , attribution] of rows) expect(/logo/i.test(attribution ?? '')).toBe(false);
  });
});

describe('table (c): owner sources', () => {
  const rows = docTable('### (c) Owner-audience sources');

  it('lists exactly the owner sources with their §0.8 row and retrieval date', () => {
    expect(rows.map((r) => r[0]).sort()).toEqual(ownerSources.map((s) => s.id).sort());
    expect(ownerSources.length).toBeGreaterThan(0);
    for (const [id, clause, retrieved] of rows) {
      const s = byId.get(id ?? '');
      const row = table08.get(id ?? '');
      expect([id, row !== undefined]).toEqual([id, true]);
      expect([id, clause]).toEqual([id, `§0.8 ${strip(row?.[0] ?? '')}`]);
      expect([id, retrieved]).toEqual([id, s?.private_basis?.retrieved]);
    }
  });

  it(`has a private_basis retrieved at most ${MAX_BASIS_AGE_MONTHS} months before ${LAUNCH_DAY}`, () => {
    const [y = 0, m = 0, d = 0] = LAUNCH_DAY.split('-').map(Number);
    const oldest = new Date(Date.UTC(y, m - 1 - MAX_BASIS_AGE_MONTHS, d)).toISOString().slice(0, 10);
    for (const s of ownerSources) {
      expect([s.id, s.private_basis !== null]).toEqual([s.id, true]);
      const retrieved = s.private_basis?.retrieved ?? '';
      expect([s.id, retrieved >= oldest, retrieved <= LAUNCH_DAY]).toEqual([s.id, true, true]);
    }
  });
});

describe('table (d): the new NL-1 specs (roadmap 2 release addendum, E6)', () => {
  const rows = docTable('### (d) New NL-1 specs');
  const nl1 = byId.get('NL-1');
  const specs = (parse(read('registry/capture.yaml')) as { specs: { id: string; source: string }[] }).specs;
  /** The NL-1 specs of roadmap 1; any other nl-1-* spec must be in table (d), so a new one forces an update. */
  const ROADMAP1_NL1 = [
    'nl-1-fc-1h',
    'nl-1-fc-3h-0',
    'nl-1-fc-3h-1',
    'nl-1-fc-3h-2',
    'nl-1-obs-key',
    'nl-1-obs-other',
    'nl-1-obs-twin',
    'nl-1-catalogue',
  ];

  it('has a row per new NL-1 spec, with the source, audience, channels and licence of NL-1', () => {
    expect(rows).toHaveLength(9);
    for (const [spec, source, , , audience, channels, licence] of rows) {
      const entry = specs.find((x) => x.id === spec);
      expect([spec, entry?.source]).toEqual([spec, 'NL-1']);
      expect([spec, source]).toEqual([spec, nl1?.id]);
      expect([spec, audience]).toEqual([spec, nl1?.audience]);
      expect([spec, channels]).toEqual([spec, nl1 ? flags(nl1) : undefined]);
      expect([spec, licence]).toEqual([spec, nl1?.licence_kind]);
    }
    expect([nl1?.audience, nl1 ? flags(nl1) : '', nl1?.licence_kind]).toEqual(['public', 'DABH', 'cc0']);
  });

  it('covers every nl-1-* spec of the registry: roadmap 1 (ROADMAP1_NL1) or a row', () => {
    const ids = specs.map((x) => x.id).filter((id) => id.startsWith('nl-1-'));
    const listed = new Set([...ROADMAP1_NL1, ...rows.map((r) => r[0] ?? '')]);
    expect(ids.filter((id) => !listed.has(id))).toEqual([]);
    expect([...listed].filter((id) => !ids.includes(id))).toEqual([]);
  });
});

describe('the registry state the C-fallbacks lead to (docs/permissions.md C13, C4, C5, C11 and C12)', () => {
  it('silence: CH-1 to CH-5 public with no record, DE-9/10/12/13 and BE-1/2 off, LU-1 withholding two gauges', () => {
    for (const id of ['CH-1', 'CH-2', 'CH-4', 'CH-5']) {
      expect([id, byId.get(id)?.audience, permissionRecords.has(id)]).toEqual([id, 'public', false]);
    }
    for (const id of ['DE-9', 'DE-10', 'DE-12', 'DE-13', 'BE-1', 'BE-2']) {
      expect([id, byId.get(id)?.audience, byId.get(id)?.capture_enabled]).toEqual([id, 'off', false]);
    }
    const lu1 = registry.withholdings.find((w) => w.source === 'LU-1');
    expect(lu1?.withheld).toEqual(['Bollendorf', 'Gemünd_Our']);
  });

  /** A copy of sources.yaml in which BAFU objected to public use of CH-2, CH-4 and CH-5 (C13), with its record. */
  function objection(withRecords: boolean) {
    const copy = structuredClone(sourcesInput);
    const records = new Map(permissionRecords);
    for (const id of ['CH-2', 'CH-4', 'CH-5']) {
      const s = copy.sources.find((x) => x.id === id);
      if (s === undefined) throw new Error(`no source ${id}`);
      s.audience = 'owner';
      s.private_basis = {
        clause: strip(table08.get(id)?.[2] ?? ''),
        url: 'https://www.bafu.admin.ch/dam/de/sd-web/g7vjiKP5LJ11/liefer-nutzungsbedingungen-hydrologische-daten.pdf',
        retrieved: '2026-09-23',
      };
      // Owner channels are display, api and history_export: the ch-open-use sources lose bulk_export.
      s.bulk_export = false;
      if (withRecords)
        records.set(id, {
          source: id,
          granted_by: 'Test fixture: BAFU objection to public use',
          granted_on: '2026-11-07',
          evidence: "fixture: e-mail of 2026-11-07, owner's mail archive",
          audience: 'owner',
          display: true,
          api: true,
          bulk_export: false,
          history_export: true,
        });
    }
    return validateRegistry(providersInput, copy, { permissionRecords: records, today: LAUNCH_DAY });
  }

  it('objection: CH-2, CH-4 and CH-5 become owner with a record and still validate, CH-1 stays public', () => {
    const result = objection(true);
    expect(result.problems).toEqual([]);
    const by = new Map(result.sources.map((s) => [s.id, s]));
    for (const id of ['CH-2', 'CH-4', 'CH-5']) expect([id, by.get(id)?.audience]).toEqual([id, 'owner']);
    for (const id of ['CH-1', 'CH-3']) expect([id, by.get(id)?.audience]).toEqual([id, 'public']);
  });

  it('objection without its record is refused (a narrowing is a reviewed change too)', () => {
    expect(objection(false).problems.join('\n')).toContain('audience owner differs from public without');
  });
});

describe('owner absence from what the launch phase publishes', () => {
  const ownerIds = real.concat(registry.sources.filter((s) => s.canary === true)).filter((s) => s.audience === 'owner');
  const pageFiles = ['en', 'nl'].flatMap((lang) =>
    readdirSync(join(repoRoot, `apps/web/src/features/pages/content/${lang}`))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => `apps/web/src/features/pages/content/${lang}/${f}`),
  );
  /** The security headers of the public site block (site.caddy: the CSP and its siblings). */
  const headers = /\n\theader \{\n([\s\S]*?)\n\t\}/.exec(read('deploy/web/site.caddy'))?.[1] ?? '';

  const subjects: [string, string][] = [
    ['deploy/web/phase-launch.caddy (robots.txt, sitemap)', read('deploy/web/phase-launch.caddy')],
    ['the header block of deploy/web/site.caddy', headers],
    ...pageFiles.map((f): [string, string] => [f, read(f)]),
  ];

  it('has the headers block and both languages of the privacy and sources pages', () => {
    expect(headers).toContain('Content-Security-Policy');
    for (const lang of ['en', 'nl']) {
      expect(pageFiles).toContain(`apps/web/src/features/pages/content/${lang}/Privacy.tsx`);
      expect(pageFiles).toContain(`apps/web/src/features/pages/content/${lang}/Sources.tsx`);
    }
    expect(ownerIds.length).toBeGreaterThan(5);
  });

  it.each(subjects)('%s names no owner source and no owner hostname', (_name, text) => {
    for (const s of ownerIds) expect([s.id, new RegExp(`\\b${s.id}\\b`).test(text)]).toEqual([s.id, false]);
    expect(/\bowner\.[a-z{$]/i.test(text)).toBe(false);
  });
});

describe('docs/launch-checklist.md itself', () => {
  it('ships unsigned: no ticked box', () => {
    expect(doc).toMatch(/- \[ \] /);
    expect(doc).not.toMatch(/\[[xX]\]/);
  });

  it('has the E1 to E7 lines', () => {
    for (const e of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'])
      expect(doc, e).toMatch(new RegExp(`\\*\\*${e}\\*\\*|\\(${e}\\)`));
  });

  it('links the tracker instead of repeating it', () => {
    expect(doc).toContain('(permissions.md)');
    expect(doc).not.toMatch(/\| C\d+ \|/);
  });

  it('names the proofs of the issue, and every repository path it names exists', () => {
    for (const p of [
      'scripts/flood-drill',
      'docs/capacity.md',
      'docs/drills/rebuild-timing-sheet.md',
      'deploy/tests/alert-drill.sh',
      'docs/ops/alert-tuning.md',
      'deploy/tests/hardening.sh',
      '.github/workflows/loadtest.yml',
      'docs/security/launch-verdict.md',
      'scripts/verify-owner.sh',
      'deploy/tests/rebuild-check.sh',
      '--profile launch',
      'wg show',
      'owner listener',
      'rws-restore-drill',
    ])
      expect(doc, p).toContain(p);
    // Not yet in the tree on purpose: the DE-2 grant is recorded at the flip, from the template.
    const later = new Set(['registry/permissions/DE-2.md']);
    const named = [...doc.matchAll(/`((?:scripts|deploy|docs|\.github|registry|packages|apps|test)\/[\w./-]+)`/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length).toBeGreaterThan(10);
    for (const p of named) expect([p, later.has(p) || existsSync(join(repoRoot, p))]).toEqual([p, true]);
    // Markdown links resolve from docs/.
    for (const [, href] of doc.matchAll(/\]\(([^)#]+?)(?:#[^)]*)?\)/g)) {
      if (!href || href.startsWith('http')) continue;
      expect([href, existsSync(join(repoRoot, 'docs', href))]).toEqual([href, true]);
    }
  });
});
