/**
 * Pure functions turning raw Rijkswaterstaat payloads into our own shapes.
 *
 * Kept free of I/O so they can be tested against recorded fixtures rather than
 * the live service. Every quirk handled here was observed in a real response;
 * see spike/PHASE1-FINDINGS.md.
 */

import { GAP_QUALITY_CODE } from '@rws/shared';
import type {
  AquoCode,
  AquoMetadata,
  Meting,
  OphalenCatalogusResponse,
  OphalenWaarnemingenResponse,
  WaarnemingMetadata,
} from './types.js';

/** Identity of one physical measurement stream, before it gets a series_id. */
export interface SeriesIdentity {
  locationCode: string;
  compartiment: string;
  grootheid: string;
  eenheid: string | null;
  parameter: string | null;
  procesType: string;
  hoedanigheid: string | null;
  typering: string | null;
  orgaan: string | null;
  biotaxon: string | null;
  groepering: string | null;
  bemonsteringApparaat: string | null;
  bemonsteringMethode: string | null;
  bemonsteringSoort: string | null;
  meetapparaat: string | null;
  waardebepalingMethode: string | null;
  waardebepalingTechniek: string | null;
  waardebewerkingMethode: string | null;
  bemonsteringshoogte: string | null;
  referentievlak: string | null;
  opdrachtgevendeInstantie: string | null;
  description: string | null;
  naturalKey: string;
}

export interface NormalisedPoint {
  /** ISO 8601 in UTC. */
  t: string;
  /** Null for gaps and non-numeric readings; the raw text is kept in `text`. */
  value: number | null;
  text: string | null;
  qualityCode: string | null;
  status: string | null;
}

export interface NormalisedSeries {
  identity: SeriesIdentity;
  location: { code: string; name: string | null; lat: number | null; lon: number | null };
  points: NormalisedPoint[];
}

/**
 * Location codes were unified upstream (HOEK, HVH25 and HOEKVHLD all became
 * hoekvanholland). Treat them as lowercase dotted strings throughout.
 */
export function normaliseLocationCode(code: string): string {
  return code.trim().toLowerCase();
}

/** Convert an RWS timestamp to ISO 8601 in UTC. */
export function toUtcIso(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new Error(`Unparseable timestamp: ${JSON.stringify(timestamp)}`);
  return new Date(ms).toISOString();
}

function code(v: AquoCode | undefined): string | null {
  const c = v?.Code;
  // Upstream uses both '' and 'NVT' ("not applicable") for absent dimensions.
  if (c === undefined || c === null || c === '') return null;
  return c;
}

/**
 * A stable canonical key over every dimension that distinguishes one series
 * from another. Used as the upsert conflict target, which avoids a 20-column
 * ON CONFLICT clause.
 *
 * Field order is part of the contract: changing it changes every key, so
 * append new dimensions at the end rather than inserting them.
 */
export function buildNaturalKey(parts: readonly (string | null)[]): string {
  return parts.map((p) => (p ?? '')).join('|');
}

export function seriesIdentity(
  locationCode: string,
  aquo: AquoMetadata | undefined,
  meta: WaarnemingMetadata | undefined,
): SeriesIdentity {
  const loc = normaliseLocationCode(locationCode);
  const compartiment = code(aquo?.Compartiment) ?? 'NVT';
  const grootheid = code(aquo?.Grootheid) ?? 'NVT';
  // ProcesType is absent on some payloads; observations default to 'meting'.
  const procesType = (aquo?.ProcesType ?? 'meting').toLowerCase();

  const identity: Omit<SeriesIdentity, 'naturalKey'> = {
    locationCode: loc,
    compartiment,
    grootheid,
    eenheid: code(aquo?.Eenheid),
    parameter: code(aquo?.Parameter),
    procesType,
    hoedanigheid: code(aquo?.Hoedanigheid),
    typering: code(aquo?.Typering),
    orgaan: code(aquo?.Orgaan),
    biotaxon: code(aquo?.BioTaxon),
    groepering: code(aquo?.Groepering),
    bemonsteringApparaat: code(aquo?.BemonsteringsApparaat),
    bemonsteringMethode: code(aquo?.BemonsteringsMethode),
    bemonsteringSoort: code(aquo?.BemonsteringsSoort),
    meetapparaat: code(aquo?.MeetApparaat),
    waardebepalingMethode: code(aquo?.WaardeBepalingsMethode),
    waardebepalingTechniek: code(aquo?.WaardeBepalingsTechniek),
    waardebewerkingMethode: code(aquo?.WaardeBewerkingsMethode),
    bemonsteringshoogte: meta?.Bemonsteringshoogte ?? null,
    referentievlak: meta?.Referentievlak ?? null,
    opdrachtgevendeInstantie: meta?.OpdrachtgevendeInstantie ?? null,
    description: aquo?.Parameter_Wat_Omschrijving ?? aquo?.Grootheid?.Omschrijving ?? null,
  };

  return {
    ...identity,
    naturalKey: buildNaturalKey([
      identity.locationCode,
      identity.compartiment,
      identity.grootheid,
      identity.eenheid,
      identity.parameter,
      identity.procesType,
      identity.hoedanigheid,
      identity.typering,
      identity.orgaan,
      identity.biotaxon,
      identity.groepering,
      identity.bemonsteringApparaat,
      identity.bemonsteringMethode,
      identity.bemonsteringSoort,
      identity.meetapparaat,
      identity.waardebepalingMethode,
      identity.waardebepalingTechniek,
      identity.waardebewerkingMethode,
      identity.bemonsteringshoogte,
      identity.referentievlak,
      identity.opdrachtgevendeInstantie,
    ]),
  };
}

/**
 * Normalise one measurement.
 *
 * Quality code '99' marks a gap and arrives with a 99999 sentinel value, while
 * real readings on the same series sit in a completely different range. Storing
 * that sentinel as a number would poison every min/max/mean downstream, so the
 * numeric value is dropped while the raw text and code are preserved.
 */
export function normalisePoint(meting: Meting): NormalisedPoint {
  const qualityCode = meting.WaarnemingMetadata?.Kwaliteitswaardecode ?? null;
  const text = meting.Meetwaarde?.Waarde_Alfanumeriek ?? null;
  const raw = meting.Meetwaarde?.Waarde_Numeriek;

  const isGap = qualityCode === GAP_QUALITY_CODE;
  const value = isGap || raw === undefined || raw === null || !Number.isFinite(raw)
    ? null
    : raw;

  return {
    t: toUtcIso(meting.Tijdstip),
    value,
    text,
    qualityCode,
    status: meting.WaarnemingMetadata?.Statuswaarde ?? null,
  };
}

/**
 * Normalise an OphalenWaarnemingen response into one entry per distinct series.
 *
 * Two upstream quirks are handled here. The same metadata can come back spread
 * over several MetingenLijst entries, so points are merged by series identity
 * rather than by array position. And a timestamp can repeat within a series, so
 * duplicates are collapsed keeping the later-arriving row -- except that a real
 * reading always beats a gap, since a gap carries no information.
 */
export function normaliseObservations(
  response: OphalenWaarnemingenResponse,
): NormalisedSeries[] {
  const bySeries = new Map<string, NormalisedSeries & { byTs: Map<string, NormalisedPoint> }>();

  for (const waarneming of response.WaarnemingenLijst ?? []) {
    const rawCode = waarneming.Locatie?.Code;
    if (!rawCode) continue;

    for (const meting of waarneming.MetingenLijst ?? []) {
      // Bemonsteringshoogte and friends live on the measurement, not the
      // series header, and they are part of what makes a series distinct.
      const identity = seriesIdentity(
        rawCode,
        waarneming.AquoMetadata,
        meting.WaarnemingMetadata,
      );

      let entry = bySeries.get(identity.naturalKey);
      if (!entry) {
        entry = {
          identity,
          location: {
            code: identity.locationCode,
            name: waarneming.Locatie?.Naam ?? null,
            lat: waarneming.Locatie?.Lat ?? null,
            lon: waarneming.Locatie?.Lon ?? null,
          },
          points: [],
          byTs: new Map(),
        };
        bySeries.set(identity.naturalKey, entry);
      }

      let point: NormalisedPoint;
      try {
        point = normalisePoint(meting);
      } catch {
        // A single unparseable timestamp must not discard the whole series.
        continue;
      }

      const existing = entry.byTs.get(point.t);
      if (existing && existing.value !== null && point.value === null) continue;
      entry.byTs.set(point.t, point);
    }
  }

  return [...bySeries.values()].map(({ byTs, ...series }) => ({
    ...series,
    points: [...byTs.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)),
  }));
}

/**
 * Latest value per series from OphalenLaatsteWaarnemingen.
 *
 * The endpoint may return several rows where one is expected, so this collapses
 * to a single most-recent point per series.
 */
export function normaliseLatest(
  response: OphalenWaarnemingenResponse,
): { identity: SeriesIdentity; point: NormalisedPoint }[] {
  const out = new Map<string, { identity: SeriesIdentity; point: NormalisedPoint }>();

  for (const series of normaliseObservations(response)) {
    const latest = series.points.at(-1);
    if (!latest) continue;
    const current = out.get(series.identity.naturalKey);
    if (!current || latest.t > current.point.t) {
      out.set(series.identity.naturalKey, { identity: series.identity, point: latest });
    }
  }

  return [...out.values()];
}

export interface AquoCodeRow {
  domain: string;
  code: string;
  description: string | null;
}

/**
 * Flatten the catalogue's metadata combinations into distinct code lists, for
 * the filter UI. The catalogue is ~6.5 MB and mostly cross-references we do not
 * need; only the code lists themselves are kept.
 */
export function normaliseCatalogue(response: OphalenCatalogusResponse): AquoCodeRow[] {
  const domains: [string, (m: AquoMetadata) => AquoCode | undefined][] = [
    ['grootheid', (m) => m.Grootheid],
    ['compartiment', (m) => m.Compartiment],
    ['eenheid', (m) => m.Eenheid],
    ['parameter', (m) => m.Parameter],
    ['hoedanigheid', (m) => m.Hoedanigheid],
  ];

  const seen = new Map<string, AquoCodeRow>();
  for (const meta of response.AquoMetadataLijst ?? []) {
    for (const [domain, pick] of domains) {
      const c = code(pick(meta));
      if (!c) continue;
      const key = `${domain} ${c}`;
      if (!seen.has(key)) {
        seen.set(key, { domain, code: c, description: pick(meta)?.Omschrijving ?? null });
      }
    }
  }
  return [...seen.values()];
}
