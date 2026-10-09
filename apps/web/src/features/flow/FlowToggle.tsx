import type { Locale } from '../../paraglide/runtime.js';

// The pause control of the flow animation (P11a, WCAG 2.2.2): "Stroming animeren / Animate flow", a button with
// aria-pressed beside the mode and view disclosures (P10e). Off and inert under prefers-reduced-motion. No URL key.
// STUB (L0): W2 implements it.

export interface FlowToggleProps {
  locale: Locale;
  on: boolean;
  onChange: (on: boolean) => void;
}

export function FlowToggle(props: FlowToggleProps) {
  void props;
  return null;
}
