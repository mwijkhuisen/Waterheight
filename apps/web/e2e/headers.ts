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

// P12b: the go-public switch. site.caddy imports deploy/web/phase-<RWS_SITE_PHASE>.caddy; the stand-in and the specs read
// the same file, so a change of it is a change of what the specs expect.
export type SitePhase = 'prelaunch' | 'launch';
/** The phase the specs expect of the site under test (CI's public container is prelaunch; launch.spec.ts has its own). */
export const sitePhase = (): SitePhase => (process.env.E2E_SITE_PHASE === 'launch' ? 'launch' : 'prelaunch');

const launchCaddy = fileURLToPath(new URL('../../../deploy/web/phase-launch.caddy', import.meta.url));
const launchSource = () => readFileSync(launchCaddy, 'utf8');

/** The path patterns the launch phase keeps noindex (its `@noindex` path matcher: a `*` suffix is a prefix, the rest exact). */
export function launchNoindexPatterns(): string[] {
  const line = /^@noindex_\{args\[0\]\} path (.+)$/m.exec(launchSource())?.[1];
  if (line === undefined) throw new Error('phase-launch.caddy has no @noindex path matcher');
  return line.split(' ');
}

/**
 * The X-Robots-Tag the public site sends for an answer: prelaunch, noindex on everything; launch, noindex on the data
 * paths of phase-launch.caddy and on an HTML 404 (the two 404 shells, site.caddy), nothing on a page or a bare 404.
 * (Caddy's path matcher folds case.)
 */
export function robotsTag(phase: SitePhase, path: string, status: number, html: boolean): string | undefined {
  if (phase === 'prelaunch') return 'noindex';
  if (status === 404 && html) return 'noindex';
  const p = path.toLowerCase();
  const data = launchNoindexPatterns().some((pat) => (pat.endsWith('*') ? p.startsWith(pat.slice(0, -1)) : p === pat));
  return data ? 'noindex' : undefined;
}

/** A fixed answer of phase-launch.caddy, its heredoc with the domain filled in (as securityTxt does). */
function launchBody(marker: 'ROBOTS' | 'SITEMAP', domain: string): string {
  const body = new RegExp(`respond <<${marker}\\n([\\s\\S]*?)\\n\\t*${marker} 200`).exec(launchSource())?.[1];
  if (body === undefined) throw new Error(`phase-launch.caddy has no ${marker} answer`);
  return body.replaceAll(/^\t+/gm, '').replaceAll('{$RWS_DOMAIN}', domain);
}
export const robotsTxt = (domain: string): string => launchBody('ROBOTS', domain);
export const sitemapXml = (domain: string): string => launchBody('SITEMAP', domain);

/** What Caddy's templates module makes of the shells' one expression (apps/web/index.html): RWS_DOMAIN as configured. */
export const fillShell = (html: string, domain: string): string => html.replaceAll('[[env `RWS_DOMAIN`]]', domain);
