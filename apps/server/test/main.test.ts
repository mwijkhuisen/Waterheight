import { describe, expect, it } from 'vitest';
import { EXIT_NOT_IMPLEMENTED, EXIT_USAGE, parseListen, ROLES, run } from '../src/main.ts';

const quiet = () => {};

describe('role dispatcher', () => {
  it.each(ROLES.filter((r) => r !== 'api'))('stub role %s exits non-zero', async (role) => {
    expect(await run([role], {}, quiet)).toBe(EXIT_NOT_IMPLEMENTED);
  });

  it.each([[[]], [['nope']], [['api', 'extra']], [['API']]])('rejects %j with a usage error', async (argv) => {
    expect(await run(argv, {}, quiet)).toBe(EXIT_USAGE);
  });

  it('refuses to serve on a malformed PORT', async () => {
    expect(await run(['api'], { PORT: '80a' }, quiet)).toBe(EXIT_USAGE);
  });
});

describe('parseListen', () => {
  it('defaults to localhost:8080', () => {
    expect(parseListen({})).toEqual({ hostname: '127.0.0.1', port: 8080 });
  });

  it('takes HOST and PORT from the environment', () => {
    expect(parseListen({ HOST: '0.0.0.0', PORT: '3000' })).toEqual({ hostname: '0.0.0.0', port: 3000 });
  });

  it.each(['0', '65536', '-1', '1e3', ' 80', ''])('rejects PORT %j', (PORT) => {
    expect(typeof parseListen({ PORT })).toBe('string');
  });

  it('rejects an empty HOST', () => {
    expect(typeof parseListen({ HOST: '' })).toBe('string');
  });
});
