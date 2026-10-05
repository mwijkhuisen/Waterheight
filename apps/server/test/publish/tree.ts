import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import {
  FramesFile,
  LatestFile,
  SnapshotFile,
  StaticForecastLatest,
  StaticMeta,
  StaticStations,
  StationRecent,
  WarningsFile,
} from '@rws/contracts';
import {
  OwnerLatestFile,
  OwnerSnapshotFile,
  OwnerStaticForecastLatest,
  OwnerStaticMeta,
  OwnerStaticSources,
  OwnerStaticStations,
  OwnerStationRecent,
  OwnerWarningsFile,
  StaticSources,
} from '@rws/contracts/static-owner';
import { OwnerStatusFile, StatusFile } from '@rws/contracts/status';
import { expect } from 'vitest';
import type { z } from 'zod';
import type { ChannelAudience } from '../../src/db/audience.ts';

// P9a tests: walking a publisher's output tree and the contract of each of its files.

/** Every file of `v1/` (plain only), after checking that each sibling decompresses to the plain bytes. */
export function walk(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const plain = (rel: string) => (rel.endsWith('.zst') || rel.endsWith('.gz') ? rel.replace(/\.(zst|gz)$/, '') : rel);
  const all: string[] = [];
  const go = (rel: string) => {
    for (const e of readdirSync(join(root, 'v1', rel), { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) go(r);
      else all.push(r);
    }
  };
  go('');
  for (const rel of all) {
    const bytes = readFileSync(join(root, 'v1', rel));
    if (rel === plain(rel)) {
      files.set(rel, bytes.toString('utf8'));
      continue;
    }
    const base = readFileSync(join(root, 'v1', plain(rel)));
    expect(rel.endsWith('.zst') ? zstdDecompressSync(bytes) : gunzipSync(bytes), rel).toEqual(base);
  }
  for (const rel of files.keys())
    for (const ext of ['.zst', '.gz']) expect(all, `${rel}${ext}`).toContain(`${rel}${ext}`);
  expect(readdirSync(join(root, '.tmp'))).toEqual([]);
  return { files }.files;
}

export const contract = (family: ChannelAudience, rel: string): z.ZodType => {
  const pub = family === 'public';
  if (rel === 'meta.json') return pub ? StaticMeta : OwnerStaticMeta;
  if (rel === 'latest.json') return pub ? LatestFile : OwnerLatestFile;
  if (rel === 'stations.json') return pub ? StaticStations : OwnerStaticStations;
  if (rel === 'sources.json') return pub ? StaticSources : OwnerStaticSources;
  if (rel === 'status.json') return pub ? StatusFile : OwnerStatusFile;
  if (rel === 'forecast/latest.json') return pub ? StaticForecastLatest : OwnerStaticForecastLatest;
  if (rel.startsWith('warnings/')) return pub ? WarningsFile : OwnerWarningsFile;
  if (rel.startsWith('recent/') || rel.startsWith('settled/')) return pub ? SnapshotFile : OwnerSnapshotFile;
  if (rel.startsWith('frames/')) return FramesFile;
  if (rel.startsWith('series/')) return pub ? StationRecent : OwnerStationRecent;
  throw new Error(`unknown file ${rel}`);
};
