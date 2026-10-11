// Time shifting primitives of the flood drill (P12a, issue #27; scripts/flood-drill.ts). A drill replays recorded flood
// payloads on the drill clock: every timestamp of a payload moves by ONE offset (drill now - the payload's anchor), so
// the distances inside it (an alert's `sent`, `effective` and `expires`, a Cancel's reference to the alert it closes, a
// run's valid times) are exactly the recorded ones. These functions move one timestamp of one notation; the formats of
// the individual sources are in shift-sources.ts. All of them are pure and exact to the millisecond (Temporal), and
// shifting by d and then by -d gives the input back (WALL notations: except inside a repeated DST hour, see shiftWall).

/** `2026-10-12T07:00:00+02:00`, `2023-11-02T03:00:00.000+01:00`, `2026-10-03T09:42:47Z`: a date-time with an offset. */
export const ISO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

const two = (n: number) => String(n).padStart(2, '0');

/** A zoned time as `YYYY-MM-DDTHH:mm:ss[.SSS]` (as many fraction digits as `digits`) and its offset. */
function iso(z: Temporal.ZonedDateTime, digits: number, offset: string): string {
  const frac = digits === 0 ? '' : `.${String(z.millisecond).padStart(3, '0').slice(0, digits)}`;
  return `${String(z.year).padStart(4, '0')}-${two(z.month)}-${two(z.day)}T${two(z.hour)}:${two(z.minute)}:${two(z.second)}${frac}${offset}`;
}

/** The time zone id Temporal uses for a numeric offset (`+01:00`) or `Z`. */
const fixed = (offset: string) => (offset === 'Z' ? 'UTC' : offset);

export function isIsoOffset(raw: string): boolean {
  return ISO_OFFSET.test(raw);
}

/**
 * An ISO 8601 date-time with an offset, moved by `deltaMs`. Without `zone` the offset text stays as it is (a payload
 * that states a fixed `+01:00` all year keeps it); with `zone` the result is that IANA zone's local time at the new
 * instant, with the zone's offset then (BAFU and PEGELONLINE label in local time: `+01:00` in winter, `+02:00` in
 * summer). The number of fraction digits (0 or 3) is kept.
 */
export function shiftIso(raw: string, deltaMs: number, zone?: string): string {
  const m = ISO_OFFSET.exec(raw);
  if (m === null) throw new Error('shiftIso: not an ISO date-time with an offset');
  const digits = m[7]?.length ?? 0;
  if (digits !== 0 && digits !== 3) throw new Error('shiftIso: only 0 or 3 fraction digits');
  const at = Temporal.Instant.fromEpochMilliseconds(Temporal.Instant.from(raw).epochMilliseconds + deltaMs);
  const offset = m[8] as string;
  if (zone === undefined) return iso(at.toZonedDateTimeISO(fixed(offset)), digits, offset);
  const z = at.toZonedDateTimeISO(zone);
  return iso(z, digits, z.offset);
}

/** The instant (UTC ms) of an ISO date-time with an offset. */
export const isoMs = (raw: string): number => Temporal.Instant.from(raw).epochMilliseconds;

/** The notations of a wall-clock time without an offset. */
const WALL = {
  /** `2024-01-25 15:00:00` (DE-6 station timestamps, Europe/Berlin). */
  space: { re: /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/, sep: '-', ms: false },
  /** `2021/08/17 15:00:00.000` (Vigicrues DhCEntCru, Europe/Paris). */
  slash: { re: /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/, sep: '/', ms: true },
} as const;
export type WallShape = keyof typeof WALL;

function wall(raw: string, shape: WallShape, zone: string): Temporal.ZonedDateTime {
  const m = WALL[shape].re.exec(raw);
  if (m === null) throw new Error(`shiftWall: not a ${shape} wall-clock time`);
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number) as [number, number, number, number, number, number, number?];
  // 'later' is the DE-6 convention for the repeated hour of the clock change (adapters/de-6/normalise.ts); a time in the
  // spring gap does not exist and moves forward.
  return Temporal.PlainDateTime.from({
    year: y,
    month: mo,
    day: d,
    hour: h,
    minute: mi,
    second: s,
    millisecond: ms ?? 0,
  }).toZonedDateTime(zone, { disambiguation: 'later' });
}

/**
 * A wall-clock time in `zone` without an offset, moved by `deltaMs` of real time (not of wall-clock time): it is the
 * zone's local time at the shifted instant. Shifting by d and then -d gives the input back except for a time in the
 * repeated hour of the clock change, which reads back as its later occurrence.
 */
export function shiftWall(raw: string, deltaMs: number, zone: string, shape: WallShape): string {
  const z = Temporal.Instant.fromEpochMilliseconds(
    wall(raw, shape, zone).epochMilliseconds + deltaMs,
  ).toZonedDateTimeISO(zone);
  const date = [String(z.year).padStart(4, '0'), two(z.month), two(z.day)].join(WALL[shape].sep);
  const time = `${two(z.hour)}:${two(z.minute)}:${two(z.second)}`;
  return `${date} ${time}${WALL[shape].ms ? `.${String(z.millisecond).padStart(3, '0')}` : ''}`;
}

/** The instant (UTC ms) of a wall-clock time in `zone`. */
export const wallMs = (raw: string, shape: WallShape, zone: string): number => wall(raw, shape, zone).epochMilliseconds;

/** An epoch number in seconds or milliseconds, moved by `deltaMs`. A second-based epoch needs a delta of whole seconds. */
export function shiftEpoch(value: number, deltaMs: number, unit: 's' | 'ms'): number {
  if (unit === 'ms') return value + deltaMs;
  if (deltaMs % 1000 !== 0) throw new Error('shiftEpoch: a delta in seconds must be a whole number of seconds');
  return value + deltaMs / 1000;
}

/** `YYYYMMDD-HHMMSS` in UTC (the folders of data.public.lu resources), moved by `deltaMs` (whole seconds). */
export function shiftStamp(raw: string, deltaMs: number): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (m === null) throw new Error('shiftStamp: not YYYYMMDD-HHMMSS');
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) + deltaMs;
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * The identifier of an LU-Alert message, `LU-Alert.<epoch>.<n>.<m>`, with the epoch (the second the message was made,
 * which is its `sent`) moved by `deltaMs`. A replayed message must not be the recorded one under a new time: the
 * loader keeps the identifiers of the messages that an Update or a Cancel closed, so a Cancel of the same identifier
 * from the real archive would close the drill's alert before it opened. Another identifier stays as it is.
 */
export function shiftAlertId(id: string, deltaMs: number): string {
  return id.replace(/^(LU-Alert\.)(\d{9,11})(\..+)$/, (_, head: string, epoch: string, tail: string) => {
    return `${head}${shiftEpoch(Number(epoch), deltaMs, 's')}${tail}`;
  });
}

/**
 * The CAP elements that carry a time, the identifier and the `<references>` of an Update or a Cancel (whitespace-
 * separated `sender,identifier,sent` triples: the identifier and the `sent` of each are those of the message it names,
 * so they move with it, shiftAlertId). Anything else in the document stays byte for byte.
 */
export function shiftCap(xml: string, deltaMs: number, zone?: string): string {
  const time = (t: string) => shiftIso(t.trim(), deltaMs, zone);
  return xml
    .replace(
      /<(sent|effective|onset|expires)>([^<]*)<\/\1>/g,
      (_, tag: string, text: string) => `<${tag}>${time(text)}</${tag}>`,
    )
    .replace(
      /<identifier>([^<]*)<\/identifier>/g,
      (_, id: string) => `<identifier>${shiftAlertId(id.trim(), deltaMs)}</identifier>`,
    )
    .replace(/<references>([^<]*)<\/references>/g, (_, text: string) => {
      const moved = text
        .trim()
        .split(/\s+/)
        .filter((t) => t !== '')
        .map((triple) => {
          const parts = triple.split(',');
          if (parts.length !== 3) throw new Error('shiftCap: a reference is sender,identifier,sent');
          return `${parts[0]},${shiftAlertId(parts[1] as string, deltaMs)},${time(parts[2] as string)}`;
        });
      return `<references>${moved.join(' ')}</references>`;
    });
}

/** The instants (UTC ms) of every time element of a CAP document, in document order (for the anchor and the tests). */
export function capTimes(xml: string): number[] {
  return [...xml.matchAll(/<(?:sent|effective|onset|expires)>([^<]*)<\/(?:sent|effective|onset|expires)>/g)].map((m) =>
    isoMs((m[1] as string).trim()),
  );
}
