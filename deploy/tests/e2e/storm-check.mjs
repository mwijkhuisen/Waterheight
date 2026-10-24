// CI only (P20a, issue #68; deploy/tests/storm/run.sh), run inside the server image like flood-check.mjs: no dependency,
// node builtins only (node:fs, node:path, node:url, and node:zlib to read the compressed siblings of the public files).
// The storm drill (scripts/flood-drill.ts --phase storm) has replayed the synthetic Den Helder storm into the raw
// archive; this reads what the loader and the two publishers made of it and checks the criterion of the issue:
//   - latest.json carries Den Helder (Marsdiep) at its storm high: value 333 cm = astro 83 + surge 250, tide.derived
//     "surge", state "high", basis NL-4 provider_class "Stormvloed (> 260cm)" (deploy/tests/storm/expected.json);
//   - stations.json flags the station tidal (the input of the hatch of the map) and the surge is at least 50 cm (the
//     input of the up-triangle);
//   - the recent bucket file of the current bucket holds the same surge (the page reads recent/ for a held t);
//   - no public byte holds any of the four canary renderings (the owner canary and the withheld one, each as typed and
//     as stored in a real), in any file of the public tree, compressed siblings included, and the owner tree holds the
//     owner canary.
//
//   node storm-check.mjs            prints PASS/FAIL lines and "PASS storm-check"; exit 1 on a failure
//
// Mounted: /expected.json, /public (= /srv/rws/public/www) and /owner (= /srv/rws/owner/www), all read-only.
// Environment: STORM_WAIT_S (how long the publishers may take for the first group of checks, default 120: the caller has
// already waited for the surge in latest.json, the recent bucket file follows in the same cycle), STORM_ROOT (a prefix of
// the three mounts, for the local test). The checks are repeated every 5 s until they pass or the time is up; the
// canary scan, which reads the whole tree, runs once at the end. Prints fixed codes and ids of ours, never a value of the
// owner side or a provider text.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

/** The Den Helder row of a latest.json: its index in the columns, or null when the station or the series is not there. */
export function locate(latest, stations, e) {
  const st = stations?.stations?.find((s) => s.id === e.station.id);
  const sid = st?.series?.find((s) => s.quantity === e.station.quantity)?.id;
  const i = sid === undefined || latest === null ? -1 : latest.series.indexOf(sid);
  return i < 0 ? null : { st, sid, i };
}

/** latest.json at Den Helder: state, basis, value and tide, as expected.json says. Returns the problems ([] is a pass). */
export function checkLatest(latest, stations, e) {
  if (latest === null || stations === null) return ['no latest.json or stations.json'];
  const at = locate(latest, stations, e);
  if (at === null) return [`${e.station.id}: no ${e.station.quantity} series in latest.json`];
  const { i } = at;
  const bad = [];
  const tide = latest.tide?.[i] ?? null;
  const basis = latest.basis[i] === null ? null : latest.bases[latest.basis[i]];
  if (latest.state[i] !== e.state) bad.push(`state ${latest.state[i]}, expected ${e.state}`);
  if (latest.value[i] !== e.value) bad.push(`value ${latest.value[i]}, expected ${e.value}`);
  if (tide === null) bad.push('no tide');
  else {
    if (tide.astro !== e.tide.astro) bad.push(`astro ${tide.astro}, expected ${e.tide.astro}`);
    if (tide.surge !== e.tide.surge) bad.push(`surge ${tide.surge}, expected ${e.tide.surge}`);
    if (tide.derived !== e.tide.derived) bad.push(`derived ${tide.derived}, expected ${e.tide.derived}`);
    // Measured = astro + surge: the whole reason the tide is derived and not read.
    if (tide.astro !== null && tide.surge !== null && latest.value[i] !== tide.astro + tide.surge)
      bad.push('value is not astro + surge');
    // The ▲ of the map: a surge of at least +50 cm in the state mode.
    if (!(tide.surge >= e.surgeUpFrom)) bad.push(`surge below ${e.surgeUpFrom}`);
  }
  if (basis === null) bad.push('no basis');
  else if (basis.source !== e.basis.source || basis.kind !== e.basis.kind || basis.label !== e.basis.label)
    bad.push(
      `basis ${basis.source}/${basis.kind}/${basis.label}, expected ${e.basis.source}/${e.basis.kind}/${e.basis.label}`,
    );
  return bad;
}

/** stations.json flags Den Helder tidal: the map's hatch and the tidal layer read it. */
export function checkStations(stations, e) {
  if (stations === null) return ['no stations.json'];
  const st = stations.stations?.find((s) => s.id === e.station.id);
  if (st === undefined) return [`${e.station.id}: not in stations.json`];
  const bad = [];
  if (st.flags?.tidal !== true) bad.push(`${e.station.id}: flags.tidal is not true`);
  if (!st.series?.some((s) => s.quantity === e.station.quantity))
    bad.push(`${e.station.id}: no ${e.station.quantity} series`);
  return bad;
}

/** The recent bucket file of the bucket latest.json is at holds the same value and surge for Den Helder. */
export function checkRecent(recent, latest, stations, e) {
  if (recent === null) return ['no recent bucket file for the current bucket'];
  if (latest === null || stations === null) return ['no latest.json or stations.json'];
  if (recent.t !== latest.t) return ['the recent file is not at the bucket of latest.json'];
  const at = locate(recent, stations, e);
  if (at === null) return [`${e.station.id}: not in the recent bucket file`];
  const tide = recent.tide?.[at.i] ?? null;
  const bad = [];
  if (recent.value[at.i] !== e.value) bad.push(`recent value ${recent.value[at.i]}, expected ${e.value}`);
  if (tide === null || tide.surge !== e.tide.surge)
    bad.push(`recent surge ${tide?.surge ?? 'null'}, expected ${e.tide.surge}`);
  return bad;
}

/**
 * The canary scan. `publicEntries` and `ownerEntries` are iterables of [path, Buffer|null] (null: unreadable). No public
 * file may hold any rendering of `canary`; some owner file must hold the owner canary (the renderings that start 777777).
 */
export function canaryProblems(publicEntries, ownerEntries, canary) {
  const needles = canary.map((c) => Buffer.from(c));
  const owner = canary.filter((c) => c.startsWith('777777')).map((c) => Buffer.from(c));
  const bad = [];
  let scanned = 0;
  for (const [path, buf] of publicEntries) {
    scanned += 1;
    if (buf === null) bad.push(`unreadable public file ${path}`);
    else if (needles.some((n) => buf.includes(n))) bad.push(`a public file holds a canary rendering (${path})`);
  }
  if (scanned === 0) bad.push('no public file was scanned');
  let ownerHit = false;
  for (const [, buf] of ownerEntries)
    if (buf !== null && owner.some((n) => buf.includes(n))) {
      ownerHit = true;
      break;
    }
  if (!ownerHit) bad.push('no owner file holds the owner canary');
  return bad.slice(0, 5);
}

/** Every file under a directory, as [path, bytes]: a .gz or .zst file is decompressed (null when it cannot be read). */
export function* entries(dir) {
  let list;
  try {
    list = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of list) {
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* entries(p);
    else if (d.isFile()) {
      let buf;
      try {
        buf = readFileSync(p);
      } catch (err) {
        // A file the publisher pruned between the listing and the read is not there any more; anything else is a failure.
        if (err.code === 'ENOENT') continue;
        yield [p, null];
        continue;
      }
      try {
        if (p.endsWith('.gz')) buf = gunzipSync(buf);
        else if (p.endsWith('.zst')) buf = zstdDecompressSync(buf);
      } catch {
        buf = null;
      }
      yield [p, buf];
    }
  }
}

const hhmm = (t) => new Date(t).toISOString().slice(11, 16).replace(':', '');
/** recentPath of packages/contracts/src/static.ts: recent/YYYY-MM-DD/HHmm.json. */
export const recentPathOf = (t) => `recent/${new Date(t).toISOString().slice(0, 10)}/${hhmm(t)}.json`;

async function main() {
  const waitS = Number(process.env.STORM_WAIT_S ?? 120);
  if (!Number.isFinite(waitS)) {
    console.error('STORM_WAIT_S must be a number');
    process.exit(64);
  }
  // STORM_ROOT is for the local test of this script; in the container the mounts are at /.
  const ROOT = process.env.STORM_ROOT ?? '';
  const expected = JSON.parse(readFileSync(`${ROOT}/expected.json`, 'utf8'));
  const v1 = `${ROOT}/public/v1`;
  const read = (rel) => {
    try {
      return JSON.parse(readFileSync(join(v1, rel), 'utf8'));
    } catch {
      return null;
    }
  };
  const world = () => {
    const latest = read('latest.json');
    const t = latest === null ? NaN : Date.parse(latest.t);
    return {
      latest,
      stations: read('stations.json'),
      recent: Number.isNaN(t) ? null : read(recentPathOf(t)),
    };
  };
  const checks = [
    [
      'latest.json: Den Helder at the storm high (value, tide, state, basis)',
      (w) => checkLatest(w.latest, w.stations, expected),
    ],
    ['stations.json: Den Helder is tidal', (w) => checkStations(w.stations, expected)],
    ['recent bucket file: the same surge', (w) => checkRecent(w.recent, w.latest, w.stations, expected)],
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + waitS * 1000;
  let results;
  for (let round = 0; ; round++) {
    const w = world();
    results = checks.map(([name, fn]) => ({ name, problems: fn(w) }));
    const pending = results.filter((r) => r.problems.length > 0).length;
    if (pending === 0 || Date.now() >= deadline) break;
    if (round % 6 === 0) console.log(`waiting: ${pending} of ${checks.length} checks not yet true`);
    await sleep(5000);
  }
  results.push({
    name: 'the four canary renderings are in no public file; the owner canary is in the owner tree',
    problems: canaryProblems(entries(`${ROOT}/public`), entries(`${ROOT}/owner`), expected.canary),
  });

  let failures = 0;
  for (const r of results) {
    if (r.problems.length === 0) console.log(`PASS ${r.name}`);
    else {
      failures += 1;
      console.log(`FAIL ${r.name}`);
      for (const p of r.problems) console.log(`  - ${p}`);
    }
  }
  if (failures === 0) console.log('PASS storm-check');
  else console.log(`FAIL storm-check: ${failures} of ${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

// Run as a script (the container's `node /storm-check.mjs`); a test imports the functions above without running it.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main();
