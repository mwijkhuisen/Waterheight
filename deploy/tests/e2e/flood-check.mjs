// CI only (P12a, issue #27; deploy/tests/flood/run.sh), run inside the server image like frames-check.mjs: no dependency,
// node:fs only. The flood drill (scripts/flood-drill.ts) has replayed its fixtures into the raw archive; this reads what
// the loader and the two publishers made of them and checks the criterion of the issue: every fixture station and area
// reaches its expected level (deploy/tests/flood/expected.json, cross-checked against classify() by
// test/flood-expected.test.ts), the AGE Cancel closes its alert, the TEST message never appears, the CH-4 storm run
// shows in the forecast, and the owner-audience run of DE-2 is in the owner tree and in no public byte.
//
//   node flood-check.mjs open     the AGE alert of the northern zone is still open (before the cancel phase)
//   node flood-check.mjs closed   the Cancel has closed it and the TEST message is out; prints "PASS flood-check"
//
// Mounted: /expected.json, /public (= /srv/rws/public/www) and /owner (= /srv/rws/owner/www), all read-only. Environment:
// DRILL_NOW (the drill clock, an ISO instant), FLOOD_WAIT_S (how long the publishers may take, default 900: the
// loader ticks every 10 s, the publishers cycle, the 10-minute bucket of latest.json and the Vigicrues map, dated by
// its fetch, need the next bucket). The checks are repeated every 5 s until all pass or the time is up. Prints PASS/FAIL
// lines naming the file and a fixed code (ids of ours and levels, never a provider text, a path of a secret or a value
// of the owner side), exit 1 on a failure.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const phase = process.argv[2];
if (phase !== 'open' && phase !== 'closed') {
  console.error('usage: flood-check.mjs open|closed');
  process.exit(64);
}
const waitS = Number(process.env.FLOOD_WAIT_S ?? 900);
const drillNow = Date.parse(process.env.DRILL_NOW ?? '');
if (!Number.isFinite(drillNow) || !Number.isFinite(waitS)) {
  console.error('DRILL_NOW (an ISO instant) and FLOOD_WAIT_S (a number) are required');
  process.exit(64);
}
// FLOOD_ROOT is for the local test of this script (test/flood-drill.int.test.ts); in the container the mounts are at /.
const ROOT = process.env.FLOOD_ROOT ?? '';
const expected = JSON.parse(readFileSync(`${ROOT}/expected.json`, 'utf8'));
const SIDES = { public: `${ROOT}/public/v1`, owner: `${ROOT}/owner/v1` };
const LEVEL = expected.levels;
const closed = phase === 'closed';

/** A JSON file of one side, or null when it is not there (yet) or not whole. */
function read(side, rel) {
  try {
    return JSON.parse(readFileSync(join(SIDES[side], rel), 'utf8'));
  } catch {
    return null;
  }
}
const text = (side, rel) => {
  try {
    return readFileSync(join(SIDES[side], rel), 'utf8');
  } catch {
    return null;
  }
};

/** Every plain JSON file under a directory (the compressed siblings hold the same bytes and cannot be matched). */
function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(json|geojson)$/.test(e.name)) yield p;
  }
}

/** The state of the world one check sees: parsed once per round. */
function world() {
  const w = { stations: {}, latest: {}, warnings: {}, forecast: {} };
  for (const side of ['public', 'owner']) {
    w.stations[side] = read(side, 'stations.json');
    w.latest[side] = read(side, 'latest.json');
    w.warnings[side] = read(side, 'warnings/latest.geojson');
    w.forecast[side] = read(side, 'forecast/latest.json');
  }
  w.today = read('public', 'warnings/today.json');
  return w;
}

/** series id -> { state, section, area, basis, station } of a latest.json (columns to rows). */
function rowsOf(w, side) {
  const f = w.latest[side];
  const st = w.stations[side];
  if (f === null || st === null) return null;
  const stationOf = new Map();
  for (const s of st.stations) for (const x of s.series) stationOf.set(x.id, { station: s.id, quantity: x.quantity });
  const out = new Map();
  f.series.forEach((id, i) => {
    const b = f.basis[i];
    const a = f.area[i];
    out.set(id, {
      ...stationOf.get(id),
      state: f.state[i],
      section: f.section[i],
      basis: b === null ? null : f.bases[b],
      area: a === null ? null : { state: a.state, basis: f.bases[a.basis] },
    });
  });
  return out;
}
const seriesOfStation = (rows, station) => [...rows.entries()].filter(([, r]) => r.station === station);

/**
 * The checks. Each returns the list of problems (fixed codes with our own ids); [] is a pass. A `late` check is heavy (it
 * reads the whole public tree): it runs once, when the others have passed or the time is up, not every 5 seconds.
 */
const checks = [];
const check = (name, fn, { late = false } = {}) => checks.push({ name, fn, late });

check('latest.json and stations.json (public)', (w) =>
  rowsOf(w, 'public') === null ? ['public latest.json or stations.json is not there'] : [],
);

check('DE-6 gauge classes: the decisive stations reach their level', (w) => {
  const rows = rowsOf(w, 'public');
  if (rows === null) return ['no latest.json'];
  const bad = [];
  for (const e of expected.stations.filter((s) => s.source === 'DE-6')) {
    // A gauge class reaches the station's stage series (classSeries: the basis of a DE-6 class is stage), not its discharge.
    const mine = seriesOfStation(rows, e.id).filter(([, r]) => r.quantity === 'H');
    if (mine.length === 0) bad.push(`${e.id}: no series in latest.json`);
    for (const [id, r] of mine)
      if (r.state !== e.state || r.section || r.basis?.source !== 'DE-6' || r.basis.ref !== e.raw)
        bad.push(
          `${e.id} series ${id}: ${r.state}/${r.basis?.source}:${r.basis?.ref}, expected ${e.state}/DE-6:${e.raw}`,
        );
  }
  return bad;
});

check('DE-6 class-less features give no gauge class', (w) => {
  const rows = rowsOf(w, 'public');
  if (rows === null) return ['no latest.json'];
  const bad = [];
  for (const e of expected.noGaugeClass) {
    const mine = seriesOfStation(rows, e.id);
    for (const [id, r] of mine)
      if (r.basis?.source === 'DE-6') bad.push(`${e.id} series ${id}: a DE-6 basis ${r.basis.ref}`);
  }
  return bad;
});

check('every DE-6 basis is the crosswalk level of its class code', (w) => {
  const rows = rowsOf(w, 'public');
  if (rows === null) return ['no latest.json'];
  const scale = expected.scales['DE-6 station'];
  let n = 0;
  const bad = [];
  for (const [id, r] of rows) {
    if (r.basis?.source !== 'DE-6') continue;
    n += 1;
    const code = String(r.basis.ref).split(':')[1];
    if (scale[code] !== r.state) bad.push(`series ${id}: ${r.state} for class ${code}`);
  }
  if (n < expected.minimums.de6GaugeClassStations) bad.push(`only ${n} series have a DE-6 basis`);
  return bad.slice(0, 20);
});

check('warnings/latest.geojson: every area at its level (DE-6, FR-5, LU-5)', (w) => {
  const f = w.warnings.public;
  if (f === null) return ['no warnings/latest.geojson'];
  const have = new Map(f.features.map((x) => [`${x.properties.source}/${x.properties.area}`, x.properties]));
  const bad = [];
  for (const a of expected.areas) {
    const p = have.get(`${a.source}/${a.area}`);
    if (a.closedBy !== undefined && closed) {
      if (p !== undefined) bad.push(`${a.source}/${a.area}: still valid after its Cancel`);
    } else if (p === undefined) bad.push(`${a.source}/${a.area}: not in the file`);
    else if (p.level !== a.level || p.levelRaw !== a.levelRaw)
      bad.push(`${a.source}/${a.area}: level ${p.level}/${p.levelRaw}, expected ${a.level}/${a.levelRaw}`);
  }
  // Nothing else of these three sources (a stored TEST message would be one more LU-5 area).
  const names = new Set(expected.areas.map((a) => `${a.source}/${a.area}`));
  for (const k of have.keys()) if (/^(DE-6|FR-5|LU-5)\//.test(k) && !names.has(k)) bad.push(`${k}: not expected`);
  return bad.slice(0, 20);
});

check('stations in an area (FR-5 sections, LU-5 zones) reach the area level as a section', (w) => {
  const rows = rowsOf(w, 'public');
  if (rows === null) return ['no latest.json'];
  const bad = [];
  for (const e of expected.stations.filter((s) => s.source === 'FR-5' || s.source === 'LU-5')) {
    const mine = seriesOfStation(rows, e.id);
    if (mine.length === 0) bad.push(`${e.id}: no series in latest.json`);
    const gone = closed && expected.areas.some((a) => a.source === e.source && a.area === e.area && a.closedBy);
    for (const [id, r] of mine) {
      if (gone) {
        if (r.basis?.ref === e.area || r.area?.basis.ref === e.area)
          bad.push(`${e.id} series ${id}: still in ${e.area} after the Cancel`);
      } else if (r.state !== e.state || !r.section || r.basis?.source !== e.source || r.basis.ref !== e.area)
        bad.push(`${e.id} series ${id}: ${r.state}/${r.section}/${r.basis?.ref}, expected ${e.state}/true/${e.area}`);
    }
  }
  return bad.slice(0, 20);
});

check('every state from an area is the level of that area in warnings/latest.geojson', (w) => {
  const rows = rowsOf(w, 'public');
  const f = w.warnings.public;
  if (rows === null || f === null) return ['no latest.json or warnings'];
  const level = new Map(f.features.map((x) => [`${x.properties.source}/${x.properties.area}`, x.properties.level]));
  const names = Object.fromEntries(Object.entries(LEVEL).map(([k, v]) => [v, k]));
  const bad = [];
  const counts = { elevated: 0, high: 0, extreme: 0 };
  for (const [id, r] of rows) {
    const b = r.section ? r.basis : r.area?.basis;
    if (b === null || b === undefined) continue;
    const want = names[level.get(`${b.source}/${b.ref}`)];
    const got = r.section ? r.state : r.area.state;
    if (want === undefined) bad.push(`series ${id}: area ${b.source}/${b.ref} is not in the file`);
    else if (want !== got) bad.push(`series ${id}: ${got} for area ${b.source}/${b.ref} at ${want}`);
    if (r.section && got in counts) counts[got] += 1;
  }
  for (const [state, n] of Object.entries(expected.minimums.sectionStations))
    if (counts[state] < n) bad.push(`only ${counts[state]} stations are ${state} by an area`);
  return bad.slice(0, 20);
});

check('the TEST message stores nothing', (w) => {
  const bad = [];
  for (const f of [w.warnings.public, w.today]) {
    if (f === null) continue;
    for (const x of f.features) {
      const p = x.properties;
      if (
        p.source === expected.absent.source &&
        [p.name, p.label].some((s) => String(s ?? '').startsWith(expected.absent.textPrefix))
      )
        bad.push(`${p.source}/${p.area}: a TEST area is in the file`);
    }
  }
  return bad;
});

if (closed) {
  check('the Cancel closed the northern alert (warnings/today.json)', (w) => {
    const day = w.today;
    if (day === null) return ['no warnings/today.json'];
    const bad = [];
    for (const a of expected.areas.filter((x) => x.closedBy !== undefined)) {
      // The day file lists the areas valid during the UTC day: the closed one, with its end, when its day is today.
      const row = day.features.find((x) => x.properties.source === a.source && x.properties.area === a.area);
      if (
        row !== undefined &&
        (row.properties.to === null || Date.parse(row.properties.to) > Date.parse(day.generatedAt))
      )
        bad.push(`${a.source}/${a.area}: no end in today.json`);
    }
    return bad;
  });
}

check('forecast/latest.json: the CH-4 storm run of station 2020 (public)', (w) => {
  const e = expected.forecast;
  const st = w.stations.public;
  const fc = w.forecast.public;
  if (st === null || fc === null) return ['no stations.json or forecast/latest.json'];
  const series = st.stations.find((s) => s.id === e.station)?.series.find((s) => s.quantity === e.series);
  if (series === undefined) return [`${e.station}: no ${e.series} series in stations.json (the drill registry)`];
  const run = fc.runs.find((r) => r.series === series.id && r.source === e.source);
  if (run === undefined) return [`${e.station}: no ${e.source} run in forecast/latest.json`];
  const bad = [];
  const peak = (xs) => Math.max(...xs.filter((x) => x !== null));
  if (run.agency !== e.agency || run.kind !== e.kind || run.stepSeconds !== e.stepSeconds)
    bad.push('agency, kind or step');
  if (run.band === null || run.band.kind !== e.bandKind || run.band.p25 === null || run.band.vmax === null)
    bad.push('no p25-p75 band');
  else {
    if (Math.abs(peak(run.value) - e.medianPeak) > 0.1) bad.push(`median peak ${peak(run.value)}`);
    if (Math.abs(peak(run.band.vmax) - e.vmaxPeak) > 0.1) bad.push(`maximum peak ${peak(run.band.vmax)}`);
    // The storm's maximum passes the first threshold band (BAFU's 700 m3/s) with the median below it.
    if (!(peak(run.band.vmax) > e.firstThreshold && peak(run.value) < e.firstThreshold))
      bad.push('the storm does not reach the first threshold band');
    for (let i = 0; i < run.validTs.length; i++)
      if (!(run.band.p25[i] <= run.value[i] && run.value[i] <= run.band.p75[i])) {
        bad.push('the median leaves the 25-75 % band');
        break;
      }
  }
  // The run's own times are the recording's, shifted: fetched at the drill clock, starting 8 h 33 min before it.
  if (Date.parse(run.fetchedAt) !== drillNow) bad.push('fetchedAt is not the drill clock');
  if (Date.parse(run.validTs[0]) !== drillNow - e.runStartBeforeFetchSeconds * 1000)
    bad.push('the run does not start where the shifted recording does');
  if (run.issuedInferred !== true || run.providerSegmentEnd !== null) bad.push('issue time or segment end');
  return bad;
});

check('DE-2 (owner audience): the run is in the owner tree and in no public byte', (w) => {
  const e = expected.owner;
  const st = w.stations.owner;
  const fc = w.forecast.owner;
  if (st === null || fc === null) return ['no owner stations.json or forecast/latest.json'];
  const series = st.stations.find((s) => s.id === e.station)?.series.find((s) => s.quantity === 'H');
  if (series === undefined) return [`${e.station}: no H series in the owner stations.json`];
  const run = fc.runs.find((r) => r.series === series.id && r.source === e.source);
  const bad = [];
  if (run === undefined) bad.push(`no ${e.source} run for ${e.station} in the owner forecast/latest.json`);
  else {
    if (
      run.validTs.length !== e.points ||
      Math.min(...run.value) !== e.valueMin ||
      Math.max(...run.value) !== e.valueMax
    )
      bad.push('the run is not the truncated synthetic one');
    if (run.agency !== e.agency) bad.push('agency');
    // Issued 10 minutes before the drill clock, as the shifted payload states it.
    if (Date.parse(run.issuedAt) !== drillNow - 10 * 60_000 || run.issuedInferred) bad.push('issue time');
  }
  const pub = text('public', 'forecast/latest.json');
  const pubSources = text('public', 'sources.json');
  if (pub === null || pubSources === null) bad.push('no public forecast/latest.json or sources.json');
  else if (pub.includes(`"${e.source}"`) || pubSources.includes(`"${e.source}"`))
    bad.push(`${e.source} is named in a public file`);
  return bad;
});

check(
  'the owner canary is in the owner latest.json and in no public file',
  () => {
    const canary = new RegExp(expected.owner.canary.map((c) => c.replace('.', '\\.')).join('|'));
    const bad = [];
    const ownerLatest = text('owner', 'latest.json');
    if (ownerLatest === null || !canary.test(ownerLatest)) bad.push('the owner latest.json does not hold the canary');
    let n = 0;
    if (existsSync(SIDES.public))
      for (const p of files(SIDES.public)) {
        n += 1;
        if (canary.test(readFileSync(p, 'utf8')))
          bad.push(`a public file holds the canary (${p.slice(SIDES.public.length)})`);
      }
    if (n === 0) bad.push('no public file was scanned');
    return bad.slice(0, 5);
  },
  { late: true },
);

// --- the loop ----------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + waitS * 1000;
let results;
for (let round = 0; ; round++) {
  const w = world();
  results = checks.filter((c) => !c.late).map((c) => ({ name: c.name, problems: c.fn(w) }));
  const pending = results.filter((r) => r.problems.length > 0).length;
  if (pending === 0 || Date.now() >= deadline) {
    results.push(...checks.filter((c) => c.late).map((c) => ({ name: c.name, problems: c.fn(w) })));
    break;
  }
  if (round % 6 === 0) console.log(`waiting: ${pending} of ${checks.length} checks not yet true`);
  await sleep(5000);
}
let failures = 0;
for (const r of results) {
  if (r.problems.length === 0) console.log(`PASS ${r.name}`);
  else {
    failures += 1;
    console.log(`FAIL ${r.name}`);
    for (const p of r.problems) console.log(`  - ${p}`);
  }
}
const tag = closed ? 'flood-check' : 'flood-check-open';
if (failures === 0) console.log(`PASS ${tag}`);
else console.log(`FAIL ${tag}: ${failures} of ${checks.length} checks`);
process.exit(failures === 0 ? 0 : 1);
