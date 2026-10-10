// The time notations of the flood drill's payloads, one function per format (P12a, issue #27; the primitives are in
// shift.ts). Each `shift*` moves EVERY timestamp of one payload by the same `deltaMs` and returns the new bytes; each
// `anchor*` names the instant the payload is about (the drill puts that instant at "drill now - lead"). A key that
// carries no time is never touched, and provider text is data: only the keys and elements named here are read.
//
//   DE-6   `updated` and `lastModified` (ISO, a fixed +01:00 all year: the offset stays) and each station feature's
//          `timestamp` (Europe/Berlin wall time without an offset);
//   FR-5   DhCEntCru / DhMEntCru of each section (Europe/Paris wall time, `YYYY/MM/DD HH:mm:ss.SSS`) and, when a
//          capture has it, the map's own `DtHrInfoVigiCru` (ISO);
//   LU-5   sent, effective, onset and expires of a CAP message, and the `sent` inside <references> (Europe/Luxembourg);
//   CH-4   every ISO time of the Plotly figure (the traces' x, the layout's shapes, ticks and annotations), rendered in
//          Europe/Berlin local time as BAFU labels them;
//   DE-2   `initialized` and `timestamp` of each point (Europe/Berlin, as PEGELONLINE labels them).

import { isIsoOffset, isoMs, shiftCap, shiftEpoch, shiftIso, shiftStamp, shiftWall, wallMs } from './shift.ts';

const BERLIN = 'Europe/Berlin';
const PARIS = 'Europe/Paris';
const LUXEMBOURG = 'Europe/Luxembourg';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const text = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
const parse = (body: Uint8Array) => JSON.parse(text(body)) as Json;
const bytes = (doc: Json) => Buffer.from(JSON.stringify(doc));

const isObj = (v: Json | undefined): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The document with every string leaf passed through `fn` (a copy: the input is not changed). */
export function mapStrings(v: Json, fn: (s: string) => string): Json {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

/** Sets `obj[key]` to `fn(value)` when it is a string; any other value (absent, null) stays. */
function onString(obj: Obj, key: string, fn: (s: string) => string): void {
  const v = obj[key];
  if (typeof v === 'string') obj[key] = fn(v);
}

// --- DE-6 ---------------------------------------------------------------------------------------------------------

function de6Doc(body: Uint8Array): Obj {
  const doc = parse(body);
  if (!isObj(doc) || typeof doc.updated !== 'string') throw new Error('DE-6: not an LHP collection');
  return doc;
}

/** The collection's `updated`: the instant of the answer (the drill puts it a little before now). */
export const anchorDe6 = (body: Uint8Array): number => isoMs(de6Doc(body).updated as string);

/**
 * The newest feature `timestamp` of a stations collection: the instant of the event it states (the LHP test server
 * answers with the flood of 2024-01-25 and an `updated` of the day it was asked), as UTC ms.
 */
export function anchorDe6Events(body: Uint8Array): number {
  const times = ((de6Doc(body).features as Json[] | undefined) ?? []).flatMap((f) => {
    const t = isObj(f) && isObj(f.properties) ? f.properties.timestamp : undefined;
    return typeof t === 'string' ? [wallMs(t, 'space', BERLIN)] : [];
  });
  if (times.length === 0) throw new Error('DE-6: no feature timestamp');
  return Math.max(...times);
}

/**
 * `updated` and `lastModified` move by `responseDeltaMs`, each feature's `timestamp` by `deltaMs`. They are one offset
 * for a collection whose answer and events are one clock (the live API, the synthetic payloads: the default); the test
 * server's answer is dated the day it was asked while its events are the flood of 2024, so a drill puts the flood at the
 * drill clock and the answer just after it, two offsets of one payload.
 */
export function shiftDe6(body: Uint8Array, deltaMs: number, responseDeltaMs: number = deltaMs): Buffer {
  const doc = de6Doc(body);
  onString(doc, 'updated', (s) => shiftIso(s, responseDeltaMs));
  onString(doc, 'lastModified', (s) => shiftIso(s, responseDeltaMs));
  if (Array.isArray(doc.features))
    for (const f of doc.features)
      if (isObj(f) && isObj(f.properties))
        onString(f.properties, 'timestamp', (s) => shiftWall(s, deltaMs, BERLIN, 'space'));
  return bytes(doc);
}

// --- FR-5 ---------------------------------------------------------------------------------------------------------

/** The Wayback capture time of an archive.org URL (`/web/20231211164225id_/…`), in UTC ms. */
export function waybackMs(url: string): number {
  const m = /\/web\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:id_)?\//.exec(url);
  if (m === null) throw new Error('not a Wayback URL');
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

export function shiftFr5(body: Uint8Array, deltaMs: number): Buffer {
  const doc = parse(body);
  if (!isObj(doc)) throw new Error('FR-5: not a GeoJSON collection');
  onString(doc, 'DtHrInfoVigiCru', (s) => shiftIso(s, deltaMs));
  if (Array.isArray(doc.features))
    for (const f of doc.features)
      if (isObj(f) && isObj(f.properties))
        for (const key of Object.keys(f.properties))
          if (/^dh[cm]entcru$/i.test(key)) onString(f.properties, key, (s) => shiftWall(s, deltaMs, PARIS, 'slash'));
  return bytes(doc);
}

// --- LU-5 ---------------------------------------------------------------------------------------------------------

/** The `sent` of a CAP message. */
export function anchorCap(body: Uint8Array): number {
  const m = /<sent>([^<]*)<\/sent>/.exec(text(body));
  if (m === null) throw new Error('LU-5: no <sent>');
  return isoMs((m[1] as string).trim());
}

export const shiftLu5 = (body: Uint8Array, deltaMs: number): Buffer =>
  Buffer.from(shiftCap(text(body), deltaMs, LUXEMBOURG));

/**
 * The URL of a data.public.lu dump (`…/resources/<dataset>/<YYYYMMDD-HHMMSS>/dump-alert.<epoch>.xml`) with the folder's
 * stamp and the file's epoch moved by `deltaMs` (whole seconds), so that the manifest line names a time that fits the
 * shifted message. Another URL is returned as it is.
 */
export function shiftLu5Url(url: string, deltaMs: number): string {
  const whole = Math.round(deltaMs / 1000) * 1000;
  return url.replace(
    /\/(\d{8}-\d{6})\/dump-alert\.(\d{9,11})\.xml$/,
    (_, stamp: string, epoch: string) =>
      `/${shiftStamp(stamp, whole)}/dump-alert.${shiftEpoch(Number(epoch), whole, 's')}.xml`,
  );
}

// --- CH-4 ---------------------------------------------------------------------------------------------------------

/** The names of BAFU's `_it` figure by position and what the German figure (production's `_de`) calls them. */
export const CIARAN_IT = ['Min. / Max.', 'Min / Max', '25.-75. percentile', 'Mediana', 'Misurato'] as const;
export const CIARAN_DE = ['Min. / Max.', 'Min. / Max.', '25.-75. Perzentil', 'Median', 'Gemessen'] as const;

/**
 * The storm-Ciarán figure of station 2020 (a Wayback capture of the Italian `_it` figure) as the German `_de` figure
 * production fetches: the five traces carry the German names, nothing else changes. A figure whose traces are not the
 * Italian five is refused (a different capture must be looked at, not renamed).
 */
export function ciaranToDe(body: Uint8Array): Buffer {
  const doc = parse(body);
  const traces = isObj(doc) && isObj(doc.plot) ? doc.plot.data : undefined;
  if (!Array.isArray(traces) || traces.length !== CIARAN_IT.length) throw new Error('CH-4: not the five-trace figure');
  traces.forEach((t, i) => {
    if (!isObj(t) || t.name !== CIARAN_IT[i]) throw new Error(`CH-4: trace ${i} is not "${CIARAN_IT[i]}"`);
    t.name = CIARAN_DE[i] as string;
  });
  return bytes(doc);
}

export function shiftCh4(body: Uint8Array, deltaMs: number): Buffer {
  return bytes(mapStrings(parse(body), (s) => (isIsoOffset(s) ? shiftIso(s, deltaMs, BERLIN) : s)));
}

// --- DE-2 ---------------------------------------------------------------------------------------------------------

function de2Points(body: Uint8Array): Obj[] {
  const doc = parse(body);
  if (!Array.isArray(doc) || !doc.every(isObj)) throw new Error('DE-2: not an array of points');
  return doc as Obj[];
}

/** The run's `initialized`: the issue time. */
export function anchorDe2(body: Uint8Array): number {
  const first = de2Points(body)[0];
  if (typeof first?.initialized !== 'string') throw new Error('DE-2: no initialized');
  return isoMs(first.initialized);
}

export function shiftDe2(body: Uint8Array, deltaMs: number): Buffer {
  const points = de2Points(body);
  for (const p of points) {
    onString(p, 'initialized', (s) => shiftIso(s, deltaMs, BERLIN));
    onString(p, 'timestamp', (s) => shiftIso(s, deltaMs, BERLIN));
  }
  return bytes(points);
}
