import type { WebRiver } from '../../lib/data/chain.ts';
import type { Locale } from '../../paraglide/runtime.js';

// STUB (lead, P10a): S3 builds the river chip (plan C17): "Rivier: <name>" from the generated `river_<id>` message
// (or the reaches file's name_nl/name_en until it exists) with a clear button; nothing while no river is chosen.

export interface RiverChipProps {
  locale: Locale;
  /** The chosen river id; `river` is its entry of the reaches file, undefined while that file loads. */
  id: string;
  river: WebRiver | undefined;
  onClear: () => void;
}

export function RiverChip(_: RiverChipProps) {
  return null;
}
