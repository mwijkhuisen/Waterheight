// The flow animation's clock (P11a, issue #26 C2): one requestAnimationFrame loop, at most FLOW_FPS steps a second,
// stopped in a hidden tab and never started under prefers-reduced-motion. Pure: the browser comes in through the
// host (no window, document or import.meta here). STUB (L0): W2 implements it.

/** The step rate cap. */
export const FLOW_FPS = 25;

/** The dash pattern of each step (`line-dasharray`, in line widths); every array has the same length. */
export const DASH_SEQ: readonly (readonly number[])[] = [[0, 4, 3]];

export interface FlowHost {
  raf(cb: (now: number) => void): number;
  caf(id: number): void;
  now(): number;
  reducedMotion: { matches(): boolean; onChange(cb: () => void): () => void };
  visibility: { hidden(): boolean; onChange(cb: () => void): () => void };
  /** One step: `step` indexes DASH_SEQ. */
  onTick(step: number): void;
  /** The loop started (true) or stopped (false): the static arrows show while it is stopped. */
  onRunning(running: boolean): void;
}

export interface FlowAnimation {
  /** The pause control (WCAG 2.2.2): off stops the loop; on starts it unless the tab is hidden or motion is reduced. */
  setEnabled(on: boolean): void;
  running(): boolean;
  /** Stops the loop and removes the host listeners. */
  dispose(): void;
}

export function createFlowAnimation(host: FlowHost, enabled: boolean): FlowAnimation {
  void host;
  void enabled;
  return { setEnabled: () => {}, running: () => false, dispose: () => {} };
}
