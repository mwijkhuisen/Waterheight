import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  checkXlsx,
  checkZip,
  decode,
  extractDataToJson,
  flatNames,
  GuardFailure,
  lineSplitter,
  parseJson,
  parseXml,
  scanCsv,
  XLSX_MAX_MEMBERS,
} from '../http/guards.ts';

// Validity assertions (A§7.1): the payload parses under the §6.7 guard of its
// format, required keys are present, error keys absent, and the count at a
// path is at least the minimum. Cheap, run at capture time; an invalid body is
// still archived and raises an alert. The shape fingerprint (JSON key paths or
// the CSV header) raises an alert when it changes.

export const ValiditySpec = z.strictObject({
  format: z.enum(['json', 'csv', 'zip', 'xml', 'xlsx', 'html-attr', 'html', 'text']),
  /** JSON/HTML-attribute/XML: dot paths (a numeric segment indexes an array); CSV: header columns; ZIP/XLSX: members. */
  required: z.array(z.string()).default([]),
  /** Top-level keys whose presence makes a 200 invalid (Vigicrues `error_msg`). */
  reject: z.array(z.string()).default([]),
  /** JSON/XML: dot path of the counted array ('' = the root); ZIP: the member whose lines are counted. */
  count: z.string().optional(),
  min: z.number().int().nonnegative().default(1),
  /** Statuses that are valid with an empty body (RWS 204 = no data). */
  allow_status: z.array(z.number().int()).default([]),
  csv: z
    .strictObject({
      delimiter: z.string().length(1),
      encoding: z.enum(['utf-8', 'latin1']).default('utf-8'),
      comment: z.string().optional(),
    })
    .optional(),
  zip: z
    .strictObject({
      members: z.array(z.string()).min(1),
      /** Expected first line per member. */
      header: z.record(z.string(), z.string()).default({}),
      encoding: z.enum(['utf-8', 'latin1']).default('utf-8'),
      /** 0-based column of an ISO time in the counted member, for seed coverage. */
      time_column: z.number().int().nonnegative().optional(),
      max_members: z.number().int().positive().optional(),
    })
    .optional(),
  /** HTML/text: a pattern the body must contain (bounded regex on ≤ 5 MB). */
  pattern: z.string().optional(),
});
export type ValiditySpec = z.infer<typeof ValiditySpec>;

export type Validity = {
  ok: boolean;
  reason: string | null;
  count: number | null;
  shape: string | null;
  /** The parsed document for gates and coverage (JSON, XML, HTML attribute). */
  doc?: unknown;
  /** First/last timestamps found by a ZIP time column. */
  times?: { min: string; max: string };
};

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Resolves a dot path; a numeric segment indexes an array. */
export function at(doc: unknown, path: string): unknown {
  if (path === '') return doc;
  let cur: unknown = doc;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (cur !== null && typeof cur === 'object' && !Array.isArray(cur))
      cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

/** Sorted unique key paths, arrays collapsed to `[]`, capped; hashed. */
export function jsonShape(doc: unknown): string {
  const paths = new Set<string>();
  const walk = (v: unknown, p: string, depth: number) => {
    if (paths.size > 5000 || depth > 12) return;
    if (Array.isArray(v)) for (const x of v.slice(0, 200)) walk(x, `${p}[]`, depth + 1);
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const q = `${p}.${k}`;
        paths.add(q);
        walk(x, q, depth + 1);
      }
    }
  };
  walk(doc, '', 0);
  return short([...paths].sort().join('\n'));
}

/** The CSV header with digit runs normalised (LU-1 carries timestamps in its header). */
export const csvShape = (header: string[]) => short(header.map((h) => h.replace(/\d+/g, '9')).join('\u0001'));

const invalid = (reason: string, count: number | null = null): Validity => ({ ok: false, reason, count, shape: null });

export async function validate(spec: ValiditySpec, status: number, body: Buffer): Promise<Validity> {
  if (status === 304 || status === 204 || (spec.allow_status.includes(status) && body.length === 0)) {
    return { ok: true, reason: null, count: 0, shape: null };
  }
  if (status < 200 || status > 299) return invalid('status');
  if (body.length === 0) return invalid('empty');
  try {
    switch (spec.format) {
      case 'json':
      case 'html-attr':
      case 'xml': {
        const doc =
          spec.format === 'json' ? parseJson(body) : spec.format === 'xml' ? parseXml(body) : extractDataToJson(body);
        if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
          const keys = Object.keys(doc).map((k) => k.toLowerCase());
          if (spec.reject.some((r) => keys.includes(r.toLowerCase()))) return invalid('error_key');
        }
        for (const path of spec.required) if (at(doc, path) === undefined) return invalid('required');
        let n: number | null = null;
        if (spec.count !== undefined) {
          const counted = at(doc, spec.count);
          n = Array.isArray(counted) ? counted.length : counted === undefined || counted === '' ? 0 : 1;
          if (n < spec.min) return invalid('count', n);
        }
        return { ok: true, reason: null, count: n, shape: jsonShape(doc), doc };
      }
      case 'csv': {
        if (spec.csv === undefined) return invalid('config');
        const { header, rows } = scanCsv(body, {
          delimiter: spec.csv.delimiter,
          encoding: spec.csv.encoding,
          ...(spec.csv.comment === undefined ? {} : { commentPrefix: spec.csv.comment }),
        });
        for (const col of spec.required) if (!header.includes(col)) return invalid('required');
        if (rows.length < spec.min) return invalid('count', rows.length);
        return { ok: true, reason: null, count: rows.length, shape: csvShape(header), doc: { header } };
      }
      case 'zip': {
        const z = spec.zip;
        if (z === undefined) return invalid('config');
        const firstLines = new Map<string, string>();
        let lines = 0;
        let min: string | undefined;
        let max: string | undefined;
        const members = await checkZip(body, {
          names: flatNames(z.members),
          ...(z.max_members === undefined ? {} : { maxMembers: z.max_members }),
          onMember: (name) => {
            let first = true;
            const split = lineSplitter((line) => {
              if (first) {
                firstLines.set(name, line.replace(/^﻿/, ''));
                first = false;
                return;
              }
              if (name !== spec.count) return;
              // DE-7 members: column and field caps per line (the ZIP total bounds the rows).
              const cells = line.split(';');
              if (cells.length > 1000 || cells.some((c) => c.length > 1024)) throw new GuardFailure('csv_line');
              if (line.trim() === '') return;
              lines += 1;
              const t = z.time_column === undefined ? undefined : cells[z.time_column]?.trim();
              if (t) {
                if (min === undefined || t < min) min = t;
                if (max === undefined || t > max) max = t;
              }
            }, z.encoding);
            return { data: split.push, end: split.end };
          },
        });
        const names = members.map((m) => m.name);
        for (const m of spec.required) if (!names.includes(m)) return invalid('required');
        for (const [m, h] of Object.entries(z.header)) if (firstLines.get(m) !== h) return invalid('header');
        if (spec.count !== undefined && lines < spec.min) return invalid('count', lines);
        return {
          ok: true,
          reason: null,
          count: spec.count === undefined ? members.length : lines,
          shape: short(names.sort().join('\n')),
          ...(min !== undefined && max !== undefined ? { times: { min, max } } : {}),
        };
      }
      case 'xlsx': {
        const names = await checkXlsx(body, spec.zip?.max_members ?? XLSX_MAX_MEMBERS);
        for (const m of spec.required) if (!names.includes(m)) return invalid('required');
        return { ok: true, reason: null, count: names.length, shape: null };
      }
      case 'html':
      case 'text': {
        if (body.length > 5 * 1024 * 1024) return invalid('size');
        const text = decode(body);
        if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(text)) return invalid('pattern');
        // A truncated page lacks its closing tag; a truncated text file its final newline.
        if (spec.format === 'html' ? !/<\/html>\s*$/i.test(text) : !text.endsWith('\n')) return invalid('truncated');
        return { ok: true, reason: null, count: null, shape: null, doc: text };
      }
    }
  } catch (e) {
    if (e instanceof GuardFailure) return invalid(e.reason);
    return invalid('parse');
  }
}
