import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BASELINE } from '../packages/contracts/src/baseline.ts';
import { repoRoot } from './catalogue.ts';

const read = (path: string) => readFileSync(`${repoRoot}${path}`, 'utf8');

const phases = read('docs/plan/PHASES.md');
const catalogue = read('docs/sources/SOURCE-CATALOGUE.md');
const permissions = read('docs/permissions.md');
const providersYaml = read('registry/providers.yaml');
const DRAFTS = [
  'docs/legal/requests/c14-rws-roadmap-2.md',
  'docs/legal/requests/e7-rws-roadmap-2-live.md',
  'docs/legal/requests/c15-umbrella.md',
  'docs/legal/requests/c16-c36-water-boards.md',
];

/** Text of a section from its heading line up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const i = text.indexOf(`\n${heading}\n`);
  if (i < 0) throw new Error(`heading not found: ${heading}`);
  const level = heading.match(/^#+/)?.[0].length ?? 1;
  const rest = text.slice(i + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => `${prefix}${from + k}`);

/** The first cells of the table rows of a text. */
const rowIds = (text: string) => new Set([...text.matchAll(/^\| ([A-Z]+\d+) \|/gm)].map((m) => m[1] as string));

const AMENDMENT = '## 54. Amendment: roadmap 2 (all Dutch waters)';

describe('roadmap 2 amendment', () => {
  it('PHASES has one roadmap 2 amendment holding P15 to P21 once each', () => {
    const titles = [...phases.matchAll(/^## \d+\. Amendment: roadmap 2 \(all Dutch waters\)/gm)];
    expect(titles).toHaveLength(1);
    const start = phases.indexOf(AMENDMENT);
    expect(start).toBeGreaterThan(0);
    const rest = phases.slice(start + 3);
    const next = rest.search(/\n## /);
    const body = next < 0 ? rest : rest.slice(0, next);
    for (const p of range('P', 15, 21)) {
      expect([...body.matchAll(new RegExp(`^### ${p}\\b`, 'gm'))], p).toHaveLength(1);
    }
  });

  it('the decision and action tables hold the new rows', () => {
    const decisions = rowIds(section(phases, '### 6.1 Decisions'));
    for (const id of range('D', 24, 32)) expect(decisions.has(id), id).toBe(true);
    const actions = rowIds(section(phases, '### 6.2 Actions'));
    for (const id of ['A9', ...range('C', 14, 36), 'D9', 'D10', 'E6', 'E7']) {
      expect(actions.has(id), id).toBe(true);
    }
  });

  it('every permission request C14 to C36 is tracked and links an existing draft', () => {
    const rows = new Map(
      permissions
        .split('\n')
        .filter((l) => /^\| C\d+ \|/.test(l))
        .map((l) => [l.split('|')[1]?.trim() as string, l]),
    );
    for (const id of range('C', 14, 36)) {
      const row = rows.get(id);
      expect(row, id).toBeDefined();
      const link = (row as string).match(/\]\((legal\/requests\/[^)#]+)\)/);
      expect(link, `${id} draft link`).not.toBeNull();
      expect(existsSync(`${repoRoot}docs/${link?.[1]}`), id).toBe(true);
    }
  });
});

describe('water-board sources', () => {
  const s28 = section(catalogue, '### 2.8 Dutch water boards');
  const ids = [...s28.matchAll(/^\| (NL-\d+) \(/gm)].map((m) => m[1] as string);
  const registry = parse(read('registry/sources.yaml')) as {
    sources: Record<string, unknown>[];
  };
  const providers = new Set((parse(providersYaml) as { providers: { id: string }[] }).providers.map((p) => p.id));
  const capture = parse(read('registry/capture.yaml')) as {
    hosts: Record<string, unknown>;
    specs: { source: string }[];
  };

  it('catalogue 2.8 lists exactly NL-5 and NL-7 to NL-26', () => {
    expect([...ids].sort()).toEqual(['NL-5', ...range('NL-', 7, 26)].sort());
    expect(ids).toHaveLength(21);
  });

  it('each is off, closed on every channel, has a provider and a baseline, and is never fetched', () => {
    for (const id of ids) {
      const src = registry.sources.find((x) => x.id === id);
      expect(src, id).toBeDefined();
      expect(src).toMatchObject({
        audience: 'off',
        capture_enabled: false,
        display: false,
        api: false,
        bulk_export: false,
        history_export: false,
      });
      expect(providers.has(src?.provider as string), `${id} provider`).toBe(true);
      expect(Object.hasOwn(BASELINE, id), `${id} baseline`).toBe(true);
      expect(
        capture.specs.some((x) => x.source === id),
        `${id} spec`,
      ).toBe(false);
      expect(Object.hasOwn(capture.hosts, id), `${id} hosts`).toBe(false);
    }
  });
});

/** Functional role addresses only (#62): never a person. Sorted. */
const ALLOWED = [
  // C1 to C13, already in docs/permissions.md and registry/providers.yaml (pinned by C1_C13 below)
  'HWVZ@nlwkn.niedersachsen.de',
  'Pegelinfo@lubw.bwl.de',
  'abfragezentrale@bafu.admin.ch',
  // C14 to C36
  'datastromen@hetwaterschapshuis.nl',
  'gis_info@hunzeenaas.nl',
  // C1 to C13
  'hic@vlaanderen.be',
  'hydrologie@bafu.admin.ch',
  'hydrometrie@eau.etat.lu',
  'hydrometrie@spw.wallonie.be',
  'hydrometrie@waterinfo.be',
  // C14 to C36
  'info@aaenmaas.nl',
  'info@dommel.nl',
  'info@hhsk.nl',
  'info@noorderzijlvest.nl',
  'info@scheldestromen.nl',
  'info@uvw.nl',
  'info@vallei-veluwe.nl',
  'info@vechtstromen.nl',
  'info@wdodelta.nl',
  'info@wrij.nl',
  'info@wshd.nl',
  'info@wsrl.nl',
  'loket@hhdelfland.nl',
  'post@hdsr.nl',
  // C1 to C13
  'poststelle@lfu.rlp.de',
  // C14 to C36
  'servicedesk@hetwaterschapshuis.nl',
  // C1 to C13
  'vorhersage@bafg.de',
  // C14 to C36
  'waterschap@zuiderzeeland.nl',
];

const C1_C13 = [
  'HWVZ@nlwkn.niedersachsen.de',
  'Pegelinfo@lubw.bwl.de',
  'abfragezentrale@bafu.admin.ch',
  'hic@vlaanderen.be',
  'hydrologie@bafu.admin.ch',
  'hydrometrie@eau.etat.lu',
  'hydrometrie@spw.wallonie.be',
  'hydrometrie@waterinfo.be',
  'poststelle@lfu.rlp.de',
  'vorhersage@bafg.de',
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const strangers = (text: string) => [...text.matchAll(EMAIL)].map((m) => m[0]).filter((a) => !ALLOWED.includes(a));

describe('e-mail allowlist', () => {
  it('holds the 18 functional addresses of #62 and the 10 of C1 to C13', () => {
    expect(ALLOWED).toHaveLength(28);
  });

  it('each of the 10 C1 to C13 addresses is a real contact: in a c1 to c13 draft or providers.yaml', () => {
    const drafts = readdirSync(`${repoRoot}docs/legal/requests`).filter((f) => {
      const n = f.match(/^c(\d+)-/)?.[1];
      return n !== undefined && Number(n) <= 13;
    });
    expect(drafts.length).toBeGreaterThan(0);
    const known = [providersYaml, ...drafts.map((f) => read(`docs/legal/requests/${f}`))].join('\n');
    for (const a of C1_C13) {
      expect(ALLOWED.includes(a), `${a} allowed`).toBe(true);
      expect(known.includes(a), `${a} in a draft or providers.yaml`).toBe(true);
    }
  });

  it('the drafts, tracker, providers, catalogue 0.2 and 2.8, PHASES 6.2 and 54 and ADR-0022 hold only allowed addresses', () => {
    const texts: Record<string, string> = {
      'docs/permissions.md': permissions,
      'registry/providers.yaml': providersYaml,
      'catalogue 2.8': section(catalogue, '### 2.8 Dutch water boards'),
      'catalogue 0.2': section(catalogue, '### 0.2 Licence gates: act in Phase 0, before go-live'),
      'PHASES 6.2': section(phases, '### 6.2 Actions'),
      'PHASES 54': section(phases, '## 54. Amendment: roadmap 2 (all Dutch waters) (2026-10-16)'),
      'ADR-0022': read('docs/adr/0022-roadmap-2-all-dutch-waters.md'),
    };
    for (const d of DRAFTS) texts[d] = read(d);
    for (const [name, text] of Object.entries(texts)) expect(strangers(text), name).toEqual([]);
  });

  it('a personal-looking address fails the checker', () => {
    expect(strangers('mail jan.jansen@example.nl or info@wrij.nl')).toEqual(['jan.jansen@example.nl']);
  });
});

/** Relative file links of a document that do not resolve. */
function brokenLinks(file: string, text = read(file)): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = (m[1] as string).split('#')[0] as string;
    if (!target || /^(https?:|mailto:)/.test(m[1] as string)) continue;
    if (!existsSync(resolve(dirname(`${repoRoot}${file}`), target))) out.push(m[1] as string);
  }
  return out;
}

describe('relative links', () => {
  const FILES = [
    'docs/plan/PHASES.md',
    'docs/plan/ARCHITECTURE.md',
    'docs/adr/0022-roadmap-2-all-dutch-waters.md',
    'docs/sources/SOURCE-CATALOGUE.md',
    'docs/permissions.md',
    'docs/legal/requests/README.md',
    ...DRAFTS,
    'CLAUDE.md',
  ];
  for (const f of FILES) {
    it(`${f} has no broken relative link`, () => {
      expect(brokenLinks(f)).toEqual([]);
    });
  }

  it('a link to a missing file is caught', () => {
    expect(brokenLinks('docs/permissions.md', '[x](legal/requests/nope.md) [y](#a) [z](https://a.b)')).toEqual([
      'legal/requests/nope.md',
    ]);
  });
});
