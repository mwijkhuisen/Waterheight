// biome-ignore-all lint/suspicious/noExplicitAny: parsed compose YAML, read by key in assertions
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './catalogue.ts';

// The Cloudflare Tunnel overlay (#109, ADR-0021, deploy/compose.tunnel.yaml): cloudflared is the one visitor path in
// tunnel mode and the only service on its networks besides caddy. Compose anchors do not cross files, so the
// hardening flags are repeated there and held here; nothing of the overlay may leak into direct mode.

type Service = Record<string, any>;
type Doc = { services: Record<string, Service>; networks?: Record<string, any>; secrets?: Record<string, any> };
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const load = (rel: string) => {
  const text = read(rel);
  // `!override` is a Compose tag the yaml package does not know: it keeps the value and warns, so silence the warning.
  const doc = parse(text, { merge: true, logLevel: 'silent' }) as Doc;
  return { text, doc };
};
const live = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
const netNames = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys((s.networks ?? {}) as object);

const tunnel = load('deploy/compose.tunnel.yaml');
const cf = tunnel.doc.services.cloudflared as Service;
const bom = /^\| cloudflared \| image \| [^|]+ \| installed \| (\S+) \|/m.exec(read('CLAUDE.md'))?.[1];

describe('cloudflared', () => {
  it('lives only in the tunnel overlay, so direct mode (compose.yaml and the owner overlay) has none', () => {
    expect(cf).toBeDefined();
    for (const rel of ['deploy/compose.yaml', 'deploy/compose.owner.yaml']) {
      const { text, doc } = load(rel);
      expect(Object.keys(doc.services), rel).not.toContain('cloudflared');
      expect(live(text), rel).not.toMatch(/cloudflared|cf_tunnel_token/);
    }
  });

  it('is on exactly tunnel and tunnel_edge, with a fixed address outside the range Docker hands out', () => {
    expect(netNames(cf).sort()).toEqual(['tunnel', 'tunnel_edge']);
    const ip = cf.networks.tunnel_edge.ipv4_address as string;
    expect(ip).toBe('172.30.41.10');
    const edge = tunnel.doc.networks?.tunnel_edge;
    expect(edge.ipam.config[0].subnet).toBe('172.30.41.0/24');
    expect(edge.ipam.config[0].ip_range).toBe('172.30.41.128/25');
    // .10 is in the /24 but below the /25 that starts at .128
    expect(Number(ip.split('.')[3])).toBeLessThan(128);
  });

  it('publishes no port, mounts no volume and holds exactly the token secret', () => {
    expect(cf.ports).toBeUndefined();
    expect(cf.expose).toBeUndefined();
    expect(cf.volumes).toBeUndefined();
    expect(cf.tmpfs).toHaveLength(1);
    expect(cf.tmpfs[0]).toMatch(/^\/tmp(:|$)/);
    expect(cf.secrets).toEqual(['cf_tunnel_token']);
  });

  it('is hardened and bounded like every other service, with a shell-free healthcheck', () => {
    expect(cf.read_only).toBe(true);
    expect(cf.cap_drop).toEqual(['ALL']);
    expect(cf.cap_add).toBeUndefined();
    expect(cf.security_opt).toEqual(['no-new-privileges:true']);
    expect(cf.restart).toBeDefined();
    expect(cf.user).toBe('65532:65532');
    expect(cf.group_add).toEqual(['61012']);
    for (const key of ['mem_limit', 'cpus', 'pids_limit']) expect(cf[key], key).toBeDefined();
    expect(cf.healthcheck.test[0]).toBe('CMD');
    expect(cf.healthcheck.test).toContain('ready');
  });

  it('reads the token from the file secret: no TUNNEL_* variable, no --token flag', () => {
    const env = cf.environment as Record<string, unknown>;
    expect(Object.keys(env).filter((k) => /^TUNNEL_/i.test(k))).toEqual([]);
    const argv = [...(cf.entrypoint as string[]), ...(cf.command as string[])];
    const line = argv.join(' ');
    expect(line).toContain('--token-file /run/secrets/cf_tunnel_token');
    expect(line).toContain('--no-autoupdate');
    expect(line).toContain('--metrics 127.0.0.1:20241');
    expect(argv).not.toContain('--token');
    expect(argv.some((a) => /^--token=/.test(a))).toBe(false);
    // And not anywhere else in the live text (a TUNNEL_TOKEN in an env_file or a comment-less line).
    expect(live(tunnel.text)).not.toMatch(/TUNNEL_TOKEN|--token(?!-file)/);
  });

  it('uses the image of the cloudflared BOM row, by tag and digest', () => {
    expect(cf.image).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
    expect(bom).toBeDefined();
    expect(cf.image).toBe(bom);
  });
});

describe('the tunnel networks', () => {
  const nets = tunnel.doc.networks as Record<string, any>;

  it("tunnel is cloudflared's egress bridge: not internal, rws-tunnel, 172.30.40.0/24", () => {
    expect(nets.tunnel.internal).toBeUndefined();
    expect(nets.tunnel.driver_opts['com.docker.network.bridge.name']).toBe('rws-tunnel');
    expect(nets.tunnel.ipam.config[0].subnet).toBe('172.30.40.0/24');
  });

  it('tunnel_edge is internal (no route out) on rws-tunnel-edge', () => {
    expect(nets.tunnel_edge.internal).toBe(true);
    expect(nets.tunnel_edge.driver_opts['com.docker.network.bridge.name']).toBe('rws-tunnel-edge');
  });

  it('no service but caddy and cloudflared joins a tunnel network, in any of the three files', () => {
    for (const rel of ['deploy/compose.yaml', 'deploy/compose.owner.yaml', 'deploy/compose.tunnel.yaml']) {
      for (const [name, s] of Object.entries(load(rel).doc.services)) {
        const tunnelNets = netNames(s).filter((n) => n.startsWith('tunnel'));
        if (name === 'caddy' || name === 'cloudflared') continue;
        expect(tunnelNets, `${rel} ${name}`).toEqual([]);
      }
    }
  });

  it('compose.yaml names no tunnel network, no scheme switch and no cloudflared: direct mode is unchanged', () => {
    const { text } = load('deploy/compose.yaml');
    expect(live(text)).not.toMatch(/tunnel|RWS_SITE_SCHEME|cloudflared/);
  });
});

describe('the caddy overlay', () => {
  const caddy = tunnel.doc.services.caddy as Service;

  it('serves plain HTTP for cloudflared alone: scheme http, trusted proxy its /32, joins tunnel_edge', () => {
    expect(caddy.environment.RWS_SITE_SCHEME).toBe('http');
    expect(caddy.environment.RWS_TRUSTED_PROXIES).toBe('172.30.41.10/32');
    expect(caddy.environment.RWS_TRUSTED_PROXIES).toBe(`${cf.networks.tunnel_edge.ipv4_address}/32`);
    expect(netNames(caddy)).toEqual(['tunnel_edge']);
  });

  it('replaces the public ports (!override) with 127.0.0.1:80 only', () => {
    expect(caddy.ports).toEqual(['127.0.0.1:80:80/tcp']);
    // A plain list would merge with compose.yaml's published 80 and 443.
    expect(tunnel.text).toMatch(/^\s+ports: !override\s*\n\s+- "127\.0\.0\.1:80:80\/tcp"\s*$/m);
  });
});

describe('the token secret and its group', () => {
  const bootstrap = read('deploy/host/bootstrap.sh');
  const table = (name: string) => {
    const body = new RegExp(`readonly -A ${name}=\\(([^)]*)\\)`).exec(bootstrap)?.[1] ?? '';
    return Object.fromEntries([...body.matchAll(/\['([^']+)'\]=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  };

  it('is the file /etc/rws/secrets/cf_tunnel_token, gid 61012 / group rws-cftunnel, used by nothing else', () => {
    expect(tunnel.doc.secrets).toEqual({ cf_tunnel_token: { file: '/etc/rws/secrets/cf_tunnel_token' } });
    const secrets = table('SECRET_GID');
    const groups = table('GROUP_GID');
    expect(secrets.cf_tunnel_token).toBe(61012);
    expect(groups['rws-cftunnel']).toBe(61012);
    expect(Object.entries(secrets).filter(([, g]) => g === 61012)).toEqual([['cf_tunnel_token', 61012]]);
    expect(Object.entries(groups).filter(([, g]) => g === 61012)).toEqual([['rws-cftunnel', 61012]]);
    // Only cloudflared gets the gid.
    for (const rel of ['deploy/compose.yaml', 'deploy/compose.owner.yaml'])
      for (const [name, s] of Object.entries(load(rel).doc.services))
        expect((s.group_add ?? []).map(String), `${rel} ${name}`).not.toContain('61012');
  });

  it('starts a new host in direct mode with no WireGuard endpoint override', () => {
    expect(bootstrap).toMatch(/^RWS_EDGE=direct$/m);
    expect(bootstrap).toMatch(/^RWS_WG_ENDPOINT=$/m);
  });
});

describe('nftables.conf: the tunnel egress', () => {
  const nft = read('deploy/host/nftables.conf');
  const code = live(nft);

  it("cftunnel4 holds exactly Cloudflare's two tunnel ranges", () => {
    const set = /set cftunnel4 \{([\s\S]*?)\n\t\}/.exec(code)?.[1] ?? '';
    expect(set).toContain('type ipv4_addr');
    const elements = /elements = \{([^}]*)\}/.exec(set)?.[1] ?? '';
    expect(
      elements
        .split(',')
        .map((e) => e.trim())
        .sort(),
    ).toEqual(['198.41.192.0/24', '198.41.200.0/24']);
  });

  it('has one rule for port 7844: from rws-tunnel only, to cftunnel4, before the final drop of from_containers', () => {
    const lines = code.split('\n').filter((l) => /7844/.test(l));
    expect(lines.map((l) => l.trim())).toEqual([
      'iifname "rws-tunnel" meta l4proto { tcp, udp } th dport 7844 ip daddr @cftunnel4 accept',
    ]);
    const chain = /chain from_containers \{([\s\S]*?)\n\t\}/.exec(code)?.[1] ?? '';
    const rules = chain
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(rules.indexOf(lines[0]?.trim() ?? '')).toBeGreaterThan(-1);
    expect(rules.indexOf(lines[0]?.trim() ?? '')).toBe(rules.length - 2);
    expect(rules.at(-1)).toBe('drop');
  });

  it('names rws-tunnel and rws-tunnel-edge in no other rule', () => {
    const mentions = code.split('\n').filter((l) => /rws-tunnel/.test(l));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain('th dport 7844');
  });
});
