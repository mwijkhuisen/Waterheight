// CI only (loadtest.yml, abusive windows): do the other clients notice the abusive one? Reads the k6 summaries
// (summary-<client>.json, handleSummary of k6.js) of the windows without the abuser (--base) and with it (--abuse), for
// the clients that are not the abuser, and compares the mean p95 of both scenarios (static, api):
//   fail when mean(abuse) - mean(base) > max(rel * mean(base), floorMs).
// rel is 10 % (the criterion). floorMs (default 5) is a noise floor for p95s of a few milliseconds, where 10 % is less
// than the run-to-run spread of a shared CI runner; --floor-ms 0 gives the bare 10 % rule. Also fails when an "other"
// client saw a 429 in an abuse window (the throttle must hit only the abuser), or the abuser saw none.
//   node compare-p95.mjs --abuser 5 --base dirA1 dirA2 --abuse dirB1 dirB2 dirR [--rel 0.1] [--floor-ms 5]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const METRICS = { static: 'http_req_duration{scenario:static}', api: 'http_req_duration{scenario:api}' };

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** p95 (ms) of a scenario in one k6 summary object; throws when the summary has none (a lenient run still has it). */
export function p95Of(summary, scenario) {
  const v = summary?.metrics?.[METRICS[scenario]]?.values?.['p(95)'];
  if (typeof v !== 'number') throw new Error(`no p95 of ${METRICS[scenario]}`);
  return v;
}

export const count429 = (summary) => summary?.metrics?.status_429?.values?.count ?? 0;

/**
 * windows: { base: [[summary...], ...], abuse: [[summary...], ...] } where each window is the list of the other clients'
 * summaries. Returns { ok, rows: [{scenario, base, abuse, delta, allowed, ok}] }.
 */
export function compare({ base, abuse, rel = 0.1, floorMs = 5 }) {
  if (base.length === 0 || abuse.length === 0) throw new Error('need at least one base and one abuse window');
  const rows = Object.keys(METRICS).map((scenario) => {
    const windowMean = (w) => mean(w.map((s) => p95Of(s, scenario)));
    const b = mean(base.map(windowMean));
    const a = mean(abuse.map(windowMean));
    const allowed = Math.max(rel * b, floorMs);
    return { scenario, base: b, abuse: a, delta: a - b, allowed, ok: a - b <= allowed };
  });
  return { ok: rows.every((r) => r.ok), rows };
}

function parse(argv) {
  const o = { base: [], abuse: [], abuser: null, rel: 0.1, floorMs: 5 };
  let into = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') into = o.base;
    else if (a === '--abuse') into = o.abuse;
    else if (a === '--abuser') o.abuser = Number(argv[++i]);
    else if (a === '--rel') o.rel = Number(argv[++i]);
    else if (a === '--floor-ms') o.floorMs = Number(argv[++i]);
    else if (a.startsWith('--') || into === null) throw new Error(`unexpected argument ${a}`);
    else into.push(a);
  }
  if (!Number.isInteger(o.abuser)) throw new Error('--abuser <client index> is required');
  return o;
}

function main() {
  const o = parse(process.argv.slice(2));
  const load = (dir, client) => JSON.parse(readFileSync(`${dir}/summary-${client}.json`, 'utf8'));
  const clients = (dir) => {
    const out = [];
    for (let c = 0; ; c++) {
      try {
        out.push([c, load(dir, c)]);
      } catch (e) {
        if (e.code === 'ENOENT') return out;
        throw e;
      }
    }
  };
  const others = (dir) => {
    const all = clients(dir);
    if (all.length < 2) throw new Error(`${dir}: fewer than two client summaries`);
    return all;
  };
  const problems = [];
  const pick = (dir, withAbuser) =>
    others(dir)
      .filter(([c]) => withAbuser === (c === o.abuser))
      .map(([, s]) => s);
  const baseW = o.base.map((d) => pick(d, false));
  const abuseW = o.abuse.map((d) => pick(d, false));
  for (const d of o.abuse) {
    const n = pick(d, false).reduce((a, s) => a + count429(s), 0);
    if (n > 0) problems.push(`${d}: the other clients saw ${n} 429 answers`);
    const mine = pick(d, true);
    if (mine.length !== 1 || count429(mine[0]) === 0) problems.push(`${d}: the abuser (client ${o.abuser}) saw no 429`);
  }
  const r = compare({ base: baseW, abuse: abuseW, rel: o.rel, floorMs: o.floorMs });
  for (const row of r.rows)
    console.log(
      `${row.scenario}: others' mean p95 ${row.base.toFixed(1)} ms without the abuser, ${row.abuse.toFixed(1)} ms with it ` +
        `(delta ${row.delta.toFixed(1)} ms, allowed ${row.allowed.toFixed(1)} ms) ${row.ok ? 'PASS' : 'FAIL'}`,
    );
  for (const p of problems) console.log(`FAIL ${p}`);
  if (!r.ok || problems.length > 0) {
    console.error('compare-p95: the abusive client moved the other clients');
    process.exit(1);
  }
  console.log('compare-p95: PASS');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`compare-p95: ${e.message}`);
    process.exit(2);
  }
}
