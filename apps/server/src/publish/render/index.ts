import { coded } from '../../api/util.ts';
import type { Renderers } from '../cycle.ts';

// P9a: the renderers of the publisher, one module per output (render/*.ts). Until a module exists its entry fails
// with `not_implemented`, which the cycle logs and skips.

const todo = (): Promise<never> => Promise.reject(coded('not_implemented'));

export const RENDERERS: Renderers = {
  stations: todo,
  latest: todo,
  snapshot: todo,
  frames: todo,
  forecast: todo,
  warnings: todo,
  sources: todo,
  station: todo,
  status: todo,
  meta: todo,
};
