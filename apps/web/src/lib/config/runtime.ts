import { z } from 'zod';

// /runtime-config.json (P9a): which site this build runs on. The public site and the owner site (#25) serve the
// same build; the query keys carry the audience so their answers never mix. Anything but a valid answer is public.

export const RuntimeConfig = z.strictObject({ audience: z.enum(['public', 'owner']) });
export type Audience = z.infer<typeof RuntimeConfig>['audience'];

export async function loadAudience(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<Audience> {
  try {
    const res = await fetcher('/runtime-config.json', {
      signal: signal ?? null,
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return 'public';
    return RuntimeConfig.parse(await res.json()).audience;
  } catch (e) {
    if (signal?.aborted) throw e;
    return 'public';
  }
}
