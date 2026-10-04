import { CANARIES } from '@rws/contracts';
import { OwnerStaticSources, StaticSources } from '@rws/contracts/static-owner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishTail } from '../../src/load/migrate.ts';
import { sources } from '../../src/publish/render/sources.ts';
import { type Harness, harness } from '../load/harness.ts';
import { ctxFor, NOW, OWNER_IDS } from './s2-ctx.ts';

// P9a: sources.json of both families against the real views: the registry's attribution verbatim, the licence, the
// DE-6 "Stand" date, and the audience line (a public file names no owner source, no private basis, no canary).

let h: Harness;
let pub: unknown;
let own: unknown;
let clauses: string[];

beforeAll(async () => {
  h = await harness();
  const migrator = h.dbAs('rws_migrator', 1);
  await publishTail(migrator.db, new Date(NOW));
  // DE-6's provider `updated` as the loader stores it: 12:30Z is 14:30 in Berlin (CEST).
  await h.t.admin.query(
    `INSERT INTO source_health (source_id, detail) VALUES ('DE-6', '{"provider_updated": "2026-10-04T12:30:00.000Z"}')
     ON CONFLICT (source_id) DO UPDATE SET detail = source_health.detail || EXCLUDED.detail`,
  );
  clauses = (
    await h.t.admin.query(`SELECT private_basis->>'clause' AS c FROM source WHERE private_basis IS NOT NULL`)
  ).rows.map((r) => r.c);
  pub = await sources(await ctxFor(h.dbAs('rws_publish'), 'public'));
  own = await sources(await ctxFor(h.dbAs('rws_owner_api'), 'owner'));
}, 120_000);
afterAll(() => h.close());

describe('sources.json', { timeout: 120_000 }, () => {
  it('the public file parses and holds no owner source, canary or private basis', () => {
    const body = StaticSources.parse(pub);
    const text = JSON.stringify(pub);
    const ids = body.sources.map((s) => s.id);
    for (const id of OWNER_IDS) expect(ids).not.toContain(id);
    expect(ids).toContain('DE-1');
    expect(clauses.length).toBeGreaterThan(5);
    for (const c of clauses) expect(text).not.toContain(c);
    for (const c of [CANARIES.owner.text, CANARIES.owner.real, CANARIES.withheld.text, CANARIES.withheld.real])
      expect(text).not.toContain(c);
    expect(text).not.toContain('privateBasis');
    expect(text).not.toContain('private_basis');
    expect(text).not.toContain('CANARY');
  });

  it("every entry carries the registry's attribution rows, and the file's attribution names exactly its sources", () => {
    const body = StaticSources.parse(pub);
    for (const s of body.sources) expect(s.licence.url === null || s.licence.url.startsWith('https://')).toBe(true);
    const de1 = body.sources.find((s) => s.id === 'DE-1');
    expect(de1?.attribution.length).toBeGreaterThan(0);
    expect(new Set(body.attribution.map((a) => a.source))).toEqual(
      new Set(body.sources.filter((s) => s.attribution.length > 0).map((s) => s.id)),
    );
    for (const s of body.sources)
      expect(body.attribution.filter((a) => a.source === s.id).map((a) => a.text)).toEqual(
        s.attribution.map((a) => a.text),
      );
  });

  it('DE-6 shows "Stand: TT.MM.JJJJ hh:mm" in Europe/Berlin from the stored provider update', () => {
    const de6 = StaticSources.parse(pub).sources.find((s) => s.id === 'DE-6');
    expect(de6).toMatchObject({
      dateKind: 'update',
      date: '2026-10-04T12:30:00.000Z',
      dateText: 'Stand: 04.10.2026 14:30',
    });
  });

  it('the owner file parses, holds the owner canary and every owner source with its private basis', () => {
    const body = OwnerStaticSources.parse(own);
    const by = new Map(body.sources.map((s) => [s.id, s]));
    for (const id of OWNER_IDS) expect(by.get(id)?.audience, id).toBe('owner');
    for (const s of body.sources) expect(s.privateBasis !== null, s.id).toBe(s.audience === 'owner');
    for (const c of clauses) expect(JSON.stringify(own)).toContain(JSON.stringify(c).slice(1, -1));
    expect(by.get('DE-1')?.audience).toBe('public');
  });
});
