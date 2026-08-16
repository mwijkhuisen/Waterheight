/**
 * Query-parameter parsing and validation.
 *
 * Hand-written rather than schema-library driven: the surface is small, and
 * every parser here returns a precise message naming the offending parameter.
 */

import type { Resolution } from '@rws/shared';
import { badRequest } from './errors.js';

export function parseBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw badRequest(`${name} must be true or false`);
}

export function parseString(value: unknown, name: string, maxLength = 200): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > maxLength) throw badRequest(`${name} must be at most ${maxLength} characters`);
  return trimmed;
}

/** `bbox=west,south,east,north` in WGS84 degrees. */
export function parseBbox(value: unknown): [number, number, number, number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest('bbox must be a string');

  const parts = value.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw badRequest('bbox must be four comma-separated numbers: west,south,east,north');
  }

  const [west, south, east, north] = parts as [number, number, number, number];
  if (west > east) throw badRequest('bbox west must not be greater than east');
  if (south > north) throw badRequest('bbox south must not be greater than north');
  if (south < -90 || north > 90) throw badRequest('bbox latitudes must be within [-90, 90]');
  if (west < -180 || east > 180) throw badRequest('bbox longitudes must be within [-180, 180]');

  return [west, south, east, north];
}

export function parseResolution(value: unknown): Resolution | null {
  if (value === undefined) return null;
  if (value === 'raw' || value === 'hourly' || value === 'daily') return value;
  throw badRequest('resolution must be one of raw, hourly, daily');
}

export function parseDate(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`${name} must be an ISO 8601 timestamp`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw badRequest(`${name} must be an ISO 8601 timestamp`);
  return new Date(ms);
}

export function parseInteger(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${name} must be an integer`);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

export interface Window {
  from: Date;
  to: Date;
}

/**
 * Resolve the requested window, defaulting to the last 48 hours (the detail
 * panel's default view).
 */
export function parseWindow(query: Record<string, unknown>, defaultHours = 48): Window {
  const to = parseDate(query['to'], 'to') ?? new Date();
  const from = parseDate(query['from'], 'from')
    ?? new Date(to.getTime() - defaultHours * 3_600_000);

  if (from.getTime() > to.getTime()) throw badRequest('from must not be after to');
  // Guards against a typo asking for a decade of raw points.
  const maxSpanMs = 5 * 366 * 86_400_000;
  if (to.getTime() - from.getTime() > maxSpanMs) {
    throw badRequest('the requested window must not exceed five years');
  }

  return { from, to };
}
