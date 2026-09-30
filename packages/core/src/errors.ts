/**
 * A payload that does not match its provider's strict schema (A§7.4 step 5):
 * the loader quarantines that payload only. `code` is one of our own fixed
 * identifiers and `path` a schema path; neither ever carries provider text.
 */
export class SchemaDrift extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path = '') {
    const safe = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, 120);
    super(safe === '' ? code : `${code} at ${safe}`);
    this.name = 'SchemaDrift';
    this.code = code;
    this.path = safe;
  }
}

/** A timestamp that its declared convention cannot turn into one instant. */
export class TimeError extends Error {
  readonly code: TimeErrorCode;

  constructor(code: TimeErrorCode) {
    super(code);
    this.name = 'TimeError';
    this.code = code;
  }
}

export type TimeErrorCode = 'bad_format' | 'offset_mismatch' | 'dst_gap' | 'dst_overlap' | 'out_of_range';
