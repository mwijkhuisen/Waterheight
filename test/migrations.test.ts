import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// An applied migration never changes (review SR-3). Production applies each
// file once, so an edited body (a view regenerated into its old migration, a
// tightened filter) would pass CI on a fresh database and never reach
// production. A change is a new migration; a new one joins this list when it
// is final.

const APPLIED: Readonly<Record<string, string>> = {
  '20261003000001_registry.sql': 'fd5bcf23f5bcc0731ce3c1b4d04bd6f47417883fe7ad96181e58392842f1a3c4',
  '20261003000002_observations.sql': '079b38fe5a02721d46e5221bf5200bef339bd6e2361fa5c69f726c8054dce27e',
  '20261003000003_references_forecasts.sql': 'f560153b952c24e7969be2ecfd1b555e181f7a86af789f9d4b023d5fa7a5bc19',
  '20261003000004_provenance_health.sql': '15d2fe83a2da2185aa4ec08a21e7cd14fe53d4d7d06eb90168373fe50add0889',
  '20261003000005_partitions.sql': '17ccb32475ac5842c016699e3cfa6d1226cbff4aa437a6cb6ea3191b61f24853',
  '20261003000006_views.sql': 'dd5caaff5dbd5a8b43d533385b5fb68cf65a18f26f8fe6226f20403b66d0bccf',
  '20261003000007_grants.sql': '18c8d6c371702d98482851895b198de95b18abeff279127ae0a787e952eba141',
  '20261014000001_display_window.sql': '81295d33360c2b95e5a9982935a08ac8dd32a14c647d92a7f6cf36cee72b5612',
  '20261014000002_views_meta.sql': 'a1baa906aaf13227ebebea5a31d818e9721181f33860b05c9df571eb2616ee61',
  '20261021000001_p7a_references.sql': '957110cb4c0247703f9b2eaa22d6e4a8af1fc7e7b0d657a05ff53339a9f5077e',
  '20261024000001_views_gauge_zero.sql': '65776ae93da53ad3a69a760de7efbaec6c2027963c265ef3bbf3db948144fcb9',
  '20261106000001_p8a_forecasts.sql': '27108a2fcc7a0d5dcdeed10191404b765a007adae83f097055392029ca36b783',
  '20261106000002_views_forecast.sql': '0212fc612a7a156bf5eee6a74e787e3a18360fefbb6751ddb08a5e4a75d76aca',
  '20261106000003_forecast_grants.sql': '4b5a47820540f426db3d82d952377b39d91d5368b1097952997ef85c9ba49936',
  '20261107000001_p9a_publish.sql': '4779bffc6ed8405cdf887ff8c0760e4f5592f105cf6ac45b8a1f56535ab8546c',
  '20261107000002_views_publish.sql': '9a89dbcb6f7f02c2705afc5253d96bb48607cb342f446a0642b1127d43db729f',
};

const dir = new URL('../db/migrations/', import.meta.url);
const files = readdirSync(dir).sort();
const sha256 = (file: string) =>
  createHash('sha256')
    .update(readFileSync(new URL(file, dir)))
    .digest('hex');

describe('db/migrations', () => {
  it('an applied migration never changes and is never removed', () => {
    for (const [file, sha] of Object.entries(APPLIED)) {
      expect(files, `${file} is gone: an applied migration never changes; add a new one`).toContain(file);
      expect(sha256(file), `${file} changed: an applied migration never changes; add a new one`).toBe(sha);
    }
  });

  it('every migration is in the list', () => {
    for (const file of files)
      expect(APPLIED[file], `${file}: add its sha256 to the list when the migration is final`).toBeDefined();
  });
});
