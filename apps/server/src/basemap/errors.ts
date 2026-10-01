import { EXIT_CONFIG } from '../capture/env.ts';

// The `basemap` role's failures carry a fixed code and an exit code (interface
// I3: 1 failure, 64 usage, 78 configuration). Nothing a provider sent, and no
// file content, ever travels in one (invariant 6; CLAUDE.md "fixed codes only").

export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 64;
export { EXIT_CONFIG };

export class BasemapError extends Error {
  readonly code: string;
  readonly exit: number;

  constructor(code: string, exit: number = EXIT_FAILURE) {
    super(code);
    this.name = 'BasemapError';
    this.code = code;
    this.exit = exit;
  }
}

/** Fixed fields only: a code, our own build dates, counts and file kinds. */
export type Log = (
  level: 'info' | 'warn' | 'error',
  code: string,
  fields?: Readonly<Record<string, string | number | boolean | null>>,
) => void;
