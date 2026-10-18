import { TravelEmpirical } from '@rws/contracts';
import { climatologyConfig } from '../climatology/config.ts';
import { dbConfig, errorCode, openDb } from '../db/pool.ts';
import { readRiverRegistry } from '../load/registry-sync.ts';
import { formatTravelEmpirical } from './format.ts';
import { type Counts, DEFAULT_FROM_YEAR, eligibleReaches, travelPairs } from './run.ts';

const EXIT_FAILURE = 1;
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;
const USAGE = 'usage: main.js travel-times [--from YYYY] [--to YYYY]';

type Deps = {
  now?: () => Date;
  /** The registry directory of rivernet.yaml (default: the image's). */
  registry?: URL;
};

/** `--from` and `--to`, each at most once and a four-digit year; null for a usage error. */
function parseYears(argv: readonly string[], now: Date): { from: number; to: number } | null {
  const given = new Map<string, number>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--from' && flag !== '--to') || value === undefined || given.has(flag) || !/^[0-9]{4}$/.test(value))
      return null;
    given.set(flag, Number(value));
  }
  const from = given.get('--from') ?? DEFAULT_FROM_YEAR;
  const to = given.get('--to') ?? now.getUTCFullYear();
  return from >= 1900 && from <= to && to <= now.getUTCFullYear() ? { from, to } : null;
}

/**
 * `travel-times [--from YYYY] [--to YYYY]`: the empirical travel-time YAML on `out` (stdout), counts on `log`
 * (stderr); exit 0, 1 (a failed read), 64 (usage) or 78 (no database settings, or the registry is unusable). Run as
 * `rws_publish`: it reads the public views only and writes nothing to the database (`docs/runbooks/backfill.md`
 * style: `rwsc run --rm --no-deps -T publish travel-times > travel.yaml`, `-T` so that a TTY never touches stdout).
 */
export async function travelTimesMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
  out: (text: string) => void,
  deps: Deps = {},
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const years = parseYears(argv, now);
  if (years === null) {
    log(USAGE);
    return EXIT_USAGE;
  }
  let params: ReturnType<typeof climatologyConfig>['travel'];
  let reaches: ReturnType<typeof eligibleReaches>;
  let all = 0;
  try {
    params = climatologyConfig().travel;
    const rivernet = (deps.registry === undefined ? readRiverRegistry() : readRiverRegistry(deps.registry)).rivernet;
    if (rivernet === null) {
      log('travel-times: registry/rivernet.yaml is missing');
      return EXIT_CONFIG;
    }
    all = rivernet.reaches.length;
    reaches = eligibleReaches(rivernet.reaches);
  } catch {
    log('travel-times: the registry is not usable');
    return EXIT_CONFIG;
  }
  const cfg = dbConfig(env, 'rws_publish');
  if (typeof cfg === 'string') {
    log(`travel-times: ${cfg}`);
    return EXIT_CONFIG;
  }
  const conn = openDb(cfg, { max: 1, onError: (code) => log(`travel-times: connection error ${code}`) });
  const counts: Counts = { reaches: all, eligible: reaches.length, no_series: 0, no_common: 0, queries: 0 };
  try {
    const pairs = await travelPairs(conn.db, reaches, params, years, counts);
    const generated = `${now.toISOString().slice(0, 19)}Z`;
    out(formatTravelEmpirical(TravelEmpirical.parse({ version: 1, generated, pairs })));
    log(
      `travel-times: reaches ${counts.reaches}, eligible ${counts.eligible}, without public series ${counts.no_series}, ` +
        `without a common quantity ${counts.no_common}, queries ${counts.queries}, years ${years.from}-${years.to}, pairs ${pairs.length}`,
    );
    return 0;
  } catch (err) {
    log(`travel-times: failed (${errorCode(err)})`);
    return EXIT_FAILURE;
  } finally {
    await conn.close();
  }
}
