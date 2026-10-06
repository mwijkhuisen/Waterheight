import { z } from 'zod';

// /runtime-config.json (P9a): which site this build runs on. The public site and the owner site (#25) serve the
// same build; the query keys carry the audience so their answers never mix. A site without the file (404) and an
// answer that is not a valid one are public. A failure to get an answer (a network error, a 5xx, a 401) throws, so
// the caller retries and never mistakes the owner site for the public one, which would show it without its banner
// (P10a review round 1).

export const RuntimeConfig = z.strictObject({ audience: z.enum(['public', 'owner']) });
export type Audience = z.infer<typeof RuntimeConfig>['audience'];

export class RuntimeConfigError extends Error {
  constructor(status: number | 'network') {
    super(`runtime_config_${status}`);
    this.name = 'RuntimeConfigError';
  }
}

export async function loadAudience(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<Audience> {
  let res: Response;
  try {
    res = await fetcher('/runtime-config.json', {
      signal: signal ?? null,
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new RuntimeConfigError('network');
  }
  if (res.status === 404) return 'public';
  if (!res.ok) throw new RuntimeConfigError(res.status);
  try {
    return RuntimeConfig.parse(await res.json()).audience;
  } catch {
    return 'public';
  }
}
