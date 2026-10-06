import { z } from 'zod';

// /runtime-config.json (P9a): which site this build runs on. The public site and the owner site (#25) serve the
// same build; the query keys carry the audience so their answers never mix. A site without the file (404) and an
// answer that is not a valid one are public. A failure to get an answer (a network error, a 5xx, a 401) throws, so
// the caller retries and never mistakes the owner site for the public one, which would show it without its banner
// (P10a review round 1).
// P10b: Caddy also fills in the operator, the contact address and the CDN (if any) from its environment
// (RWS_OPERATOR_NAME, RWS_CONTACT_EMAIL, RWS_CDN_NAME), so none of them is in the repository or the build. Each is
// text for the colophon and the privacy page; a value that does not pass is dropped on its own, and a key the page
// does not know is ignored, so neither ever changes the audience (review round 1: the owner site would lose its
// banner). Only a body that is no JSON object with a valid `audience` is public.

/** Text a page shows as a text node: no control character and no angle bracket. */
const shown = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[^\p{Cc}<>]*$/u);

export const RuntimeConfig = z.object({
  audience: z.enum(['public', 'owner']),
  contact: z.email().max(254).optional().catch(undefined),
  operator: shown(1, 120).optional().catch(undefined),
  /** The CDN in front of the site; "" when there is none. */
  cdn: shown(0, 80).optional().catch(undefined),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;
export type Audience = RuntimeConfig['audience'];

const PUBLIC: RuntimeConfig = { audience: 'public' };

export class RuntimeConfigError extends Error {
  constructor(status: number | 'network') {
    super(`runtime_config_${status}`);
    this.name = 'RuntimeConfigError';
  }
}

export async function loadRuntimeConfig(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<RuntimeConfig> {
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
  if (res.status === 404) return PUBLIC;
  if (!res.ok) throw new RuntimeConfigError(res.status);
  try {
    return RuntimeConfig.parse(await res.json());
  } catch {
    return PUBLIC;
  }
}
