import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { Archive } from '../../src/archive/writer.ts';
import { Counters, type RunDeps } from '../../src/capture/runner.ts';
import { type LoadedSpec, loadRegistry } from '../../src/capture/specs.ts';
import { StateStore } from '../../src/capture/state.ts';
import type { ClientOptions } from '../../src/http/client.ts';
import { testClient } from '../helpers.ts';

export const registry = loadRegistry();
export const spec = (id: string): LoadedSpec => {
  const s = registry.specs.find((x) => x.id === id);
  if (!s) throw new Error(`no spec ${id}`);
  return s;
};

const ADAPTERS_DIR = new URL('../../src/adapters/', import.meta.url).pathname;
/** Tiers of one request type share their first tier's recorded fixture. */
const ALIAS: Record<string, string> = {
  'nl-1-fc-3h-0': 'nl-1-fc-1h',
  'nl-1-fc-3h-1': 'nl-1-fc-1h',
  'nl-1-fc-3h-2': 'nl-1-fc-1h',
  'nl-1-obs-other': 'nl-1-obs-key',
  // The same Vigicrues request as the seed, for two of its rows (P5a).
  'fr-3-twin': 'fr-3-obs',
};
/** Stage-2 documents (expand_validity) per spec. */
export const STAGE2: Record<string, string> = {
  'fr-4': 'fr-4-station',
  'fr-5-sections': 'fr-5-tron',
  'lu-5-cap': 'lu-5-file',
};

export type Fixture = { file: string; body: Buffer; meta: { synthetic: boolean; spec: string } };

export function fixture(source: string, name: string): Fixture {
  const dir = join(ADAPTERS_DIR, source.toLowerCase(), 'fixtures');
  for (const file of [`${name}.synthetic.raw`, `${name}.raw`]) {
    const path = join(dir, file);
    if (existsSync(path)) {
      const meta = JSON.parse(readFileSync(path.replace(/\.raw$/, '.meta.json'), 'utf8')) as Fixture['meta'];
      return { file, body: readFileSync(path), meta };
    }
  }
  throw new Error(`no fixture ${source}/${name}`);
}

/** The recorded (or synthetic) passing payload of a spec; pegeldaten.zip is generated here (10 MB upstream). */
export function fixtureFor(s: LoadedSpec): Fixture {
  if (s.id === 'de-7-pegeldaten')
    return { file: '(generated)', body: pegeldatenZip(), meta: { synthetic: true, spec: s.id } };
  return fixture(s.source, ALIAS[s.id] ?? s.id);
}

/** A small pegeldaten.zip with the real member names and header lines (recorded 2026-09-29). */
export function pegeldatenZip(rows = 120_000): Buffer {
  const lines = ['station_no;time;value(cm)'];
  for (let i = 0; i < rows; i += 1) {
    const t = new Date(Date.parse('2026-07-23T19:40:00Z') + i * 15 * 60_000).toISOString().slice(0, 19);
    lines.push(`28${String(i % 250).padStart(3, '0')}00000100;${t}.000+01:00;${(i % 700) / 10}`);
  }
  return Buffer.from(
    zipSync({
      'pegel_messwerte.txt': strToU8(`${lines.join('\r\n')}\r\n`),
      'pegel_stationen.txt': strToU8(
        'station_latitude;station_longitude;station_name;station_no;catchment_no;catchment_name;LANUV_Info_1;LANUV_Info_2;LANUV_Info_3;LANUV_MNW;LANUV_MW;LANUV_MHW\r\n',
      ),
      'pegel_tagesmaxima.txt': strToU8('station_no;time;max(cm);coverage\r\n'),
      'pegel_tagesmittelwerte.txt': strToU8('station_no;time;mean(cm);coverage\r\n'),
    }),
  );
}

export const quiet = { info: () => {}, warn: () => {}, error: () => {} };

export function runDeps(
  over: Partial<Omit<RunDeps, 'client'>> & { client?: Partial<ClientOptions> } = {},
): RunDeps & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'rws-capture-'));
  const { client, ...rest } = over;
  return {
    root,
    client: testClient(Object.fromEntries(registry.hosts), { sleep: async () => {}, ...client }),
    archive: new Archive(root),
    state: new StateStore(root),
    counters: new Counters(),
    log: quiet,
    now: () => new Date(),
    sleep: async () => {},
    ...rest,
  };
}
