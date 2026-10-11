import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// P12b (plan §3.2, §9): a temp copy of registry/ as the E1 flip commit makes it, never the real registry/permissions/.
// DE-2 is public with its private_basis removed and its channels unchanged, and permissions/DE-2.md is the committed
// template with test values in place of every front-matter TODO (so the template's keys stay PermissionRecord's).

const REGISTRY = new URL('../../../../registry/', import.meta.url);

/** Test values for the template's front matter: a grant of the channels DE-2 uses today, nothing more. */
const VALUES: Record<string, string> = {
  granted_by: '"Test organisation (P12b flip simulation)"',
  granted_on: '"2026-10-01"',
  evidence: '"none: a test fixture"',
  audience: '"public"',
  display: 'true',
  api: 'true',
  bulk_export: 'false',
  history_export: 'true',
};

/** The template's text with every front-matter TODO filled in from VALUES (an unknown TODO key throws). */
export function filledTemplate(): string {
  const text = readFileSync(new URL('permissions/DE-2.md.template', REGISTRY), 'utf8');
  return text.replace(/^([a-z_]+): TODO\b.*$/gm, (_, key: string) => {
    const value = VALUES[key];
    if (value === undefined) throw new Error(`DE-2.md.template: no test value for ${key}`);
    return `${key}: ${value}`;
  });
}

/** sources.yaml with DE-2 public and its private_basis removed (unchanged once the flip commit has done so). */
export function flippedSources(text: string): string {
  const block = /\n {2}- id: DE-2\n[\s\S]*?(?=\n {2}- id: )/.exec(text)?.[0];
  if (block === undefined) throw new Error('sources.yaml: no DE-2 block');
  if (block.includes('\n    audience: public\n') && block.includes('\n    private_basis: null\n')) return text;
  const flipped = block
    .replace('\n    audience: owner\n', () => '\n    audience: public\n')
    .replace(/\n {4}private_basis:\n(?: {6}.*\n)+/, () => '\n    private_basis: null\n');
  if (!flipped.includes('audience: public') || !flipped.includes('private_basis: null'))
    throw new Error('sources.yaml: the DE-2 block changed shape');
  return text.replace(block, () => flipped);
}

/** A temp registry: DE-2 flipped, with (`record`) or without permissions/DE-2.md. */
export function de2FlipRegistry(record = true): { dir: string; url: URL; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rws-de2-flip-'));
  cpSync(REGISTRY, dir, { recursive: true });
  writeFileSync(join(dir, 'sources.yaml'), flippedSources(readFileSync(join(dir, 'sources.yaml'), 'utf8')));
  if (record) writeFileSync(join(dir, 'permissions', 'DE-2.md'), filledTemplate());
  else rmSync(join(dir, 'permissions', 'DE-2.md'), { force: true });
  return { dir, url: pathToFileURL(`${dir}/`), remove: () => rmSync(dir, { recursive: true, force: true }) };
}
