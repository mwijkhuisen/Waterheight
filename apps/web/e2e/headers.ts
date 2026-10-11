// The security headers of deploy/web/site.caddy: the ONE source of the
// production CSP. The sandbox test server sends exactly these, CI serves the
// same file through the real Caddy image, and the specs compare against it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const siteCaddy = fileURLToPath(new URL('../../../deploy/web/site.caddy', import.meta.url));
const ownerCaddy = fileURLToPath(new URL('../../../deploy/web/owner.caddy', import.meta.url));

/**
 * [name, value] pairs of the site's first header block (the same block test/verify-prod.test.ts reads); the owner
 * site's block (P10a) is the same set plus Cache-Control "private, no-store" and `defer`.
 */
export function siteHeaders(owner = false): [string, string][] {
  const block = /\n\theader \{\n([\s\S]*?)\n\t\}/.exec(readFileSync(owner ? ownerCaddy : siteCaddy, 'utf8'))?.[1];
  if (block === undefined) throw new Error('the caddy file has no header block');
  const out: [string, string][] = [];
  for (const line of block.split('\n')) {
    // A value may hold escaped quotes (Reporting-Endpoints "csp=\"/api/v1/beacon\""): Caddyfile `\"` and `\\`.
    const header = /^\t\t([A-Za-z-]+) "((?:[^"\\]|\\.)*)"$/.exec(line);
    if (header?.[1] !== undefined && header[2] !== undefined)
      out.push([header[1], header[2].replaceAll(/\\(.)/g, '$1')]);
    else if (!/^\t\t(-[A-Za-z-]+|defer)$/.test(line)) throw new Error(`unexpected header line: ${line}`);
  }
  return out;
}

export const productionCsp = (): string => {
  const csp = siteHeaders().find(([name]) => name === 'Content-Security-Policy')?.[1];
  if (csp === undefined) throw new Error('site.caddy sends no CSP');
  return csp;
};

/**
 * The body of /.well-known/security.txt (P12a, RFC 9116) as site.caddy's heredoc holds it, with the domain placeholder
 * filled in: the stand-in serves it and routes.spec.ts compares the real Caddy's answer with it.
 * test/security-txt.test.ts checks its content.
 */
export function securityTxt(domain: string): string {
  const body = /respond <<SECURITY\n([\s\S]*?)\n\t*SECURITY 200/.exec(readFileSync(siteCaddy, 'utf8'))?.[1];
  if (body === undefined) throw new Error('site.caddy has no security.txt');
  // Caddy drops the heredoc's last newline; the blank line before the marker leaves exactly one at the end.
  return body.replaceAll(/^\t+/gm, '').replaceAll('{$RWS_DOMAIN}', domain);
}
