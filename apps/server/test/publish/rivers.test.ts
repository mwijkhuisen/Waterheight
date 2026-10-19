import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnerRivers } from '../../src/publish/rivers.ts';

// P11a review round 2: publish-owner reads the public river release as untrusted input. A FIFO in place of the
// manifest must not hang the open (O_NONBLOCK), and a link must not be followed (O_NOFOLLOW); either is a fixed code.

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function codesFor(make: (manifest: string) => void): Promise<unknown[]> {
  dir = mkdtempSync(join(tmpdir(), 'owner-rivers-'));
  make(join(dir, 'manifest.json'));
  const logged: unknown[] = [];
  const rivers = new OwnerRivers(dir, { error: (o: object) => logged.push(o) } as never, () => ({ stations: [] }));
  expect(await rivers.next(new Set())).toBeNull();
  return logged;
}

describe('the owner rivers reader', () => {
  it('refuses a FIFO as the manifest without hanging', { timeout: 5000 }, async () => {
    const logged = await codesFor((path) => execFileSync('mkfifo', [path]));
    expect(logged).toEqual([expect.objectContaining({ code: 'rivers_manifest_unreadable' })]);
  });

  it('never follows a link as the manifest', async () => {
    const logged = await codesFor((path) => {
      writeFileSync(`${path}.real`, '{}');
      symlinkSync(`${path}.real`, path);
    });
    expect(logged).toEqual([expect.objectContaining({ code: 'rivers_manifest_unreadable' })]);
  });
});

// P17b: a schema 2 release (waterbodies and mouths) is read through the contract like a schema 1 one, and the owner
// variant keeps the two keys.
const release = (schema: 1 | 2) => ({
  schema_version: schema,
  version: '20261117',
  attribution: '\u00a9 OpenStreetMap contributors',
  attribution_url: 'https://www.openstreetmap.org/copyright',
  licence: 'ODbL-1.0',
  licence_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  licence_note: 'Derived from OpenStreetMap.',
  osm_replication_timestamp: '2026-11-16T20:00:00Z',
  rivers: [{ id: 'rhine', name_nl: 'Rijn', name_en: 'Rhine', parent_river_id: null, km_direction: 'downstream' }],
  nl_entry_nodes: [],
  reaches: [],
  stations: [],
  travel_times: [],
  ...(schema === 2
    ? {
        waterbodies: [
          {
            id: 'ijsselmeer',
            kind: 'lake',
            name_nl: 'IJsselmeer',
            name_en: 'IJsselmeer',
            stations: ['nl.rws.a'],
            reference_station_id: null,
            outflows: [],
          },
        ],
        mouths: [{ id: 'rhine-mouth', river_id: 'rhine', waterbody_id: 'ijsselmeer' }],
      }
    : {}),
});

async function variants(doc: object): Promise<{ names: unknown[]; bodies: unknown[]; logged: unknown[] }> {
  dir = mkdtempSync(join(tmpdir(), 'owner-rivers-'));
  const bytes = Buffer.from(JSON.stringify(doc));
  writeFileSync(join(dir, 'reaches-20261117.json'), bytes);
  const entry = (file: string, n: number) => ({ file, sha256: 'a'.repeat(64), bytes: n });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      current: {
        version: '20261117',
        tag: 'geo-2026-11-17',
        installed_at: '2026-11-18T05:40:12Z',
        tiles: entry('rivers-20261117.pmtiles', 10),
        reaches: {
          file: 'reaches-20261117.json',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
        },
        download: entry('rivers-20261117.geojson.gz', 10),
      },
      previous: null,
    }),
  );
  const logged: unknown[] = [];
  const rivers = new OwnerRivers(dir, { error: (o: object) => logged.push(o) } as never, () => ({ stations: [] }));
  const built = (await rivers.next(new Set())) ?? [];
  return { names: built.map((b) => b.name), bodies: built.map((b) => b.body), logged };
}

describe('the owner rivers reader and schema 2 (P17b)', () => {
  it('reads a schema 1 and a schema 2 release', async () => {
    for (const schema of [1, 2] as const) {
      const r = await variants(release(schema));
      expect(r.logged, `schema ${schema}`).toEqual([]);
      expect(r.names).toEqual(['reaches-20261117.json']);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps waterbodies and mouths in the owner variant', async () => {
    const r = await variants(release(2));
    expect(r.bodies[0]).toMatchObject({
      schema_version: 2,
      waterbodies: [{ id: 'ijsselmeer' }],
      mouths: [{ id: 'rhine-mouth' }],
    });
  });

  it('refuses schema 2 without its keys and schema 3', async () => {
    const { waterbodies: _w, mouths: _m, ...bare } = release(2) as Record<string, unknown>;
    for (const doc of [bare, { ...release(2), schema_version: 3 }]) {
      const r = await variants(doc);
      expect(r.names).toEqual([]);
      expect(r.logged).toEqual([expect.objectContaining({ code: 'rivers_reaches_invalid' })]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
