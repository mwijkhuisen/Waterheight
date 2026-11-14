// biome-ignore-all lint/suspicious/noExplicitAny: parsed compose YAML, read by key in assertions
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './catalogue.ts';

// The stats stack (#270 part A, ADR-0024, deploy/stats/): Umami, its own PostgreSQL and its own cloudflared. It shares
// nothing with the rws project (no network, secret, group id, subnet, path or nftables table), publishes one port on
// the WireGuard address only, and keeps its secrets in files. The runtime proofs are deploy/tests/stats-e2e.sh (CI).

type Service = Record<string, any>;
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const live = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
const text = read('deploy/stats/compose.yaml');
const doc = parse(text, { merge: true }) as {
  name: string;
  services: Record<string, Service>;
  networks: Record<string, any>;
  secrets: Record<string, { file: string }>;
};
const svc = doc.services;
const nets = (s: Service): string[] => (Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {}));

// Each secret's group: root:<gid> 0440 on the host (docs/runbooks/stats.md); 63001-63099 is the stats range, beside
// rws's 61001-61099 and F1 Timings' 62001-62099.
const GID: Record<string, string> = { db_umami: '63001', umami_app_secret: '63002', cf_stats_tunnel: '63003' };

describe('deploy/stats/compose.yaml', () => {
  it('is project stats with exactly umami, db and cloudflared', () => {
    expect(doc.name).toBe('stats');
    expect(Object.keys(svc).sort()).toEqual(['cloudflared', 'db', 'umami']);
  });

  it('runs every service as a numeric non-root user, pinned by digest', () => {
    for (const [name, s] of Object.entries(svc)) {
      expect(s.user, name).toMatch(/^[1-9]\d*:[1-9]\d*$/);
      expect(s.image, name).toMatch(/^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
    }
  });

  it('puts no secret in the environment: only *_FILE paths under /run/secrets, no TUNNEL_*', () => {
    for (const [name, s] of Object.entries(svc)) {
      for (const [key, value] of Object.entries((s.environment ?? {}) as Record<string, string>)) {
        expect(key, `${name}.${key}`).not.toMatch(/^TUNNEL_/);
        if (key.endsWith('_FILE')) expect(value, `${name}.${key}`).toMatch(/^\/run\/secrets\/\w+$/);
        else expect(key, `${name}.${key}`).not.toMatch(/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL/);
      }
    }
  });

  it('gives each service exactly the groups of its own secrets, all in the stats range', () => {
    for (const [name, s] of Object.entries(svc)) {
      const own = ((s.secrets ?? []) as string[]).map((k) => GID[k]).sort();
      expect(own, name).not.toContain(undefined);
      expect([...((s.group_add ?? []) as string[])].sort(), name).toEqual(own);
    }
    expect(Object.keys(doc.secrets).sort()).toEqual(Object.keys(GID).sort());
    for (const [k, v] of Object.entries(doc.secrets)) expect(v.file, k).toBe(`/etc/stats/secrets/${k}`);
    for (const gid of Object.values(GID)) expect(Number(gid)).toBeGreaterThanOrEqual(63001);
    for (const gid of Object.values(GID)) expect(Number(gid)).toBeLessThanOrEqual(63099);
  });

  it('binds only /etc/stats and /srv/stats and names nothing of rws', () => {
    const binds = Object.values(svc).flatMap((s) => ((s.volumes ?? []) as string[]).map((v) => v.split(':')[0]));
    expect(binds.sort()).toEqual(['/etc/stats/cloudflared.yml', '/srv/stats/pgdata']);
    expect(live(text)).not.toMatch(/\/etc\/rws|\/srv\/rws|rws-|rws_|RWS_/);
    expect(live(text)).not.toMatch(/^volumes:/m);
  });

  it('publishes one port, on the WireGuard address, from umami', () => {
    const ports = Object.entries(svc).flatMap(([name, s]) => ((s.ports ?? []) as string[]).map((p) => `${name} ${p}`));
    expect(ports).toEqual(['umami 10.66.0.1:8444:3000/tcp']);
    expect(live(text)).not.toMatch(/network_mode|extra_hosts|privileged|cap_add|devices/);
  });

  it('has its own four IPv4 bridges with the members and flags of the design', () => {
    expect(nets(svc.umami as Service).sort()).toEqual(['stats-db', 'stats-edge', 'stats-publish']);
    expect(nets(svc.db as Service)).toEqual(['stats-db']);
    expect(nets(svc.cloudflared as Service).sort()).toEqual(['stats-edge', 'stats-tunnel']);
    const internal = Object.fromEntries(Object.entries(doc.networks).map(([k, n]) => [k, n.internal === true]));
    expect(internal).toEqual({ 'stats-db': true, 'stats-edge': true, 'stats-publish': false, 'stats-tunnel': false });
    const subnets: string[] = [];
    for (const [k, n] of Object.entries(doc.networks)) {
      expect(n.driver_opts['com.docker.network.bridge.name'], k).toBe(k);
      expect(n.enable_ipv6, k).toBeUndefined();
      const cfg = n.ipam.config as { subnet: string }[];
      expect(cfg, k).toHaveLength(1);
      subnets.push(cfg[0]?.subnet as string);
      // The two single-member bridges keep icc off.
      if (!n.internal) expect(n.driver_opts['com.docker.network.bridge.enable_icc'], k).toBe('false');
    }
    expect(subnets.sort()).toEqual(['10.63.1.0/24', '10.63.2.0/24', '10.63.3.0/24', '10.63.4.0/24']);
    for (const rel of readdirSync(join(repoRoot, 'deploy')).filter((f) => /^compose.*\.yaml$/.test(f)))
      expect(read(join('deploy', rel)), rel).not.toMatch(/10\.63\.|stats-/);
  });

  it('overlaps nothing of rws, F1 Timings or WireGuard (the #270 criterion)', () => {
    const ip = (a: string) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
    const range = (cidr: string) => {
      const [a = '', bits = '32'] = cidr.split('/');
      const size = 2 ** (32 - Number(bits));
      const lo = Math.floor(ip(a) / size) * size;
      return [lo, lo + size - 1] as const;
    };
    const overlap = (x: string, y: string) => {
      const [a, b] = range(x);
      const [c, d] = range(y);
      return a <= d && c <= b;
    };
    // rws 172.30.0.0/16 (and fd7a:7773::/32: stats has no IPv6), F1 Timings 10.62.0.0/16, WireGuard 10.66.0.0/24.
    const taken = ['172.30.0.0/16', '10.62.0.0/16', '10.66.0.0/24'];
    for (const [k, n] of Object.entries(doc.networks))
      for (const { subnet } of n.ipam.config as { subnet: string }[]) {
        expect(subnet, k).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
        for (const other of taken) expect(overlap(subnet, other), `${k} ${subnet} vs ${other}`).toBe(false);
      }
    expect(live(text)).not.toMatch(/fd7a:|enable_ipv6/);
    // GIDs: rws 61001-61099, F1 Timings from 62001 (62001-62099 reserved).
    for (const gid of Object.values(GID).map(Number)) {
      expect(gid < 61001 || gid > 61099, String(gid)).toBe(true);
      expect(gid < 62001 || gid > 62099, String(gid)).toBe(true);
    }
    // Names and paths: every network and bridge is stats-*; nothing names an rws or f1 path, network or table.
    for (const [k, n] of Object.entries(doc.networks)) {
      expect(k).toMatch(/^stats-/);
      expect(n.driver_opts['com.docker.network.bridge.name']).toMatch(/^stats-/);
    }
    for (const rel of ['deploy/stats/compose.yaml', 'deploy/stats/nftables-stats.conf', 'deploy/stats/cloudflared.yml'])
      expect(live(read(rel)), rel).not.toMatch(
        /\/etc\/(?:rws|f1)\b|\/srv\/(?:rws|f1)\b|\b(?:rws|f1)-|inet (?:rws|f1)\b/,
      );
    expect(overlap('10.62.0.0/16', '10.62.3.0/24')).toBe(true); // the helper itself
  });

  it('runs cloudflared over http2 with loopback metrics, the repo ingress and the token from its file', () => {
    const cf = svc.cloudflared as Service;
    const args = [...(cf.entrypoint as string[]), ...(cf.command as string[])].join(' ');
    expect(args).toContain('--protocol http2');
    expect(args).toContain('--metrics 127.0.0.1:20241');
    expect(args).toContain('--edge-ip-version 4');
    expect(args).toContain('--config /etc/cloudflared/config.yml run --token-file /run/secrets/cf_stats_tunnel');
    expect(args).not.toMatch(/--token(?!-file)/);
    expect(cf.volumes).toEqual(['/etc/stats/cloudflared.yml:/etc/cloudflared/config.yml:ro']);
  });

  it('builds the database URL from the secret files inside umami, never in compose', () => {
    const cmd = ((svc.umami as Service).entrypoint as string[]).join(' ');
    expect(cmd).toContain('$(cat /run/secrets/db_umami)');
    expect(cmd).toContain('$(cat /run/secrets/umami_app_secret)');
    expect(cmd).toMatch(/exec sh scripts\/start-docker\.sh$/);
    expect(cmd).not.toMatch(/echo "?\$|set -x|printenv|env\b/);
    expect(svc.db?.environment.POSTGRES_INITDB_ARGS).toContain('--auth-local=scram-sha-256 --auth-host=scram-sha-256');
  });
});

describe('deploy/stats/cloudflared.yml', () => {
  it('routes POST /api/send of stats.waterradar.io to umami and everything else to 404', () => {
    const ing = parse(read('deploy/stats/cloudflared.yml')) as Record<string, unknown>;
    expect(ing).toEqual({
      ingress: [
        { hostname: 'stats.waterradar.io', path: '^/api/send$', service: 'http://umami:3000' },
        { service: 'http_status:404' },
      ],
    });
  });
});

describe('the stats firewall', () => {
  const fw = live(read('deploy/stats/nftables-stats.conf'));

  it('manages table inet stats alone and never flushes the ruleset', () => {
    expect(fw).not.toMatch(/\bflush\b/);
    expect(fw.match(/^table inet stats \{$/gm)).toHaveLength(1);
    expect(fw).toMatch(/^table inet stats\ndelete table inet stats\n/m);
    expect(fw.match(/^\S.*$/gm)).toEqual(['table inet stats', 'delete table inet stats', 'table inet stats {', '}']);
    expect(fw).not.toMatch(/inet rws|inet f1|rws-/);
  });

  it('accepts from wg0 only the dashboard, and out only cloudflared to Cloudflare and DNS', () => {
    const chain = (n: string) => new RegExp(`chain ${n} \\{([\\s\\S]*?)\\n\\t\\}`).exec(fw)?.[1] ?? '';
    const accepts = (n: string) =>
      chain(n)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.endsWith(' accept'));
    expect(accepts('to_stats')).toEqual([
      'ct state established,related accept',
      'iifname "wg0" oifname "stats-publish" meta l4proto tcp ct original ip daddr 10.66.0.1 ct original proto-dst 8444 accept',
    ]);
    expect(accepts('from_stats')).toEqual([
      'ct state established,related accept',
      'iifname "stats-tunnel" meta l4proto { tcp, udp } th dport 53 ip daddr @resolvers4 accept',
      'iifname "stats-tunnel" tcp dport 7844 ip daddr @cftunnel4 accept',
    ]);
    for (const n of ['from_stats', 'to_stats', 'input']) expect(chain(n).trimEnd().endsWith('drop'), n).toBe(true);
  });

  it('is the one stats line of the rws table: a WireGuard peer may reach stats-publish', () => {
    const rws = live(read('deploy/host/nftables.conf'));
    expect(rws.split('\n').filter((l) => l.includes('stats'))).toEqual([
      '\t\tiifname "wg0" oifname != { "rws-owner-pub", "stats-publish" } drop',
    ]);
  });

  it('keeps every stats unit and script out of the rws host directories, with no ExecStop', () => {
    for (const dir of ['deploy/host', 'deploy/systemd', 'deploy/bin'])
      expect(
        readdirSync(join(repoRoot, dir)).filter((f) => f.startsWith('stats')),
        dir,
      ).toEqual([]);
    const units = readdirSync(join(repoRoot, 'deploy/stats')).filter((f) => /\.(service|path)$/.test(f));
    expect(units.sort()).toEqual(['stats-firewall.service', 'stats-resolvers.path', 'stats-resolvers.service']);
    for (const u of units) expect(read(`deploy/stats/${u}`), u).not.toMatch(/^ExecStop/m);
    expect(read('deploy/stats/stats-resolvers.sh')).not.toMatch(/inet rws|resolvers6/);
  });
});
