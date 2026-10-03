import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { fetchCapped } from '../scripts/fetch-flood-fixtures.ts';
import { server } from './msw.setup.ts';

// scripts/fetch-flood-fixtures.ts (P7a review SR-8): a redirect only to the same https host, at most 3; the body
// read as a stream that stops at the byte limit. msw answers; nothing reaches the network.

const BASE = 'https://web.archive.org/web/1id_/x';
const to = (location: string) => new HttpResponse(null, { status: 302, headers: { location } });

describe('fetchCapped', () => {
  it('follows a same-host redirect and returns the body', async () => {
    server.use(
      http.get(BASE, () => to('/web/2id_/x')),
      http.get('https://web.archive.org/web/2id_/x', () => HttpResponse.text('{"ok":1}')),
    );
    const res = await fetchCapped(BASE, {});
    expect([res.status, res.body.toString()]).toEqual([200, '{"ok":1}']);
  });

  it('refuses a redirect to another host or to http, and a fourth redirect', async () => {
    server.use(http.get(BASE, () => to('https://example.org/x')));
    await expect(fetchCapped(BASE, {})).rejects.toThrow('redirect_off_host');
    server.use(http.get(BASE, () => to('http://web.archive.org/x')));
    await expect(fetchCapped(BASE, {})).rejects.toThrow('redirect_off_host');
    server.use(http.get(BASE, () => to(BASE)));
    await expect(fetchCapped(BASE, {})).rejects.toThrow('too_many_redirects');
  });

  it('stops reading at the byte limit', async () => {
    server.use(http.get(BASE, () => HttpResponse.text('x'.repeat(1025))));
    await expect(fetchCapped(BASE, {}, 1024)).rejects.toThrow('too_big');
    server.use(http.get(BASE, () => HttpResponse.text('x'.repeat(1024))));
    expect((await fetchCapped(BASE, {}, 1024)).body.length).toBe(1024);
  });
});
