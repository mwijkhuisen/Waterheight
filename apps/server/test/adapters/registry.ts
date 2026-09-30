import { readFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import { durationMs, type Registry, type SeriesDecl } from '@rws/core';
import { parse } from 'yaml';

/** The series declarations of a source, straight from registry/stations/<source>.yaml (as the sync stores them). */
export function registryOf(source: string): Registry {
  const file = new URL(`../../../../registry/stations/${source.toLowerCase()}.yaml`, import.meta.url);
  const rows = StationsFile.parse(parse(readFileSync(file, 'utf8'))).stations;
  const out = new Map<string, SeriesDecl>();
  for (const r of rows) {
    out.set(r.provider_key, {
      key: r.provider_key,
      quantity: r.quantity,
      native_unit: r.native_unit,
      to_canonical: r.to_canonical,
      value_kind: r.value_kind,
      native_step_ms: durationMs(r.native_step),
      expected_step_ms: durationMs(r.expected_step),
    });
  }
  return out;
}

const FIXTURES = new URL('../../src/adapters/', import.meta.url);

export function rawFixture(
  source: string,
  name: string,
): { body: Buffer; meta: { recorded_at: string; url: string; status: number } } {
  const dir = new URL(`${source.toLowerCase()}/fixtures/`, FIXTURES);
  return {
    body: readFileSync(new URL(`${name}.raw`, dir)),
    meta: JSON.parse(readFileSync(new URL(`${name}.meta.json`, dir), 'utf8')),
  };
}

export const goldenUrl = (source: string, name: string) =>
  new URL(
    `${source.toLowerCase()}/fixtures/${name.replace(/\.synthetic$/, '')}${name.endsWith('.synthetic') ? '.synthetic' : ''}.golden.json`,
    FIXTURES,
  );
