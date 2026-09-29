// Violation fixture: an adapter never imports another adapter, another
// provider's _shared folder, or a value (not a type) from the http module.
import { parse as parseDe } from '../de-1/parse.ts';
import { helper } from '../_shared/wsv/helper.ts';
import { fetchJson } from '../../http/client.ts';

export const parse = () => [parseDe, helper, fetchJson];
