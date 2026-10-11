// The flood drill (P12a, issue #27, catalogue §0.4): replays the recorded flood payloads of the P7/P8 fixtures on the
// drill clock into the raw archive of the compose end-to-end stack, so that replay -> load -> publish -> UI run
// unchanged. Every payload keeps the distances inside it and moves by ONE offset (drill now - lead - the payload's own
// anchor instant, scripts/lib/shift-sources.ts; the offset differs from payload to payload because the recordings are of
// different days, and a message and the Cancel that names it share one), the manifest line is fetched at the drill now,
// and nothing a payload states about the past is later than that fetch (the 15-minute future rule of invariant 4). The
// one payload with two clocks, the LHP test server's stations (its answer is dated the day it was asked, its readings
// are the flood of 2024), gets two offsets, one for each. The loader tails the manifest, so the lines load as a capture's
// would. The real archive of run.sh (every fixture of fixture-archive.ts) is loaded first: the drill's messages carry
// their own identifiers (shiftAlertId), because the loader remembers which identifiers a Cancel closed.
//
//   scripts/flood-drill [--phase main|cancel|all] [--now <UTC instant>] [<raw dir>]     (the sh wrapper; run as root)
//
// It refuses to run anywhere but the stack of deploy/tests/e2e/run.sh in drill mode: /ci/e2e-stack must exist and say
// mode drill and the domain rivierstanden.example, RWS_E2E=1 must be set, and the wrapper hands in the domain of
// /ci/loadtest.env. Nothing is fetched (the wrapper runs it with no network), and no fixture is read but the committed
// ones. Fixtures of an owner-audience source (DE-2) are synthetic, as invariant 9 and 11 say.
//
// The main phase writes everything but the end of the AGE story; the cancel phase writes the Cancel of the northern
// alert and the TEST message, so a check can see the alert open first (deploy/tests/flood/run.sh). The scenes:
//   DE-6   the LHP test server's stations (classes 0 and 1 on our stations) and alerts (areas 1, 2, 4, 5), the synthetic
//          class-4 Kaub (RP) and the class-less features;
//   FR-5   the Vigicrues map with sections at levels 2, 3 and 4 (shift-fr5.ts);
//   LU-5   the real AGE red alert of 2025-09-08 (Sud) and the orange one (Nord), the Cancel of the Nord alert, and the
//          TEST message of 2026-02-02 (which must store nothing);
//   CH-4   the storm-Ciaran run of station 2020 (the German layout), a test-only station of the drill registry;
//   DE-2   the synthetic truncated run at Kaub (owner audience).

import { readFileSync } from 'node:fs';
import type { ManifestLine } from '../apps/server/src/archive/manifest.ts';
import { Archive } from '../apps/server/src/archive/writer.ts';
import { writePayload } from './fixture-archive.ts';
import {
  anchorCap,
  anchorDe2,
  anchorDe6,
  anchorDe6Events,
  ciaranToDe,
  shiftCh4,
  shiftDe2,
  shiftDe6,
  shiftFr5,
  shiftLu5,
  shiftLu5Url,
  waybackMs,
} from './lib/shift-sources.ts';

export const MARKER = '/ci/e2e-stack';
export const E2E_DOMAIN = 'rivierstanden.example';
const MIN = 60_000;
const HOUR = 3_600_000;

/** Why the drill must not run here, or null. Only fixed texts: nothing of the environment is echoed. */
export function refusal(
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string) => string | null,
): string | null {
  if (env.RWS_E2E !== '1') return 'RWS_E2E=1 is not set';
  const text = read(MARKER);
  if (text === null) return `${MARKER} does not exist: this is not the compose end-to-end stack`;
  let marker: { mode?: unknown; domain?: unknown } | null;
  try {
    marker = JSON.parse(text) as typeof marker;
  } catch {
    return `${MARKER} is not JSON`;
  }
  if (marker?.mode !== 'drill') return `${MARKER} does not say mode drill`;
  if (marker.domain !== E2E_DOMAIN) return `the stack's domain is not ${E2E_DOMAIN}`;
  if (env.RWS_E2E_DOMAIN !== E2E_DOMAIN) return `RWS_E2E_DOMAIN is not ${E2E_DOMAIN}`;
  return null;
}

const ADAPTERS = new URL('../apps/server/src/adapters/', import.meta.url);
type Meta = { variant?: string; url?: string; recorded_at?: string };

function load(source: string, name: string): { body: Buffer; meta: Meta } {
  const dir = new URL(`${source.toLowerCase()}/fixtures/`, ADAPTERS);
  return {
    body: readFileSync(new URL(`${name}.raw`, dir)),
    meta: JSON.parse(readFileSync(new URL(`${name}.meta.json`, dir), 'utf8')) as Meta,
  };
}

export type Phase = 'main' | 'cancel';
export type Scene = {
  id: string;
  source: string;
  spec: string;
  fixture: string;
  phase: Phase;
  /** Of an owner-audience source: it must reach the owner tree and never the public one. */
  owner?: true;
  /** The manifest variant. */
  variant: (meta: Meta) => string;
  /** The recorded request URL (shifted where it names a time). */
  url: (meta: Meta, deltaMs: number) => string;
  /** A conversion before the shift (the Ciaran figure's Italian trace names). */
  prepare?: (body: Buffer) => Buffer;
  /** The instant (UTC ms) the payload is about: of the body, or of what it was cut from. */
  anchor: (body: Buffer, meta: Meta) => number;
  /** The anchor lands this long before the drill now. */
  leadMs: number;
  /**
   * A payload with two clocks (the LHP test server's stations: the answer is dated the day it was asked, its features
   * the flood of 2024): the anchor of the ANSWER and how long before the drill now it lands. `anchor` is then the
   * event clock. Without it the payload has one clock and `shift` gets the one offset twice.
   */
  response?: { anchor: (body: Buffer) => number; leadMs: number };
  shift: (body: Buffer, deltaMs: number, responseDeltaMs: number) => Buffer;
};

const plain = (meta: Meta) => meta.variant ?? '';
const recordedUrl = (meta: Meta) => meta.url ?? '';

/** The AGE story of 2025-09-08 is one clock: every message of it moves by the offset of the red alert's `sent`. */
const AGE_RED = 'lu-5-cap-20250908-231502-alert-lvl1';
const ageAnchor = () => anchorCap(load('LU-5', AGE_RED).body);
/** The red alert was sent 9 hours ago; its Cancel (8 h 50 min after the northern alert) was sent 10 minutes ago. */
const AGE_LEAD = 9 * HOUR;

/** `leadMin`: how long before now the answer (`updated`) lands; `eventLeadMin`: the same for the events of the test server. */
const de6 = (fixture: string, spec: string, leadMin: number, eventLeadMin?: number): Scene => ({
  id: fixture,
  source: 'DE-6',
  spec,
  fixture,
  phase: 'main',
  variant: plain,
  url: recordedUrl,
  ...(eventLeadMin === undefined
    ? { anchor: (body: Buffer) => anchorDe6(body), leadMs: leadMin * MIN }
    : {
        anchor: (body: Buffer) => anchorDe6Events(body),
        leadMs: eventLeadMin * MIN,
        response: { anchor: (body: Buffer) => anchorDe6(body), leadMs: leadMin * MIN },
      }),
  shift: shiftDe6,
});
const age = (fixture: string, phase: Phase): Scene => ({
  id: fixture,
  source: 'LU-5',
  spec: 'lu-5-cap',
  fixture,
  phase,
  variant: plain,
  url: (meta, d) => shiftLu5Url(meta.url ?? '', d),
  anchor: ageAnchor,
  leadMs: AGE_LEAD,
  shift: shiftLu5,
});

export const SCENES: readonly Scene[] = [
  // The classes are stamped at the instant of their reading and the newest one of a station is the one it has: the
  // test server's flood (its newest reading 35 minutes ago, the answer 30) is newer than the P7 base archive's classes
  // of 2026-10-03, and the synthetic class-4 Kaub (RP) and the class-less features, 25 and 20 minutes old, are newer
  // than the test server's. The alerts are 15 minutes old.
  de6('de-6-stations-test', 'de-6-stations', 30, 35),
  de6('de-6-stations-class4.synthetic', 'de-6-stations', 25),
  de6('de-6-stations-classless.synthetic', 'de-6-stations', 20),
  de6('de-6-alerts-test', 'de-6-alerts', 15),
  {
    id: 'fr-5-vigilance-level4.synthetic',
    source: 'FR-5',
    spec: 'fr-5-vigilance',
    fixture: 'fr-5-vigilance-level4.synthetic',
    phase: 'main',
    variant: plain,
    url: recordedUrl,
    // The map states no time of its own (as the Wayback body): the fetch dates it. The anchor is the Wayback capture
    // the structure comes from, placed at the drill now.
    anchor: (_, meta) => waybackMs(meta.url ?? ''),
    leadMs: 0,
    shift: shiftFr5,
  },
  age(AGE_RED, 'main'),
  age('lu-5-cap-20250908-231507-alert-lvl2', 'main'),
  age('lu-5-cap-20250909-080450-cancel', 'cancel'),
  {
    id: 'lu-5-cap-20260202-095833-alert-test',
    source: 'LU-5',
    spec: 'lu-5-cap',
    fixture: 'lu-5-cap-20260202-095833-alert-test',
    phase: 'cancel',
    variant: plain,
    url: (meta, d) => shiftLu5Url(meta.url ?? '', d),
    anchor: (body) => anchorCap(body),
    leadMs: 5 * MIN,
    shift: shiftLu5,
  },
  {
    id: 'ch-4-forecast-ciaran-it',
    source: 'CH-4',
    spec: 'ch-4-forecast',
    fixture: 'ch-4-forecast-ciaran-it',
    phase: 'main',
    variant: () => '2020',
    // What production fetches: the German figure of the station (the recording is the Italian one).
    url: () => 'https://www.hydrodaten.admin.ch/plots/q_forecast/2020_q_forecast_de.json',
    prepare: ciaranToDe,
    // The Wayback capture time: the run was fetched then, its peak 8 h 27 min later.
    anchor: (_, meta) => waybackMs(meta.url ?? ''),
    leadMs: 0,
    shift: shiftCh4,
  },
  {
    id: 'de-2-wv-truncated.synthetic',
    source: 'DE-2',
    spec: 'de-2-wv',
    fixture: 'de-2-wv-truncated.synthetic',
    phase: 'main',
    owner: true,
    // Kaub's PEGELONLINE uuid (the DE-1 stage series the run sits on).
    variant: () => '1d26e504-7f9e-480a-b52c-5932be6549ab',
    url: () =>
      'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/1d26e504-7f9e-480a-b52c-5932be6549ab/WV/measurements.json',
    anchor: (body) => anchorDe2(body),
    leadMs: 10 * MIN,
    shift: shiftDe2,
  },
];

export type Planned = {
  scene: Scene;
  deltaMs: number;
  body: Buffer;
  url: string;
  variant: string;
  /** The anchor on the drill clock. */
  placed: number;
  /** The offset of the answer's own clock (the same as `deltaMs` but for a payload with two clocks). */
  responseDeltaMs: number;
};

/** The payloads of one phase on the drill clock `now` (UTC ms), shifted but not yet written. */
export function plan(now: number, phase: Phase | 'all' = 'all'): Planned[] {
  return SCENES.filter((s) => phase === 'all' || s.phase === phase).map((scene) => {
    const { body: recorded, meta } = load(scene.source, scene.fixture);
    // The derived fixture is checked against its own derivation by the drill's test.
    const body = scene.prepare === undefined ? recorded : scene.prepare(recorded);
    const placed = now - scene.leadMs;
    const deltaMs = placed - scene.anchor(recorded, meta);
    const responseDeltaMs =
      scene.response === undefined ? deltaMs : now - scene.response.leadMs - scene.response.anchor(recorded);
    return {
      scene,
      deltaMs,
      body: scene.shift(body, deltaMs, responseDeltaMs),
      url: scene.url(meta, deltaMs),
      variant: scene.variant(meta),
      placed,
      responseDeltaMs,
    };
  });
}

export type WriteOptions = {
  rawDir: string;
  /** The drill clock (UTC ms): the distance of every payload from "now". */
  now: number;
  phase?: Phase | 'all';
  /** When the lines are fetched (UTC ms); the drill now by default, a later time for the cancel phase. */
  fetchedAt?: number;
};

/** Writes the objects and the manifest lines through the recorder's own Archive. Returns the lines. */
export async function writeDrill(opts: WriteOptions): Promise<ManifestLine[]> {
  const fetchedAt = opts.fetchedAt ?? opts.now;
  if (fetchedAt < opts.now) throw new Error('flood-drill: lines cannot be fetched before the drill clock');
  const archive = new Archive(opts.rawDir);
  const lines: ManifestLine[] = [];
  for (const p of plan(opts.now, opts.phase ?? 'all')) {
    // Nothing a payload is about may be later than its fetch (invariant 4); the forecasts' valid times and an alert's
    // expiry are ahead of it by design and are not what the anchor names.
    if (p.placed > fetchedAt) throw new Error(`flood-drill: ${p.scene.id} would be dated after its fetch`);
    lines.push(
      await writePayload(archive, {
        source: p.scene.source,
        spec: p.scene.spec,
        variant: p.variant,
        at: new Date(fetchedAt),
        body: p.body,
        url: p.url,
        retention: 'forever',
      }),
    );
  }
  return lines;
}

const USAGE = 'usage: scripts/flood-drill [--phase main|cancel|all] [--now <UTC instant>] [<raw dir>]';

/** The command line: 0, 64 (usage) or 78 (refused). */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string) => string | null,
  clock: () => number = Date.now,
): Promise<number> {
  const why = refusal(env, read);
  if (why !== null) {
    console.error(`flood-drill: refused: ${why}`);
    return 78;
  }
  let phase: Phase | 'all' = 'all';
  let now: number | undefined;
  let rawDir = '/srv/rws/raw';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--phase') {
      const v = argv[++i];
      if (v !== 'main' && v !== 'cancel' && v !== 'all') return usage();
      phase = v;
    } else if (a === '--now') {
      const v = Date.parse(argv[++i] ?? '');
      if (Number.isNaN(v)) return usage();
      now = v;
    } else if (a.startsWith('-')) return usage();
    else rawDir = a;
  }
  const real = Math.floor(clock() / 1000) * 1000;
  now ??= real;
  // The drill clock is the stack's clock: a run that was started minutes ago, never another day.
  if (Math.abs(real - now) > 2 * HOUR) {
    console.error('flood-drill: --now is more than 2 hours from the clock');
    return 64;
  }
  // The main phase is fetched at the drill now; the cancel phase, written minutes later, at the clock then.
  const lines = await writeDrill({ rawDir, now, phase, fetchedAt: phase === 'cancel' ? Math.max(now, real) : now });
  console.log(
    `flood-drill: ${lines.length} manifest lines (${lines.filter((l) => l.key !== null).length} payloads), phase ${phase}, drill clock ${new Date(now).toISOString()}`,
  );
  return 0;
}

function usage(): number {
  console.error(USAGE);
  return 64;
}

if (import.meta.main) {
  process.umask(0o027);
  process.exitCode = await main(process.argv.slice(2), process.env, (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  });
}
