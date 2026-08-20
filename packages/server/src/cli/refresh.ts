#!/usr/bin/env node
/**
 * Runs the scheduled refreshes by hand: the location layer and the catalogue.
 * `docker-compose up` leaves an empty system; this is what populates it.
 */
import '../env.js';
import { closePool } from '../db/pool.js';
import { refreshCatalogue } from '../ingest/catalogue.js';
import { recordRefresh, refreshLocations } from '../ingest/locations.js';
import { RWS_SOURCE_ID } from '../sources/registry.js';
import { syncSources } from '../db/sources.js';

const only = process.argv[2];

try {
  await syncSources();

  if (!only || only === 'catalogue') {
    try {
      await refreshCatalogue();
    } catch (err) {
      await recordRefresh(RWS_SOURCE_ID, 'catalogue', { error: String(err) }, false);
      throw err;
    }
  }
  if (!only || only === 'locations') {
    try {
      await refreshLocations();
    } catch (err) {
      await recordRefresh(RWS_SOURCE_ID, 'locations', { error: String(err) }, false);
      throw err;
    }
  }
} catch (err) {
  console.error(`Refresh failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
