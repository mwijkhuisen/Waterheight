// Allowed: packages/core, a type from http, its own provider's _shared folder,
// its own folder, and npm packages or builtins.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonical } from '../../../../../packages/core/src/index.ts';
import type { Client } from '../../http/client.ts';
import { kiwis } from '../_shared/rws/kiwis.ts';
import { local } from './local.ts';

export const parse = (c: Client) => [readFileSync, z, canonical, kiwis, local, c];
