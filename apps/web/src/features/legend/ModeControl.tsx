import type { Mode } from '../../lib/url/url.ts';
import type { Locale } from '../../paraglide/runtime.js';

// STUB (lead, P10a): S3 builds the mode control (plan T9): a <fieldset> of three native radios (state, delta, q).

export interface ModeControlProps {
  locale: Locale;
  mode: Mode;
  onChange: (mode: Mode) => void;
}

export function ModeControl(_: ModeControlProps) {
  return null;
}
