import { z } from 'zod';
import { SourceId } from './registry.ts';

// P7a registry tables beside the station files: the provider label table (catalogue gap item 19), the LHP station
// map with its duplicate rule (DE-6), the Vigicrues station → section table and its overrides (FR-5), and the
// reviewed NL-4 → NL-1 code map. Read with aliases off (`yaml` parse, maxAliasCount 0) and checked strictly here;
// the generated ones are rewritten only by their generators (CI diffs them).

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // No control or format (bidirectional) character in reviewed text: it is shown beside provider text.
    .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s), 'control or format character');

const StationId = z.string().regex(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]{1,80}$/);

/**
 * `registry/labels/<SOURCE-ID>.yaml`: our reviewed NL and EN text for each provider class, alert level or
 * reference kind, keyed by our own code (never by provider prose, which may embed a value). The raw provider label
 * is always stored in the row and shown beside ours (P10).
 */
export const LabelEntry = z.strictObject({
  /** The scale the code belongs to (a source may publish several, never mixed: DE-6 `station` and `alert`). */
  scale: z.string().regex(/^[a-z0-9_]{1,20}$/),
  code: z.string().min(1).max(80),
  nl: text(200),
  en: text(200),
  /** The provider's own colour of the class where it publishes one (LHP legend), kept for P10. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type LabelEntry = z.infer<typeof LabelEntry>;

export const LabelFile = z
  .strictObject({ source: SourceId, labels: z.array(LabelEntry).min(1).max(500) })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const l of f.labels) {
      const key = `${l.scale}\n${l.code}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `label ${l.scale}/${l.code} twice` });
      seen.add(key);
    }
  });
export type LabelFile = z.infer<typeof LabelFile>;

/**
 * `registry/classes/de-6.yaml` (scripts/gen-de6-stations.ts): each LHP station feature that is one of our DE-1 or
 * DE-7 stations (same number, within 500 m), with its state, and whether that state operates the gauge. Features
 * of one station are an LHP duplicate group (catalogue §4.9): the operating state's class, else the worst other.
 */
export const LhpStation = z.strictObject({
  lhp: z.string().regex(/^[A-Z]{2}_[0-9A-Za-z]{1,20}$/),
  station: StationId,
  state: z.string().regex(/^[A-Z]{2}$/),
  operator: z.boolean(),
});
export type LhpStation = z.infer<typeof LhpStation>;

export const LhpStationsFile = z.strictObject({ stations: z.array(LhpStation).max(3000) }).superRefine((f, ctx) => {
  const lhp = new Set<string>();
  const operators = new Map<string, number>();
  for (const s of f.stations) {
    if (lhp.has(s.lhp)) ctx.addIssue({ code: 'custom', message: `${s.lhp} twice` });
    lhp.add(s.lhp);
    if (s.operator) operators.set(s.station, (operators.get(s.station) ?? 0) + 1);
  }
  for (const station of new Set(f.stations.map((s) => s.station))) {
    if (operators.get(station) !== 1) ctx.addIssue({ code: 'custom', message: `${station}: not one operator` });
  }
});
export type LhpStationsFile = z.infer<typeof LhpStationsFile>;

const SectionCode = z.string().regex(/^[A-Z0-9]{1,8}$/);
const VigicruesStation = z.string().regex(/^[A-Z0-9]{8,12}$/);

/**
 * `registry/vigicrues-sections.yaml` (scripts/gen-fr5-sections.ts, from the TronEntVigiCru `aNMoinsUn` lists of
 * territories 2, 3 and 29; catalogue §2.5, C38): every Vigicrues station of a section, with our FR-1 station when
 * one is registered (null otherwise), each station in exactly one section; and our FR-1 stations that no section
 * covers (the French Escaut, Scarpe and Deûle).
 */
export const VigicruesSectionsFile = z
  .strictObject({
    sections: z
      .array(
        z.strictObject({
          section: SectionCode,
          territory: z.enum(['2', '3', '29']),
          stations: z.array(z.strictObject({ vigicrues: VigicruesStation, station: StationId.nullable() })).max(200),
        }),
      )
      .max(200),
    none: z.array(StationId).max(500),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const s of f.sections)
      for (const m of s.stations) {
        if (seen.has(m.vigicrues)) ctx.addIssue({ code: 'custom', message: `${m.vigicrues} in two sections` });
        seen.add(m.vigicrues);
      }
  });
export type VigicruesSectionsFile = z.infer<typeof VigicruesSectionsFile>;

/** `registry/vigicrues-overrides.yaml` (hand-written, reviewed): a station moved to another section, or to none. */
export const VigicruesOverridesFile = z.strictObject({
  overrides: z
    .array(z.strictObject({ vigicrues: VigicruesStation, section: SectionCode.nullable(), reason: text(300) }))
    .max(100),
});
export type VigicruesOverridesFile = z.infer<typeof VigicruesOverridesFile>;

/**
 * `registry/thresholds/nl-4-map.yaml` (reviewed): the NL-4 workbook `Code` is the NL-1 `Locatie.Code` (both are
 * RWS DDL codes); `none` lists the registered NL-1 primary series that have no class in the edition, with why.
 */
export const Nl4MapFile = z.strictObject({
  edition: z.iso.date(),
  rule: text(300),
  none: z
    .array(z.strictObject({ code: z.string().min(1).max(80), quantity: z.enum(['H', 'Q']), reason: text(300) }))
    .max(200),
});
export type Nl4MapFile = z.infer<typeof Nl4MapFile>;
