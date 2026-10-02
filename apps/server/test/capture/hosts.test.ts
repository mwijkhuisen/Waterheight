import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { adapter as lu5 } from '../../src/adapters/lu-5/capture.ts';
import { baseRequest } from '../../src/capture/specs.ts';
import { fixture, registry, runDeps, spec } from './helpers.ts';

// Criterion "[CI] Allowlist and redirects" (issue #16; A§12.2; catalogue §6.7).

describe('per-source allowlist', () => {
  it.each([
    ['LU-5', 'download.data.public.lu'],
    ['NL-4', 'rijkswaterstaatdata.nl'],
    ['DE-1', 'pegelonline.wsv.de'],
    ['DE-3', 'vorhersage.bafg.de'],
    ['BE-3', 'hydrometrie.wallonie.be'],
    ['LU-1', 'inondations.public.lu'],
    ['LU-2', 'inondations.public.lu'],
    ['LU-3', 'inondations.public.lu'],
    ['LU-4', 'inondations.public.lu'],
  ])('%s may fetch from %s', (source, host) => {
    expect(registry.hosts.get(source)).toContain(host);
  });

  it('lists no host of an off source, and none of the gated hosts at all', () => {
    const all = [...registry.hosts.values()].flat();
    for (const [source] of registry.hosts) expect(registry.sources.get(source)?.audience).not.toBe('off');
    for (const gated of [
      'www.hochwasser.rlp.de',
      'geodaten-wasser.rlp-umwelt.de',
      'www.hvz.baden-wuerttemberg.de',
      'www.hlnug.de',
      'bis.azure-api.net',
      'www.pegelonline.nlwkn.niedersachsen.de',
      'hicws.vlaanderen.be',
      'hicwsauth.vlaanderen.be',
      'download.waterinfo.be',
      'waterinfo.rws.nl',
      'inondations.lu',
    ]) {
      expect(all).not.toContain(gated);
    }
  });

  it('puts every spec URL on a host of its own source', () => {
    for (const s of registry.specs) {
      for (const row of s.rows) {
        const host = new URL(baseRequest(s, row).url).hostname;
        expect(registry.hosts.get(s.source), `${s.id} → ${host}`).toContain(host);
      }
    }
  });

  it('refuses a data.public.lu → download.data.public.lu redirect (no cross-host exception)', async () => {
    const deps = runDeps();
    server.use(
      http.get(
        'https://data.public.lu/fr/datasets/r/abc',
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: 'https://download.data.public.lu/resources/x/1.xml' },
          }),
      ),
    );
    const r = await deps.client.fetch('LU-5', {
      url: 'https://data.public.lu/fr/datasets/r/abc',
      method: 'GET',
      variant: 'x',
    });
    expect(r).toEqual({ ok: false, error: 'redirect_cross_host' });
  });

  it('LU-5 fetches each new resource by its own url, never the `latest` link', () => {
    const page = JSON.parse(fixture('LU-5', 'lu-5-cap').body.toString()) as {
      data: { id: string; url: string; latest: string }[];
    };
    const deps = runDeps();
    const { reqs } = lu5.expand?.({
      req: baseRequest(spec('lu-5-cap'), {}),
      doc: page,
      now: new Date(),
      seen: new Set(),
      seed: false,
      window: null,
      checkUrl: (raw) => {
        const u = deps.client.checkUrl('LU-5', raw);
        return typeof u === 'string' ? null : u.href;
      },
    }) ?? { reqs: [] };
    const files = reqs.filter((r) => r.variant.startsWith('file/'));
    expect(files.length).toBeGreaterThan(0);
    for (const r of files) {
      const item = page.data.find((d) => `file/${d.id}` === r.variant);
      expect(r.url).toBe(item?.url);
      expect(new URL(r.url).hostname).toBe('download.data.public.lu');
      expect(r.url).not.toBe(item?.latest);
    }
  });

  it('refuses provider-supplied URLs off the source allowlist, with userinfo, or on another path', () => {
    const deps = runDeps();
    const check = (raw: string) => {
      const u = deps.client.checkUrl('LU-5', raw);
      return typeof u === 'string' ? null : u.href;
    };
    const doc = {
      data: [
        {
          id: '0ebe38da-f4fa-4132-8fc0-47074d9186d3',
          title: 'dump-alert.1790688368.xml',
          url: 'https://evil.example/resources/a/20260929-133006/dump-alert.1790688368.xml',
        },
        {
          id: '1ebe38da-f4fa-4132-8fc0-47074d9186d3',
          title: 'dump-alert.1790688369.xml',
          url: 'https://u:p@download.data.public.lu/resources/a/20260929-133006/dump-alert.1790688369.xml',
        },
        {
          id: '2ebe38da-f4fa-4132-8fc0-47074d9186d3',
          title: 'dump-alert.1790688370.xml',
          url: 'https://download.data.public.lu/other/path.xml',
        },
        {
          id: '3ebe38da-f4fa-4132-8fc0-47074d9186d3',
          title: 'other.xml',
          url: 'https://download.data.public.lu/resources/a/20260929-133006/dump-alert.1790688371.xml',
        },
      ],
      next_page: 'https://evil.example/api/2/datasets/67aca67bcaea3ae62308114f/resources/?page=2',
    };
    const out = lu5.expand?.({
      req: baseRequest(spec('lu-5-cap'), {}),
      doc,
      now: new Date(),
      seen: new Set(),
      seed: true,
      window: null,
      checkUrl: check,
    });
    expect(out?.reqs).toEqual([]);
  });
});
