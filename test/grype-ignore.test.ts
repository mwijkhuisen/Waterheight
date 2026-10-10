import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// P12a (R-095): the Grype ignore rules are an owner decision with an end date. Each rule names one vulnerability in
// one package version of one type, so a new finding still fails the gate; the whole list fails CI from its expiry.

const root = join(import.meta.dirname, '..');
const text = readFileSync(join(root, '.grype.yaml'), 'utf8');
const doc = parse(text) as { ignore: { vulnerability: string; package: Record<string, string> }[] };

describe('.grype.yaml', () => {
  it('has an expiry that has not passed and is at most 60 days after the decision', () => {
    const m = /^# expires: (\d{4}-\d{2}-\d{2})$/m.exec(text);
    expect(m).not.toBeNull();
    const expires = Date.parse(`${m?.[1]}T00:00:00Z`);
    expect(expires - Date.parse('2026-10-10T00:00:00Z')).toBeLessThanOrEqual(60 * 86_400_000);
    expect(Date.now(), 'the Grype ignore rules expired: bump the binaries or ask the owner (R-095)').toBeLessThan(
      expires,
    );
  });

  it('names one vulnerability, package, version and type per rule, with no wildcard and no duplicate', () => {
    expect(Object.keys(doc)).toEqual(['ignore']);
    const keys = new Set<string>();
    for (const r of doc.ignore) {
      expect(Object.keys(r).sort()).toEqual(['package', 'vulnerability']);
      expect(r.vulnerability).toMatch(/^(CVE-\d{4}-\d+|GHSA(-[0-9a-z]{4}){3}|GO-\d{4}-\d+)$/);
      expect(Object.keys(r.package).sort()).toEqual(['name', 'type', 'version']);
      expect(r.package.type).toMatch(/^(go-module|apk)$/);
      for (const v of Object.values(r.package)) expect(v).not.toMatch(/[*?]/);
      const k = `${r.vulnerability} ${r.package.name} ${r.package.version}`;
      expect(keys.has(k), k).toBe(false);
      keys.add(k);
    }
    expect(keys.size).toBeGreaterThan(0);
  });

  it('is read by both Grype gates', () => {
    for (const f of ['release.yml', 'security.yml']) {
      const wf = readFileSync(join(root, '.github/workflows', f), 'utf8');
      expect(wf).toMatch(/grype -c \.grype\.yaml "sbom:/);
      expect(wf).not.toMatch(/grype "sbom:/);
    }
  });
});
