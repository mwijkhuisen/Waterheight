// The security headers of deploy/web/site.caddy: the ONE source of the
// production CSP. The sandbox test server sends exactly these, CI serves the
// same file through the real Caddy image, and the specs compare against it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const siteCaddy = fileURLToPath(new URL('../../../deploy/web/site.caddy', import.meta.url));

/** [name, value] pairs of the site's first header block (the same block test/verify-prod.test.ts reads). */
export function siteHeaders(): [string, string][] {
  const block = /\n\theader \{\n([\s\S]*?)\n\t\}/.exec(readFileSync(siteCaddy, 'utf8'))?.[1];
  if (block === undefined) throw new Error('site.caddy has no header block');
  const out: [string, string][] = [];
  for (const line of block.split('\n')) {
    // A value may hold escaped quotes (Reporting-Endpoints "csp=\"/api/v1/beacon\""): Caddyfile `\"` and `\\`.
    const header = /^\t\t([A-Za-z-]+) "((?:[^"\\]|\\.)*)"$/.exec(line);
    if (header?.[1] !== undefined && header[2] !== undefined)
      out.push([header[1], header[2].replaceAll(/\\(.)/g, '$1')]);
    else if (!/^\t\t-[A-Za-z-]+$/.test(line)) throw new Error(`unexpected header line: ${line}`);
  }
  return out;
}

export const productionCsp = (): string => {
  const csp = siteHeaders().find(([name]) => name === 'Content-Security-Policy')?.[1];
  if (csp === undefined) throw new Error('site.caddy sends no CSP');
  return csp;
};
