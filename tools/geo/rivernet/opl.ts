// Reader for `osmium cat -t relation -f opl,add_metadata=false`: `r<id> T<k=v,…> M<w123@role,…>`.
// Escapes follow libosmium's append_utf8_encoded_string. Errors carry a fixed code and a line number only.

import { InputError } from './geojsonseq.ts';

export interface Member {
  type: 'n' | 'w' | 'r';
  ref: number;
  role: string;
}
export interface Relation {
  id: number;
  tags: Record<string, string>;
  members: Member[];
}
export interface OplCaps {
  maxBytes: number;
  maxLines: number;
  maxMembers: number;
  maxTags: number;
  maxTagChars: number;
}

export const OPL_CAPS: OplCaps = {
  maxBytes: 64 * 1024 * 1024,
  maxLines: 200_000,
  maxMembers: 20_000,
  maxTags: 200,
  maxTagChars: 255,
};

// Code points libosmium writes as they are; everything else (space, `,`, `=`, `@`, `%`, most non-ASCII) is %hex%.
const RAW: [number, number][] = [
  [0x21, 0x24],
  [0x26, 0x2b],
  [0x2d, 0x3c],
  [0x3e, 0x3f],
  [0x41, 0x7e],
  [0xa1, 0xac],
  [0xae, 0x5ff],
];
const isRaw = (cp: number) => RAW.some(([lo, hi]) => cp >= lo && cp <= hi);
const ESCAPE = /^%([0-9a-f]{1,6})%/;

/** Decode one field. A raw character that libosmium would have escaped is an error, so is a bad escape. */
function decode(field: string, line: number): string {
  let out = '';
  for (let i = 0; i < field.length; ) {
    const cp = field.codePointAt(i) as number;
    if (cp === 0x25) {
      const m = ESCAPE.exec(field.slice(i, i + 9));
      const value = m ? Number.parseInt(m[1] as string, 16) : -1;
      if (!m || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw new InputError('bad_escape', line);
      out += String.fromCodePoint(value);
      i += m[0].length;
    } else if (isRaw(cp)) {
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
    } else {
      throw new InputError('bad_escape', line);
    }
  }
  return out;
}

const posInt = (s: string): number | null =>
  /^[1-9][0-9]{0,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;

function parseTags(body: string, caps: OplCaps, line: number): Record<string, string> {
  if (body === '') return {};
  const items = body.split(',');
  if (items.length > caps.maxTags) throw new InputError('too_many_tags', line);
  const entries = new Map<string, string>();
  for (const item of items) {
    const eq = item.split('=');
    if (eq.length !== 2 || eq[0] === '') throw new InputError('bad_tag', line);
    const key = decode(eq[0] as string, line);
    const value = decode(eq[1] as string, line);
    if (key.length > caps.maxTagChars || value.length > caps.maxTagChars || entries.has(key)) {
      throw new InputError('bad_tag', line);
    }
    entries.set(key, value);
  }
  return Object.fromEntries(entries);
}

function parseMembers(body: string, caps: OplCaps, line: number): Member[] {
  if (body === '') return [];
  const items = body.split(',');
  if (items.length > caps.maxMembers) throw new InputError('too_many_members', line);
  return items.map((item) => {
    const at = item.split('@');
    const type = item[0];
    const ref = posInt(((at[0] as string) ?? '').slice(1));
    if (at.length !== 2 || (type !== 'n' && type !== 'w' && type !== 'r') || ref === null) {
      throw new InputError('bad_member', line);
    }
    const role = decode(at[1] as string, line);
    if (role.length > caps.maxTagChars) throw new InputError('bad_member', line);
    return { type, ref, role };
  });
}

export function parseOplRelations(text: string, caps: Partial<OplCaps> = {}): Relation[] {
  const c: OplCaps = { ...OPL_CAPS, ...caps };
  if (Buffer.byteLength(text) > c.maxBytes) throw new InputError('input_too_large', 0);
  const relations: Relation[] = [];
  const seen = new Set<number>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (raw === '') continue;
    const line = i + 1;
    if (relations.length >= c.maxLines) throw new InputError('too_many_lines', line);
    if (raw[0] !== 'r') throw new InputError('not_relation', line);
    const fields = raw.split(' ');
    const [head, t, m] = fields as [string, string, string];
    if (fields.length !== 3 || t[0] !== 'T' || m[0] !== 'M') throw new InputError('bad_field', line);
    const id = posInt(head.slice(1));
    if (id === null) throw new InputError('bad_field', line);
    if (seen.has(id)) throw new InputError('duplicate_relation', line);
    seen.add(id);
    relations.push({ id, tags: parseTags(t.slice(1), c, line), members: parseMembers(m.slice(1), c, line) });
  }
  return relations;
}
