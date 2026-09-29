// Synthetic fixtures for owner-audience specs (invariants 9 and 11): reads the
// git-ignored .smoke/<spec>.raw recorded by smoke-capture.ts and writes
// apps/server/src/adapters/<id>/fixtures/<spec>.synthetic.raw with the real
// structure (keys, array shapes, KiWIS header rows, comment/header lines) and
// every value, name, id and timestamp generated. Deterministic (seeded).
//
//   node scripts/synthesize-fixture.ts --spec <owner spec id> [--keep <n>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import { extractDataToJson } from '../apps/server/src/http/guards.ts';

const root = join(import.meta.dirname, '..');
let seed = 20300101;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 2 ** 32;
};
let clock = Date.parse('2030-01-01T00:00:00Z');
let names = 0;

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2}(?:\.\d{3})?)?(Z|[+-]\d{2}:\d{2})?$/;

function fakeTime(like: string): string {
  clock += 15 * 60_000;
  const m = ISO.exec(like);
  const iso = new Date(clock).toISOString();
  if (!m) return iso;
  const secs = m[6] === undefined ? '' : m[6].includes('.') ? iso.slice(16, 23) : iso.slice(16, 19);
  return `${iso.slice(0, 16)}${secs}${m[7] ?? ''}`;
}

function fakeNumber(n: number): number {
  if (n === 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(n)));
  const v = (0.1 + rnd() * 0.9) * mag * 10 * Math.sign(n);
  return Number.isInteger(n) ? Math.round(v) : Math.round(v * 1000) / 1000;
}

function fakeString(s: string): string {
  if (ISO.test(s)) return fakeTime(s);
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return String(fakeNumber(Number(s))).slice(0, Math.max(1, s.length + 2));
  names += 1;
  return `synthetic-${names}`;
}

/** Scrambles every value; keeps keys, array lengths up to `keep`, and a KiWIS header row. */
function scramble(v: unknown, keep: number): unknown {
  if (Array.isArray(v)) {
    const header = Array.isArray(v[0]) && (v[0] as unknown[]).every((x) => typeof x === 'string') && v.length > 1;
    return v.slice(0, keep).map((x, i) => (header && i === 0 ? x : scramble(x, keep)));
  }
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scramble(x, keep)]));
  }
  if (typeof v === 'number') return fakeNumber(v);
  if (typeof v === 'string') return fakeString(v);
  return v;
}

/** Text files (BfG CSV): comment lines keep their words with dates and numbers replaced; data cells are generated. */
function scrambleText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('#'))
        return line.replace(/\d{4}-\d{2}-\d{2}/g, '2030-01-01').replace(/\d+/g, (d) => '9'.repeat(d.length));
      if (/^Datum;/.test(line) || line.trim() === '') return line;
      if (!line.includes(';')) return `${fakeString(line.trim())}\r`.replace(/\r\r$/, '\r');
      return line
        .split(';')
        .map((c, i) => {
          if (i === 0 && /^\d{2}\.\d{2}\.\d{4}/.test(c)) {
            clock += 86_400_000;
            const d = new Date(clock);
            return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()} 00:00`;
          }
          return /^-?\d+(?:\.\d+)?\r?$/.test(c)
            ? String(fakeNumber(Number(c.trim()))) + (c.endsWith('\r') ? '\r' : '')
            : c;
        })
        .join(';');
    })
    .join('\n');
}

const args = process.argv.slice(2);
const id = args[args.indexOf('--spec') + 1] ?? '';
const keep = Number(args.includes('--keep') ? args[args.indexOf('--keep') + 1] : 40);
const spec = loadRegistry().specs.find((s) => s.id === id);
if (spec === undefined || spec.audience !== 'owner') {
  console.error('synthesize-fixture: give an owner-audience --spec');
  process.exit(64);
}
const raw = readFileSync(join(root, '.smoke', `${id}.raw`));
let out: string;
switch (spec.validity.format) {
  case 'json':
    out = JSON.stringify(scramble(JSON.parse(raw.toString('utf8')), keep));
    break;
  case 'html-attr': {
    const doc = scramble(extractDataToJson(raw), keep);
    const attr = JSON.stringify(doc).replace(/&/g, '&amp;').replace(/"/g, '&#34;');
    out = `<!DOCTYPE html>\n<html lang="fr"><head><title>synthetic</title></head><body>\n<cmp-dashboard-station class="synthetic" data-to-json="${attr}"></cmp-dashboard-station>\n</body></html>\n`;
    break;
  }
  case 'html': {
    const links = (raw.toString('utf8').match(/href="\.\/[^"]*\.csv"/g) ?? []).map(
      (_, i) => `<a href="./synthetic-${i}.csv">synthetic-${i}.csv</a>`,
    );
    out = `<!DOCTYPE html>\n<html><head><title>synthetic</title></head><body>\n${links.join('\n')}\n</body></html>\n`;
    break;
  }
  case 'text':
    out = scrambleText(raw.toString('latin1'));
    break;
  default:
    console.error(`synthesize-fixture: format ${spec.validity.format} not supported`);
    process.exit(64);
}
const dir = join(root, 'apps/server/src/adapters', spec.source.toLowerCase(), 'fixtures');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${id}.synthetic.raw`), out);
writeFileSync(
  join(dir, `${id}.synthetic.meta.json`),
  `${JSON.stringify(
    {
      spec: id,
      source: spec.source,
      synthetic: true,
      derived_from: 'the structure of a live payload recorded 2026-09-29 (owner audience: not committed)',
      values: 'every value, name, id and timestamp generated (scripts/synthesize-fixture.ts)',
      status: 200,
    },
    null,
    2,
  )}\n`,
);
console.log(`${id}: ${out.length} B → ${dir}/${id}.synthetic.raw`);
