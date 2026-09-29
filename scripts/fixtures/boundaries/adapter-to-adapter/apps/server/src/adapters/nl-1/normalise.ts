// Violation fixture: `import { type X }` is a runtime import under
// verbatimModuleSyntax, so it is not allowed from the http module.
import { type Client } from '../../http/client.ts';

export const normalise = (c: Client) => c;
