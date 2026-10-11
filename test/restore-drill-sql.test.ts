import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './catalogue.ts';

// The restore drill (deploy/bin/rws-restore-drill, P12b, plan A8) compares a restored dump before and after a replay
// with deploy/postgres/restore-drill-checksum.sql, run by psql inside the throwaway PostgreSQL. Its expression must
// stay the P2 one, computeChecksums in apps/server/src/load/health.ts, with SAME_AUDIENCE inlined and only a ts filter
// added: a drift here would make the drill compare something else than the nightly partition checksums.

const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const squash = (s: string) => s.replaceAll(/\s+/g, ' ').trim();

const health = read('apps/server/src/load/health.ts');
const sqlFile = read('deploy/postgres/restore-drill-checksum.sql')
  .split('\n')
  .filter((l) => !l.startsWith('--'))
  .join('\n');

describe('restore-drill-checksum.sql', () => {
  const fn = health.slice(health.indexOf('export async function computeChecksums('));
  const query = /sql<[^`]*`([\s\S]*?)`\.execute\(db\)/.exec(fn)?.[1] ?? '';
  const sameAudience = /const SAME_AUDIENCE = sql`([^`]*)`;/.exec(health)?.[1] ?? '';

  it('finds the expression in health.ts', () => {
    expect(query).toContain('md5(string_agg(');
    expect(sameAudience).toContain('COALESCE(');
  });

  it('selects, joins and groups exactly as computeChecksums', () => {
    const head = squash(query.slice(0, query.indexOf('WHERE')));
    expect(head.startsWith('SELECT s.source_id,')).toBe(true);
    expect(squash(sqlFile)).toContain(`${head} WHERE ${squash(sameAudience)} AND `);
    expect(squash(query)).toMatch(/ GROUP BY 1, 2$/);
    expect(squash(sqlFile)).toContain(' GROUP BY 1, 2 ORDER BY 1, 2;');
  });

  it('adds only the one-UTC-day filter on o.ts', () => {
    const where = squash(sqlFile.slice(sqlFile.indexOf('WHERE'), sqlFile.indexOf('GROUP BY')));
    expect(where).toBe(
      `WHERE ${squash(sameAudience)} AND o.ts >= (:'day' || ' 00:00:00+00')::timestamptz AND o.ts < (:'day' || ' 00:00:00+00')::timestamptz + interval '1 day'`,
    );
  });
});
