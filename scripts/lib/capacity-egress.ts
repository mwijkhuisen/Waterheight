// P12a (issue #27, criteria 6 and 7): the egress budget. `apps/web/e2e/egress.spec.ts` measures the bytes on the wire
// of one cold-cache map session per class; `docs/capacity-egress.json` is the committed baseline (profile + owner
// inputs); CI fails above 1.2 x baseline; the egress section of `docs/capacity.md` is rendered from the baseline
// (decision D20). Pure and dependency-free (the spec imports it too); the CLI at the bottom rewrites the section:
//   node scripts/lib/capacity-egress.ts [--adopt <profile.json>]   (the spec's EGRESS_OUT file; keeps the inputs)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CLASSES = ['tiles', 'assets', 'data', 'api', 'html', 'other'] as const;
export type EgressClass = (typeof CLASSES)[number];
export const GROWTH_LIMIT = 1.2;
/** A class may always use this much (a few KB of API answers vary from run to run). */
const CLASS_FLOOR = 51_200;
export const BEGIN = '<!-- egress:begin -->';
export const END = '<!-- egress:end -->';

export interface Profile {
  version: 1;
  note: string;
  /** True for a first estimate that no CI run has replaced yet. */
  provisional?: boolean;
  measured_at: string;
  requests: Record<EgressClass, number>;
  bytes: Record<EgressClass, number>;
  total_bytes: number;
}

/** The owner's inputs (A3 and the traffic assumptions); null = not filled in yet. */
export interface Inputs {
  /** A3: the VPS plan's uplink, Mbit/s. */
  uplink_mbit_s: number | null;
  /** A3: the VPS plan's monthly traffic quota, TB. */
  quota_tb: number | null;
  /** ASSUMPTION: sessions per hour at the flood-day peak. */
  flood_sessions_per_hour: number;
  /** ASSUMPTION: hours of a flood day at the peak rate. */
  flood_hours_per_day: number;
  /** ASSUMPTION: flood days in the worst month. */
  flood_days_per_month: number;
  /** ASSUMPTION: sessions on an ordinary day. */
  normal_sessions_per_day: number;
  /** ASSUMPTION: the peak minute against the hourly mean. */
  burst_factor: number;
}

export interface Baseline extends Profile {
  inputs: Inputs;
}

export function classify(pathname: string): EgressClass {
  if (pathname.startsWith('/tiles/')) return 'tiles';
  if (pathname.startsWith('/assets/')) return 'assets';
  if (pathname.startsWith('/data/v1/')) return 'data';
  if (pathname.startsWith('/api/')) return 'api';
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (pathname.endsWith('/') || !last.includes('.') || last.endsWith('.html')) return 'html';
  return 'other';
}

/** Builds the profile from measured requests: `size` = request + response headers and bodies as transferred. */
export function buildProfile(
  sizes: { url: string; size: number }[],
  note: string,
  measuredAt: string,
  provisional?: boolean,
): Profile {
  const requests = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<EgressClass, number>;
  const bytes = { ...requests };
  for (const s of sizes) {
    const c = classify(new URL(s.url).pathname);
    requests[c] += 1;
    bytes[c] += s.size;
  }
  const total_bytes = CLASSES.reduce((n, c) => n + bytes[c], 0);
  return {
    version: 1,
    note,
    ...(provisional ? { provisional } : {}),
    measured_at: measuredAt,
    requests,
    bytes,
    total_bytes,
  };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function counts(v: unknown, what: string): Record<EgressClass, number> {
  const o = v as Record<string, unknown> | null;
  for (const c of CLASSES) if (typeof o !== 'object' || o === null || !isCount(o[c])) throw new Error(`${what}.${c}`);
  return o as Record<EgressClass, number>;
}

/** Validates a profile read from JSON (no inputs); throws with the field name. */
export function parseProfile(text: string): Profile {
  const o = JSON.parse(text) as Record<string, unknown>;
  if (o.version !== 1 || typeof o.note !== 'string' || typeof o.measured_at !== 'string') throw new Error('header');
  counts(o.requests, 'requests');
  const bytes = counts(o.bytes, 'bytes');
  if (!isCount(o.total_bytes) || o.total_bytes !== CLASSES.reduce((n, c) => n + bytes[c], 0))
    throw new Error('total_bytes');
  return o as unknown as Profile;
}

/** Validates the committed baseline: a profile plus `inputs`. */
export function parseBaseline(text: string): Baseline {
  const p = parseProfile(text);
  const i = (p as unknown as { inputs?: Record<string, unknown> }).inputs;
  if (typeof i !== 'object' || i === null) throw new Error('inputs');
  for (const k of ['uplink_mbit_s', 'quota_tb'] as const)
    if (i[k] !== null && !isCount(i[k])) throw new Error(`inputs.${k}`);
  for (const k of [
    'flood_sessions_per_hour',
    'flood_hours_per_day',
    'flood_days_per_month',
    'normal_sessions_per_day',
    'burst_factor',
  ] as const)
    if (!isCount(i[k])) throw new Error(`inputs.${k}`);
  return p as Baseline;
}

/** Pass/fail lines: the total and each class stay within GROWTH_LIMIT x baseline (a class may always use CLASS_FLOOR). */
export function compare(profile: Profile, baseline: Profile): { ok: boolean; lines: string[] } {
  const rows: [string, number, number][] = [
    ['total', profile.total_bytes, baseline.total_bytes],
    ...CLASSES.map((c): [string, number, number] => [c, profile.bytes[c], baseline.bytes[c]]),
  ];
  let ok = true;
  const lines = rows.map(([name, now, was]) => {
    const limit = Math.max(was * GROWTH_LIMIT, name === 'total' ? 0 : CLASS_FLOOR);
    const pass = now <= limit;
    ok &&= pass;
    return `${pass ? 'PASS' : 'FAIL'} ${name}: ${now} B vs baseline ${was} B (limit ${Math.round(limit)} B)`;
  });
  return { ok, lines };
}

const mb = (n: number) => (n / 1e6).toFixed(2);
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
const FILL = '**OWNER: fill in `inputs` of `docs/capacity-egress.json` (A3)**';

/** The marked egress section of docs/capacity.md, markers included. Deterministic from the baseline. */
export function renderSection(b: Baseline): string {
  const i = b.inputs;
  const peakMbit = (b.total_bytes * i.flood_sessions_per_hour * i.burst_factor * 8) / 3600 / 1e6;
  const monthSessions =
    i.normal_sessions_per_day * 30 + i.flood_sessions_per_hour * i.flood_hours_per_day * i.flood_days_per_month;
  const monthTb = (b.total_bytes * monthSessions) / 1e12;
  const verdict = (use: number, cap: number | null, unit: string) =>
    cap === null
      ? FILL
      : `${((100 * use) / cap).toFixed(1)}% of ${fmt(cap)} ${unit} (${use <= 0.5 * cap ? 'within' : '**over**'} the 50% line)`;
  const { uplink_mbit_s: uplink, quota_tb: quota } = i;
  const known = uplink !== null && quota !== null;
  const holds = uplink !== null && quota !== null && peakMbit <= 0.5 * uplink && monthTb <= 0.5 * quota;
  return [
    BEGIN,
    '## Egress budget (P12a, issue #27; decision D20)',
    '',
    `Generated from \`docs/capacity-egress.json\` by \`node scripts/lib/capacity-egress.ts\`; edit the JSON and re-run it, not this block (\`scripts/verify-prod.sh --capacity\` keeps it).${b.provisional ? ' **The profile is provisional** (a local estimate; the first CI run of `egress.spec.ts` replaces it).' : ''}`,
    '',
    `Profile: one cold-cache map session (open the map, zoom, pan, 2 station panels, 5 timebar steps, 1 day of playback), measured by \`apps/web/e2e/egress.spec.ts\` as bytes on the wire (headers and body, compressed, as transferred), at ${b.measured_at}. ${b.note}`,
    '',
    '| Class | Requests | Bytes (MB) |',
    '|---|---:|---:|',
    ...CLASSES.map((c) => `| ${c} | ${b.requests[c]} | ${mb(b.bytes[c])} |`),
    `| **Session** | ${CLASSES.reduce((n, c) => n + b.requests[c], 0)} | **${mb(b.total_bytes)}** |`,
    '',
    'CI fails when the total or a class grows by more than 20% over the baseline (`EGRESS_UPDATE=1` rewrites it; the change is reviewed like any other). A cold cache is the worst case: a returning visitor re-fetches no hashed asset.',
    '',
    '### Inputs',
    '',
    '| Input | Value | Source |',
    '|---|---:|---|',
    `| VPS uplink (Mbit/s) | ${i.uplink_mbit_s ?? '**OWNER: A3**'} | owner, from the plan ordered in A3 (order minimum: 1000) |`,
    `| Monthly traffic quota (TB) | ${i.quota_tb ?? '**OWNER: A3**'} | owner, from the plan ordered in A3 (order minimum: 20) |`,
    `| Sessions per hour at the flood-day peak | ${fmt(i.flood_sessions_per_hour)} | ASSUMPTION, owner confirms |`,
    `| Hours of a flood day at that rate | ${i.flood_hours_per_day} | ASSUMPTION |`,
    `| Flood days in the worst month | ${i.flood_days_per_month} | ASSUMPTION |`,
    `| Sessions on an ordinary day | ${fmt(i.normal_sessions_per_day)} | ASSUMPTION |`,
    `| Burst factor (peak minute against the hourly mean) | ${i.burst_factor} | ASSUMPTION |`,
    '',
    '### Result',
    '',
    '| Item | Value | Against the plan |',
    '|---|---:|---|',
    `| Flood-day peak egress | ${peakMbit.toFixed(1)} Mbit/s | ${verdict(peakMbit, i.uplink_mbit_s, 'Mbit/s')} |`,
    `| Worst month | ${monthTb.toFixed(2)} TB (${fmt(monthSessions)} sessions) | ${verdict(monthTb, i.quota_tb, 'TB')} |`,
    '',
    `Verdict: ${known ? (holds ? 'both lines hold; no CDN needed.' : '**a line is crossed: arm the D20 fallback before launch.**') : 'not decided until the owner fills in A3.'}`,
    '',
    '### Rule (D20)',
    '',
    'If the flood-day peak exceeds 50% of the uplink **or** the month exceeds 50% of the traffic quota, arm a CDN pull zone for `/tiles/*` and `/assets/*` only (static, licence-neutral) under the same hostname, following `docs/runbooks/cdn-break-glass.md`, and name the CDN on the privacy page before it goes live. **Never switch to OpenFreeMap or any other third-party tile host**: that adds third-party browser requests (invariant 7) and changes the CSP.',
    END,
  ].join('\n');
}

const span = (s: string) => {
  const a = s.indexOf(BEGIN);
  const z = s.indexOf(END);
  return a >= 0 && z > a ? ([a, z + END.length] as const) : null;
};

/** `fresh` (a regenerated docs/capacity.md) with the marked block of `existing` carried over (appended when `fresh` has no markers). */
export function keepEgressBlock(existing: string | null, fresh: string): string {
  const old = existing === null ? null : span(existing);
  if (existing === null || old === null) return fresh;
  const block = existing.slice(old[0], old[1]);
  const at = span(fresh);
  return at === null ? `${fresh.trimEnd()}\n\n${block}\n` : fresh.slice(0, at[0]) + block + fresh.slice(at[1]);
}

/** A capacity.md text with its marked block replaced by `section` (appended when it has none). */
export function withSection(doc: string, section: string): string {
  const at = span(doc);
  return at === null ? `${doc.trimEnd()}\n\n${section}\n` : doc.slice(0, at[0]) + section + doc.slice(at[1]);
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const jsonPath = `${root}docs/capacity-egress.json`;
  const docPath = `${root}docs/capacity.md`;
  const adopt = process.argv[2] === '--adopt' ? process.argv[3] : undefined;
  let baseline = parseBaseline(readFileSync(jsonPath, 'utf8'));
  if (adopt !== undefined) {
    const p = parseProfile(readFileSync(adopt, 'utf8'));
    baseline = { ...p, inputs: baseline.inputs };
    writeFileSync(jsonPath, `${JSON.stringify(baseline, null, 2)}\n`);
  }
  writeFileSync(docPath, withSection(readFileSync(docPath, 'utf8'), renderSection(baseline)));
}
