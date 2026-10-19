import { readFileSync } from 'node:fs';
import { ClimatologyConfig } from '@rws/contracts';
import { parse } from 'yaml';
import { REGISTRY_DIR } from '../capture/specs.ts';

/** registry/climatology.yaml (P14f), read once; aliases off, as every reviewed table. */
let config: ClimatologyConfig | undefined;
export const climatologyConfig = (): ClimatologyConfig =>
  (config ??= ClimatologyConfig.parse(
    parse(readFileSync(new URL('climatology.yaml', REGISTRY_DIR), 'utf8'), { maxAliasCount: 0 }),
  ));
