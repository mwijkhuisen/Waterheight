import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { server } from './msw.setup.ts';

// Uses a resolvable host: a request that escaped msw would reach the network,
// so only msw's own "error" strategy can make the unhandled case fail.
const url = 'https://example.com/rws-msw-probe';

it('fails a request that has no msw handler, with msw’s error', async () => {
  const error = await fetch(url).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  const text = `${String(error)} ${String((error as { cause?: unknown }).cause)}`;
  expect(text).toMatch(/\[MSW\]/);
  expect(text).toMatch(/onUnhandledRequest|"error" strategy/);
});

it('lets a handled request through', async () => {
  server.use(http.get(url, () => HttpResponse.json({ ok: true })));
  const res = await fetch(url);
  expect(await res.json()).toEqual({ ok: true });
});
