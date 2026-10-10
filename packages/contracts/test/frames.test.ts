import { describe, expect, it } from 'vitest';
import { FramesAnswer, isStateCode, SECTION_BIT, stateCode, stateOf } from '../src/api.ts';
import { OwnerFramesAnswer } from '../src/api-owner.ts';
import { FramesFile, FramesFileAny } from '../src/static.ts';

// #112: the frames state codes and the v1 / v2 file contracts.

const STATE_NAMES = ['no_ref', 'low', 'normal', 'elevated', 'high', 'extreme'] as const;

const v2 = () => ({
  schemaVersion: 2 as number,
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-01T03:00:00.000Z',
  stepSeconds: 3600,
  series: [1, 2],
  vlast: [
    [1.5, null, 2],
    [null, null, 3],
  ] as (number | null)[][],
  state: [
    [2, null, 11],
    [null, null, 0],
  ] as (number | null)[][],
  attribution: [],
});
const v1 = () => {
  const { state: _state, ...rest } = v2();
  return { ...rest, schemaVersion: 1 };
};

describe('state codes', () => {
  it('round-trips every state and section', () => {
    for (const [i, state] of STATE_NAMES.entries()) {
      for (const section of [false, true]) {
        const c = stateCode(state, section);
        expect(c).toBe(i + (section ? SECTION_BIT : 0));
        expect(isStateCode(c)).toBe(true);
        expect(stateOf(c)).toEqual({ state, section });
      }
    }
  });

  it.each([6, 7, 14, 15, 16, -1, 1.5, Number.NaN])('refuses %s', (c) => {
    expect(isStateCode(c)).toBe(false);
    expect(stateOf(c)).toBeUndefined();
  });
});

describe('frames v2', () => {
  it('accepts a good body in every contract', () => {
    expect(FramesFile.safeParse(v2()).success).toBe(true);
    expect(FramesFileAny.safeParse(v2()).success).toBe(true);
    expect(FramesAnswer.safeParse(v2()).success).toBe(true);
    expect(OwnerFramesAnswer.safeParse({ ...v2(), audience: 'owner' }).success).toBe(true);
  });

  const bad: [string, (f: ReturnType<typeof v2>) => unknown][] = [
    ['no state', (f) => ({ ...f, state: undefined })],
    ['a state row too few', (f) => ({ ...f, state: f.state.slice(1) })],
    ['a state row too short', (f) => ({ ...f, state: [[2, null], f.state[1]] })],
    ['a code where vlast is null', (f) => ({ ...f, state: [[2, 3, 11], f.state[1]] })],
    ['null where vlast has a value', (f) => ({ ...f, state: [[null, null, 11], f.state[1]] })],
    ['code 6', (f) => ({ ...f, state: [[6, null, 11], f.state[1]] })],
    ['code 7', (f) => ({ ...f, state: [[7, null, 11], f.state[1]] })],
    ['code 14', (f) => ({ ...f, state: [[2, null, 14], f.state[1]] })],
    ['a fractional code', (f) => ({ ...f, state: [[1.5, null, 11], f.state[1]] })],
  ];
  it.each(bad)('refuses %s', (_, mutate) => {
    const body = mutate(v2());
    expect(FramesFile.safeParse(body).success).toBe(false);
    expect(FramesFileAny.safeParse(body).success).toBe(false);
    expect(FramesAnswer.safeParse(body).success).toBe(false);
    expect(OwnerFramesAnswer.safeParse({ ...(body as object), audience: 'owner' }).success).toBe(false);
  });
});

describe('frames v1', () => {
  it('is read by FramesFileAny only', () => {
    expect(FramesFileAny.safeParse(v1()).success).toBe(true);
    expect(FramesFile.safeParse(v1()).success).toBe(false);
    expect(FramesAnswer.safeParse(v1()).success).toBe(false);
    expect(OwnerFramesAnswer.safeParse({ ...v1(), audience: 'owner' }).success).toBe(false);
  });

  it('refuses misaligned rows, a version 3 and a v1 carrying state', () => {
    expect(FramesFileAny.safeParse({ ...v1(), vlast: [[1, 2, 3]] }).success).toBe(false);
    expect(
      FramesFileAny.safeParse({
        ...v1(),
        vlast: [
          [1, 2],
          [1, 2, 3],
        ],
      }).success,
    ).toBe(false);
    expect(FramesFileAny.safeParse({ ...v2(), schemaVersion: 3 }).success).toBe(false);
    expect(FramesFileAny.safeParse({ ...v1(), state: v2().state }).success).toBe(false);
  });
});
