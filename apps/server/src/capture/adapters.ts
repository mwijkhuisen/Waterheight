import { adapter as be3 } from '../adapters/be-3/capture.ts';
import { adapter as ch3 } from '../adapters/ch-3/capture.ts';
import { adapter as ch4 } from '../adapters/ch-4/capture.ts';
import { adapter as de1 } from '../adapters/de-1/capture.ts';
import { adapter as fr1 } from '../adapters/fr-1/capture.ts';
import { adapter as fr3 } from '../adapters/fr-3/capture.ts';
import { adapter as fr4 } from '../adapters/fr-4/capture.ts';
import { adapter as fr5 } from '../adapters/fr-5/capture.ts';
import { adapter as lu1 } from '../adapters/lu-1/capture.ts';
import { adapter as lu2 } from '../adapters/lu-2/capture.ts';
import { adapter as lu5 } from '../adapters/lu-5/capture.ts';
import { adapter as nl1 } from '../adapters/nl-1/capture.ts';
import { adapter as nl2 } from '../adapters/nl-2/capture.ts';
import { adapter as nl4 } from '../adapters/nl-4/capture.ts';
import type { Adapter, Req, Row } from '../http/types.ts';
import { baseRequest, type LoadedSpec, windowFor } from './specs.ts';

// Static map from source ID to its capture adapter (no computed imports:
// scripts/check-boundaries.ts). Sources without code are fully declarative.
export const ADAPTERS: Readonly<Record<string, Adapter>> = {
  'NL-1': nl1,
  'NL-2': nl2,
  'NL-4': nl4,
  'DE-1': de1,
  'FR-1': fr1,
  'FR-3': fr3,
  'FR-4': fr4,
  'FR-5': fr5,
  'LU-1': lu1,
  'LU-2': lu2,
  'LU-5': lu5,
  'BE-3': be3,
  'CH-3': ch3,
  'CH-4': ch4,
};

/**
 * The request of one registry row as a first run builds it (no capture state,
 * so the default window): what the smoke recorder and the contract check send.
 */
export function requestFor(spec: LoadedSpec, row: Row, now: Date): Req {
  const req = baseRequest(spec, row);
  const adapter = ADAPTERS[spec.source];
  if (!spec.request.build || adapter?.build === undefined) return req;
  return adapter.build({ req, row, now, window: windowFor(spec, now, undefined), params: spec.params });
}
