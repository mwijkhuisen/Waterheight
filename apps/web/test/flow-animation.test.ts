import { describe, expect, it } from 'vitest';
import { createFlowAnimation, DASH_SEQ, FLOW_FPS, type FlowHost } from '../src/features/flow/animation.ts';

// P11a (issue #26, C2): the flow clock against a fake host and a fake display. No window, no timers: `frames` plays a
// display of `hz` refreshes a second, calling the one pending requestAnimationFrame callback of each refresh.

function fake(opts: { reduced?: boolean; hidden?: boolean } = {}) {
  let t = 0;
  let nextId = 1;
  let pending: { id: number; cb: (now: number) => void } | null = null;
  let reduced = opts.reduced ?? false;
  let hidden = opts.hidden ?? false;
  const reducedCbs = new Set<() => void>();
  const visibleCbs = new Set<() => void>();
  const log = { raf: 0, caf: 0, ticks: [] as { at: number; step: number }[], running: [] as boolean[] };
  const host: FlowHost = {
    raf(cb) {
      log.raf++;
      if (pending !== null) throw new Error('two loops: a frame is already requested');
      pending = { id: nextId++, cb };
      return pending.id;
    },
    caf(id) {
      log.caf++;
      if (pending?.id === id) pending = null;
    },
    now: () => t,
    reducedMotion: {
      matches: () => reduced,
      onChange(cb) {
        reducedCbs.add(cb);
        return () => reducedCbs.delete(cb);
      },
    },
    visibility: {
      hidden: () => hidden,
      onChange(cb) {
        visibleCbs.add(cb);
        return () => visibleCbs.delete(cb);
      },
    },
    onTick: (step) => log.ticks.push({ at: t, step }),
    onRunning: (running) => log.running.push(running),
  };
  return {
    host,
    log,
    listeners: () => reducedCbs.size + visibleCbs.size,
    pending: () => pending !== null,
    /** Plays `ms` of display time at `hz` refreshes a second. */
    frames(ms: number, hz = 60) {
      const end = t + ms;
      while (t + 1000 / hz <= end + 1e-9) {
        t += 1000 / hz;
        const frame = pending;
        pending = null;
        frame?.cb(t);
      }
      t = end;
    },
    setReduced(next: boolean) {
      reduced = next;
      for (const cb of [...reducedCbs]) cb();
    },
    setHidden(next: boolean) {
      hidden = next;
      for (const cb of [...visibleCbs]) cb();
    },
  };
}

/** The most ticks in any window of one second that starts at a tick. */
function peak(ticks: readonly { at: number }[]): number {
  let best = 0;
  for (const a of ticks) best = Math.max(best, ticks.filter((b) => b.at >= a.at && b.at < a.at + 1000).length);
  return best;
}

describe('the dash sequence', () => {
  const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
  /** Is the point `x` along the line (in line widths) lit by the pattern? Even entries are dashes, odd ones gaps. */
  function lit(pattern: readonly number[], x: number): boolean {
    let p = x % sum(pattern);
    for (const [i, len] of pattern.entries()) {
      if (p < len) return i % 2 === 0;
      p -= len;
    }
    return false;
  }

  it('has arrays of one length and one period (MapLibre warns on a mismatch)', () => {
    expect(DASH_SEQ.length).toBeGreaterThan(1);
    for (const a of DASH_SEQ) {
      expect(a.length).toBe((DASH_SEQ[0] as readonly number[]).length);
      expect(sum(a)).toBeCloseTo(sum(DASH_SEQ[0] as readonly number[]), 9);
      expect(a.every((v) => v >= 0)).toBe(true);
    }
    expect(new Set(DASH_SEQ.map((a) => a.join(','))).size).toBe(DASH_SEQ.length);
  });

  it('moves one dash along the line, forward (downstream) and one step at a time, round the whole period', () => {
    const period = sum(DASH_SEQ[0] as readonly number[]);
    const step = period / DASH_SEQ.length;
    const dash = [...(DASH_SEQ[0] as readonly number[])].reduce((n, len, i) => n + (i % 2 === 0 ? len : 0), 0);
    expect(dash).toBeGreaterThan(0);
    expect(dash).toBeLessThan(period);
    for (const [i, a] of DASH_SEQ.entries()) {
      // The pattern is laid out from the line's start: step i has its dash at [i * step, i * step + dash) mod period.
      const start = i * step;
      for (let k = 0; k < DASH_SEQ.length * 3; k++) {
        const x = step / 2 + k * (step / 3);
        const expected = (((x - start) % period) + period) % period < dash;
        expect(lit(a, x), `step ${i} at ${x}`).toBe(expected);
      }
    }
  });
});

describe('the flow clock', () => {
  it('under reduced motion never requests a frame and says it is stopped', () => {
    const f = fake({ reduced: true });
    const a = createFlowAnimation(f.host, true);
    f.frames(3000);
    expect(f.log.raf).toBe(0);
    expect(f.log.ticks).toEqual([]);
    expect(f.log.running).toEqual([false]);
    expect(a.running()).toBe(false);
    a.setEnabled(false);
    a.setEnabled(true);
    expect(f.log.raf).toBe(0);
  });

  it('starts at once, with one loop, and says it runs', () => {
    const f = fake();
    const a = createFlowAnimation(f.host, true);
    expect(a.running()).toBe(true);
    expect(f.log.running).toEqual([true]);
    expect(f.log.raf).toBe(1);
    f.frames(1000);
    expect(f.log.raf).toBe(1 + 60); // one request per refresh, never two at a time (fake throws on a second)
    expect(f.log.ticks.length).toBeGreaterThan(10);
  });

  it('cycles through DASH_SEQ in order', () => {
    const f = fake();
    createFlowAnimation(f.host, true);
    f.frames(2000);
    const steps = f.log.ticks.map((x) => x.step);
    expect(steps.length).toBeGreaterThan(DASH_SEQ.length);
    steps.forEach((s, i) => {
      expect(s).toBe(i % DASH_SEQ.length);
    });
  });

  it.each([30, 60, 75, 120, 144, 240])('takes at most FLOW_FPS ticks in any second at %i Hz', (hz) => {
    const f = fake();
    createFlowAnimation(f.host, true);
    f.frames(10_000, hz);
    expect(peak(f.log.ticks)).toBeLessThanOrEqual(FLOW_FPS);
    // It does run: at a display of at least the cap it reaches at least 3/5 of it.
    if (hz >= 2 * FLOW_FPS) expect(f.log.ticks.length).toBeGreaterThanOrEqual(10 * FLOW_FPS * 0.6);
    // ... and ticks at least 1000 / FLOW_FPS apart.
    const gaps = f.log.ticks.slice(1).map((x, i) => x.at - (f.log.ticks[i] as { at: number }).at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000 / FLOW_FPS - 1e-6);
  });

  it('stops in a hidden tab (cancelling its frame), ticks nothing there, and resumes when visible', () => {
    const f = fake();
    const a = createFlowAnimation(f.host, true);
    f.frames(500);
    const before = f.log.ticks.length;
    expect(before).toBeGreaterThan(0);
    f.setHidden(true);
    expect(f.log.caf).toBe(1);
    expect(f.pending()).toBe(false);
    expect(a.running()).toBe(false);
    expect(f.log.running).toEqual([true, false]);
    f.frames(5000);
    expect(f.log.ticks.length).toBe(before);
    const raf = f.log.raf;
    f.setHidden(false);
    expect(a.running()).toBe(true);
    expect(f.log.raf).toBe(raf + 1);
    expect(f.log.running).toEqual([true, false, true]);
    f.frames(500);
    expect(f.log.ticks.length).toBeGreaterThan(before);
  });

  it('starts hidden without a frame, and runs when it becomes visible', () => {
    const f = fake({ hidden: true });
    const a = createFlowAnimation(f.host, true);
    expect(f.log.raf).toBe(0);
    expect(f.log.running).toEqual([false]);
    f.setHidden(false);
    expect(a.running()).toBe(true);
    expect(f.log.raf).toBe(1);
  });

  it('follows the pause control', () => {
    const f = fake();
    const a = createFlowAnimation(f.host, true);
    f.frames(300);
    a.setEnabled(false);
    expect(a.running()).toBe(false);
    expect(f.pending()).toBe(false);
    const n = f.log.ticks.length;
    f.frames(2000);
    expect(f.log.ticks.length).toBe(n);
    a.setEnabled(false); // no second stop
    expect(f.log.caf).toBe(1);
    a.setEnabled(true);
    expect(a.running()).toBe(true);
    f.frames(500);
    expect(f.log.ticks.length).toBeGreaterThan(n);
    expect(f.log.running).toEqual([true, false, true]);
  });

  it('starts off when created off, and a visible tab alone does not start it', () => {
    const f = fake();
    const a = createFlowAnimation(f.host, false);
    expect(f.log.raf).toBe(0);
    expect(f.log.running).toEqual([false]);
    f.setHidden(true);
    f.setHidden(false);
    expect(a.running()).toBe(false);
    expect(f.log.raf).toBe(0);
  });

  it('stops and starts live when the reduced-motion preference changes', () => {
    const f = fake();
    const a = createFlowAnimation(f.host, true);
    f.frames(300);
    f.setReduced(true);
    expect(a.running()).toBe(false);
    expect(f.pending()).toBe(false);
    const n = f.log.ticks.length;
    f.frames(2000);
    expect(f.log.ticks.length).toBe(n);
    // Visibility does not start it while motion is reduced, and the pause control does not either.
    f.setHidden(true);
    f.setHidden(false);
    a.setEnabled(true);
    expect(a.running()).toBe(false);
    f.setReduced(false);
    expect(a.running()).toBe(true);
    f.frames(500);
    expect(f.log.ticks.length).toBeGreaterThan(n);
    expect(f.log.running).toEqual([true, false, true]);
  });

  it('dispose stops the loop, unsubscribes both listeners and stays stopped', () => {
    const f = fake();
    const a = createFlowAnimation(f.host, true);
    expect(f.listeners()).toBe(2);
    f.frames(300);
    a.dispose();
    expect(f.listeners()).toBe(0);
    expect(f.pending()).toBe(false);
    expect(a.running()).toBe(false);
    const n = f.log.ticks.length;
    const raf = f.log.raf;
    const told = f.log.running.length;
    f.setHidden(true);
    f.setHidden(false);
    f.setReduced(true);
    f.setReduced(false);
    a.setEnabled(true);
    f.frames(2000);
    expect(f.log.ticks.length).toBe(n);
    expect(f.log.raf).toBe(raf);
    // The host is being torn down (its map may be gone): dispose does not call it again.
    expect(f.log.running.length).toBe(told);
    a.dispose(); // twice is harmless
    expect(f.log.caf).toBe(1);
  });
});
