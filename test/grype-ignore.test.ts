import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
      expect(r.package.type).toMatch(/^(go-module|apk|deb)$/);
      for (const v of Object.values(r.package)) expect(v).not.toMatch(/[*?]/);
      const k = `${r.vulnerability} ${r.package.name} ${r.package.version}`;
      expect(keys.has(k), k).toBe(false);
      keys.add(k);
    }
    expect(keys.size).toBeGreaterThan(0);
  });

  it('is read by both Grype gates, which also scan the third-party images (#167)', () => {
    for (const f of ['release.yml', 'security.yml']) {
      const wf = readFileSync(join(root, '.github/workflows', f), 'utf8');
      expect(wf).toMatch(/grype -c \.grype\.yaml "sbom:/);
      expect(wf).not.toMatch(/grype "sbom:/);
      expect(wf).toMatch(/refs=\$\(scripts\/third-party-images\.sh "?[^\s)]*deploy"?\)/);
    }
  });
});

describe('scripts/third-party-images.sh (#167)', () => {
  const script = join(root, 'scripts/third-party-images.sh');
  const run = (dir: string) => spawnSync(script, [dir], { encoding: 'utf8' });

  it('lists the pinned postgres and cloudflared images of deploy/, not our release images', () => {
    const r = run(join(root, 'deploy'));
    expect(r.status, r.stderr).toBe(0);
    const refs = r.stdout.trim().split('\n');
    expect(refs.map((ref) => ref.split(':')[0])).toEqual(['cloudflare/cloudflared', 'postgres']);
    for (const ref of refs) expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('fails when there is no third-party image, on one without a digest, and on an image: it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'third-party-'));
    const fails = (compose: string, message: string) => {
      writeFileSync(join(dir, 'compose.yaml'), compose);
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
    };
    try {
      fails(`services:\n  web:\n    image: \${RWS_WEB_IMAGE:?}\n`, 'no third-party image');
      fails('services:\n  x:\n    image: example/x:1.0\n', 'not pinned by tag and digest');
      fails(`services:\n  x:\n    image:\n      example/x:1.0@sha256:${'0'.repeat(64)}\n`, 'on one line');
      fails('services:\n  x: {image: example/x:1.0}\n', 'on one line');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
