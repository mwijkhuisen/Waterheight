// Violation fixture: apps/web must not import apps/server.
import { createApp } from '../../server/src/app.ts';

export const app = createApp;
