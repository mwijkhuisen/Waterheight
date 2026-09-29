import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adapter as nl4 } from '../../src/adapters/nl-4/capture.ts';
import { validate } from '../../src/archive/validity.ts';
import { fixture, fixtureFor, registry, STAGE2 } from './helpers.ts';

// Criterion "[CI] Every CaptureSpec has a validity assertion with one passing
// fixture and three failing fixtures: empty-but-200, an HTML error page, and
// truncated JSON. The fixtures of owner-audience specs are synthetic" (#16).

const HTML_ERROR = Buffer.from(
  '<!DOCTYPE html>\n<html><head><title>503 Service Unavailable</title></head><body><h1>Service Unavailable</h1><p>Please try again later.</p></body></html>\n',
);
const OWNER_SOURCES = ['BE-3', 'LU-2', 'LU-3', 'LU-4', 'DE-2', 'DE-3'];

describe.each(registry.specs.map((s) => [s.id, s] as const))('%s', (_, s) => {
  const f = fixtureFor(s);

  it('passes its recorded fixture', async () => {
    const v = await validate(s.validity, 200, f.body);
    expect(v.reason).toBeNull();
    expect(v.ok).toBe(true);
  });

  it('fails an empty 200', async () => {
    expect((await validate(s.validity, 200, Buffer.alloc(0))).ok).toBe(false);
  });

  it('fails an HTML error page served with 200', async () => {
    expect((await validate(s.validity, 200, HTML_ERROR)).ok).toBe(false);
  });

  it('fails a truncated body', async () => {
    expect((await validate(s.validity, 200, f.body.subarray(0, Math.floor(f.body.length / 2)))).ok).toBe(false);
  });

  if (s.audience === 'owner') {
    it('uses a synthetic fixture (owner audience)', () => {
      expect(OWNER_SOURCES).toContain(s.source);
      expect(f.meta.synthetic).toBe(true);
      expect(f.file === '(generated)' || f.file.endsWith('.synthetic.raw')).toBe(true);
    });
  }

  const stage2 = STAGE2[s.id];
  if (stage2 !== undefined) {
    it(`asserts its stage-2 documents (${stage2}) the same way`, async () => {
      const vs = s.request.expand_validity ?? s.validity;
      const doc = fixture(s.source, stage2).body;
      expect((await validate(vs, 200, doc)).ok).toBe(true);
      expect((await validate(vs, 200, Buffer.alloc(0))).ok).toBe(false);
      expect((await validate(vs, 200, HTML_ERROR)).ok).toBe(false);
      expect((await validate(vs, 200, doc.subarray(0, Math.floor(doc.length / 2)))).ok).toBe(false);
    });
  }
});

describe('Vigicrues errors in HTTP 200', () => {
  it('rejects error_msg bodies for FR-3, FR-4 and FR-5', async () => {
    const err = Buffer.from('{"error_msg":"Cette station n\'est pas une station de prévisions","code":400}');
    for (const id of ['fr-3-obs', 'fr-4', 'fr-5-ref', 'fr-5-sections', 'fr-5-stations']) {
      const s = registry.specs.find((x) => x.id === id);
      expect((await validate(s?.validity ?? ({ format: 'json' } as never), 200, err)).ok, id).toBe(false);
    }
  });

  it('allows an empty list only where no event is the normal state (FR-4, DE-6 alerts)', () => {
    const minZero = registry.specs
      .filter((s) => s.validity.min === 0 && s.validity.count !== undefined)
      .map((s) => s.id);
    expect(minZero.sort()).toEqual(['de-6-alerts', 'fr-4']);
  });

  it('keeps no owner-audience fixture that is not synthetic (invariants 9, 11)', () => {
    for (const source of OWNER_SOURCES) {
      const dir = new URL(`../../src/adapters/${source.toLowerCase()}/fixtures/`, import.meta.url).pathname;
      const raws = readdirSync(dir).filter((f) => f.endsWith('.raw'));
      expect(raws.length).toBeGreaterThan(0);
      for (const f of raws) {
        expect(f).toMatch(/\.synthetic\.raw$/);
        const meta = JSON.parse(readFileSync(`${dir}${f.replace(/\.raw$/, '.meta.json')}`, 'utf8')) as {
          synthetic: unknown;
        };
        expect(meta.synthetic).toBe(true);
      }
    }
  });
});

describe('NL-4 patterns (S5)', () => {
  const page = registry.specs.find((x) => x.id === 'nl-4-page');

  it('stay linear on a crafted page that repeats the file-name prefix, capped at 512 KB', async () => {
    expect(page?.max_bytes).toBeLessThanOrEqual(512 * 1024);
    const crafted = Buffer.from(`${'grenswaarden-en-legendakleuren'.repeat(17_000)}\n</html>\n`);
    let t = performance.now();
    expect((await validate(page?.validity ?? ({ format: 'html' } as never), 200, crafted)).reason).toBe('pattern');
    expect(performance.now() - t).toBeLessThan(500);
    t = performance.now();
    expect(nl4.alertKey?.(crafted.toString())).toBeNull();
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('still find the recorded workbook link', async () => {
    const f = fixture('NL-4', 'nl-4-page');
    expect((await validate(page?.validity ?? ({ format: 'html' } as never), 200, f.body)).ok).toBe(true);
    expect(nl4.alertKey?.(f.body.toString())).toMatch(/grenswaarden-en-legendakleuren.*\.xlsx/);
  });
});
