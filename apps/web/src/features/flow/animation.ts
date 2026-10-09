// The flow animation's clock (P11a, issue #26 C2): one requestAnimationFrame loop, at most FLOW_FPS steps a second,
// stopped in a hidden tab and never started under prefers-reduced-motion. Pure: the browser comes in through the
// host (no window, document or import.meta here).

/** The step rate cap. */
export const FLOW_FPS = 25;

// One dash of DASH line widths in a period of PERIOD, moved STEP at a time along the line. The lines are drawn in the
// flow direction (P6 reaches run up to down), and a pattern is laid out from the line's start, so a dash that starts a
// little later every step travels downstream. Every array has four entries (dash, gap, dash, gap; a zero is dropped by
// MapLibre's line atlas): MapLibre interpolates arrays of one length and warns on a mismatch.
const PERIOD = 7;
const DASH = 3;
const GAP = PERIOD - DASH;
const STEP = 0.5;

/** The dash pattern of each step (`line-dasharray`, in line widths); every array has the same length. */
export const DASH_SEQ: readonly (readonly number[])[] = Array.from({ length: PERIOD / STEP }, (_, i) => {
  const s = i * STEP;
  return s <= GAP ? [0, s, DASH, GAP - s] : [s - GAP, GAP, PERIOD - s, 0];
});

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
  const interval = 1000 / FLOW_FPS;
  let on = enabled;
  let gone = false;
  // undefined: nothing announced yet, so the first sync always tells the host (onRunning at creation).
  let running: boolean | undefined;
  let frame: number | null = null;
  let last = Number.NEGATIVE_INFINITY;
  let step = 0;

  const loop = () => {
    frame = host.raf(loop);
    const now = host.now();
    if (now - last < interval) return;
    last = now;
    host.onTick(step);
    step = (step + 1) % DASH_SEQ.length;
  };
  const sync = () => {
    const want = !gone && on && !host.reducedMotion.matches() && !host.visibility.hidden();
    if (want === running) return;
    running = want;
    if (want) frame = host.raf(loop);
    else if (frame !== null) {
      host.caf(frame);
      frame = null;
    }
    host.onRunning(want);
  };

  const offMotion = host.reducedMotion.onChange(sync);
  const offVisible = host.visibility.onChange(sync);
  sync();
  return {
    setEnabled(next) {
      on = next;
      sync();
    },
    running: () => running === true,
    dispose() {
      if (gone) return;
      gone = true;
      offMotion();
      offVisible();
      // Stops without telling the host: it is being torn down (its map may be gone).
      if (frame !== null) host.caf(frame);
      frame = null;
      running = false;
    },
  };
}
