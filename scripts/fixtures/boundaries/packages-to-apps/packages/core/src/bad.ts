// Violation fixture: packages must not import apps, by path or by package name.
import { run } from '../../../apps/server/src/main.ts';

export const lazy = () => import('@rws/server');
export { run };
