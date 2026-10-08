import { boundedJson, cappedArray, parseStrict, SchemaDrift, xmlOverCaps } from '@rws/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

// LU-5 LU-Alert CAP 1.2 (catalogue §2.6, §6.7): one alert file of the data.public.lu dump, and the dataset's
// resource list page. The CAP text comes from the wire (load/wire/lu-5.ts: size, UTF-8 and the XML guard), and is
// checked again here because this module is never told where its input came from. Anything it does not know is a
// SchemaDrift with a fixed code, never provider text. Nothing is resolved: a DOCTYPE or ENTITY declaration is
// refused before the parser sees the text, and fast-xml-parser runs with entities off (the five predefined ones and
// numeric references are decoded by hand, so `&amp;#39;` in a description, an HTML text escaped twice by the
// provider, ends as `&#39;`, which we keep as text and never put into an HTML sink). Texts hold no control or bidi
// character.
//
// Only AGE's files (`<sender>[AGE]`) go through the strict schema. The dump also holds the files of Meteolux, the
// Police, CGDIS, ALVA and `LU-Alert` itself, with CAP elements, sizes and characters AGE never sends (a `<circle>`,
// 11 areas in a block, a left-to-right mark in a headline): after the same XML guards, such a file is `{ other: true }`
// and none of its text is decoded or kept (#72). A missing, repeated or empty sender is `not_cap`.
//
// Caps are about 5× the largest of the 25 real files (2026-10-03: 38 KB, 218 tags and attributes, 3 info
// blocks, 167 points in a ring, a 1,966 character description, 2 referenced messages), except the text fields,
// which are the length the stored warning rows allow.

/** Characters of one CAP file (38,223 real). The wire refuses a body over 1 MiB first. */
export const MAX_CHARS = 1024 * 1024;
/** Tags plus attributes of one file (218 real). */
export const MAX_ITEMS = 2_000;
const MAX_TAG = 16 * 1024;
const MAX_DEPTH = 32;
export const MAX_INFO = 8;
export const MAX_AREA = 8;
export const MAX_POLYGON = 8;
export const MAX_PARAMETER = 30;
const MAX_REFERENCES_CHARS = 10_000;
/** Of the stored warning text (WarningRow.texts): the longest real description is 1,966 characters. */
const MAX_LONG_TEXT = 8000;
const MAX_POLYGON_CHARS = 200_000;

/** AGE's `<sender>`, decoded: the only sender whose files are schema-checked and stored. */
export const SENDER = '[AGE]';

/** A file of another sender: nothing of it is kept. */
export type OtherSender = { readonly other: true };

/** The profile namespace as published (`…:cap:1.2:profile:cap-lu:1.0`); any 1.2 profile is accepted. */
const NAMESPACE = /^urn:oasis:names:tc:emergency:cap:1\.2(?::[A-Za-z0-9._-]{1,40}){0,4}$/;

/** A character no text of ours may hold, decoded or raw: a control (tab, line feed and CR aside), a lone surrogate, a bidi control. */
const FORBIDDEN_TEXT = /[[\p{Cc}--[\t\n\r]]\p{Cs}\p{Bidi_Control}￾￿]/v;

const PREDEFINED = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);
const REFERENCE = /&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#x([\dA-Fa-f]{1,6}));|&/g;

const drift = (code: string): never => {
  throw new SchemaDrift(code);
};

/** An XML 1.0 Char. */
const isXmlChar = (cp: number) =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

/** Character data with its references decoded: the five predefined entities and numeric references, nothing else. */
function decode(raw: string): string {
  const text = raw.replace(REFERENCE, (_, name?: string, dec?: string, hex?: string) => {
    if (name !== undefined) return PREDEFINED.get(name) as string;
    const cp = dec !== undefined ? Number(dec) : hex !== undefined ? Number.parseInt(hex, 16) : -1;
    if (!isXmlChar(cp)) return drift('xml_reference');
    return String.fromCodePoint(cp);
  });
  return FORBIDDEN_TEXT.test(text) ? drift('text_char') : text;
}

/** The parsed tree with every string decoded (depth is bounded by MAX_DEPTH). */
function decoded(node: unknown): unknown {
  if (typeof node === 'string') return decode(node);
  if (Array.isArray(node)) return node.map(decoded);
  if (typeof node === 'object' && node !== null)
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, decoded(v)]));
  return node;
}

/** Whether a raw `<sender>` decodes to AGE's; one that does not decode cleanly (decode throws only SchemaDrift) is not. */
function isAge(raw: string): boolean {
  try {
    return decode(raw) === SENDER;
  } catch {
    return false;
  }
}

const text = (max: number) => z.string().max(max);
const Pair = z.strictObject({ valueName: text(200), value: text(500) });

const Area = z.strictObject({
  areaDesc: text(120).min(1),
  polygon: cappedArray(text(MAX_POLYGON_CHARS), MAX_POLYGON).default([]),
  geocode: cappedArray(Pair, 10).default([]),
});

const Info = z.strictObject({
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,5})?$/),
  category: z.enum([
    'Geo',
    'Met',
    'Safety',
    'Security',
    'Rescue',
    'Fire',
    'Health',
    'Env',
    'Transport',
    'Infra',
    'CBRNE',
    'Other',
  ]),
  event: text(200),
  eventCode: cappedArray(Pair, 5).default([]),
  urgency: z.enum(['Immediate', 'Expected', 'Future', 'Past', 'Unknown']),
  severity: z.enum(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']),
  certainty: z.enum(['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']),
  effective: text(40).optional(),
  expires: text(40).optional(),
  senderName: text(200).optional(),
  headline: text(500).optional(),
  description: text(MAX_LONG_TEXT).optional(),
  instruction: text(MAX_LONG_TEXT).optional(),
  web: text(500).optional(),
  contact: text(500).optional(),
  parameter: cappedArray(Pair, MAX_PARAMETER).default([]),
  area: cappedArray(Area, MAX_AREA).default([]),
});

export type CapInfo = z.infer<typeof Info>;

const Alert = z.strictObject({
  '@_xmlns': z.string().regex(NAMESPACE),
  identifier: text(200).min(1),
  sender: text(100).min(1),
  sent: text(40),
  status: z.enum(['Actual', 'Exercise', 'System', 'Test', 'Draft']),
  msgType: z.enum(['Alert', 'Update', 'Cancel']),
  scope: z.enum(['Public', 'Restricted', 'Private']),
  code: text(100).optional(),
  references: text(MAX_REFERENCES_CHARS).optional(),
  info: cappedArray(Info, MAX_INFO).default([]),
});

export type CapAlert = Omit<z.infer<typeof Alert>, '@_xmlns'>;

// Elements that may repeat; a repeated element of any other name is an array where a string is wanted: drift.
const REPEATED = new Set(['info', 'area', 'polygon', 'parameter', 'eventCode', 'geocode']);

const parser = new XMLParser({
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name) => REPEATED.has(name),
});

const ENCODING = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([^"']+)["']/;

/**
 * One CAP 1.2 alert file. Every file passes the XML guards (entities, DOCTYPEs, a non-UTF-8 declaration, the tag,
 * item and depth caps, well-formedness, prototype names) and needs one non-empty `<sender>`. A file of AGE is then
 * parsed under the strict schema: namespaces other than CAP 1.2, unknown elements or attributes and a list or text
 * over its cap are drift. A file of any other sender is `{ other: true }`, unread past its sender.
 */
export function parseCap(xml: string): CapAlert | OtherSender {
  if (xml.length > MAX_CHARS) drift('xml_size');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) drift('xml_dtd');
  const declared = ENCODING.exec(xml)?.[1];
  if (declared !== undefined && declared.toLowerCase() !== 'utf-8') drift('xml_encoding');
  const over = xmlOverCaps(xml, { maxTag: MAX_TAG, maxItems: MAX_ITEMS, maxDepth: MAX_DEPTH });
  if (over !== null) drift(over);
  if (XMLValidator.validate(xml) !== true) drift('xml_invalid');
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    // fast-xml-parser refuses an element or attribute named `__proto__`, `constructor` or `prototype`.
    return drift('xml_name');
  }
  const root = (doc as { alert?: unknown } | null)?.alert;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return drift('not_cap');
  // A missing, repeated (an array), attributed (an object) or empty sender names no one: drift, never other_sender.
  const sender = (root as { sender?: unknown }).sender;
  if (typeof sender !== 'string' || sender === '') return drift('not_cap');
  if (!isAge(sender)) return { other: true };
  const { '@_xmlns': _ns, ...alert } = parseStrict(Alert, decoded(root), ['alert']);
  return alert;
}

// ---------------------------------------------------------------- the resource list page

/** The dataset's resource list: 487 values for a page of 20. Only its shape is checked; nothing is stored. */
const ListPage = z.looseObject({
  data: cappedArray(z.looseObject({ id: text(40), title: text(200), url: text(500) }), 100),
});

export function parseList(body: string): void {
  parseStrict(ListPage, boundedJson(body, { maxNodes: 5_000, maxDepth: 8 }));
}
