// Types shared by the client, the capture runner and the adapters. Adapters
// import only this file, and only as types (scripts/check-boundaries.ts).

export type Method = 'GET' | 'POST';

/** One request of a capture run. The URL is always built from the registry (invariant 1). */
export type Req = {
  url: string;
  method: Method;
  /** Request headers the spec or adapter adds (accept, content-type, conditional headers). */
  headers?: Record<string, string>;
  body?: string;
  /** Stable request-variant key: dup_of and per-variant state are kept per variant. */
  variant: string;
  /** A provider resource id recorded as seen once this request succeeds (LU-5). */
  seen_id?: string;
};

/** A final (non-redirect) response with its decoded body. */
export type Res = {
  status: number;
  /** Lowercased names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  /** The decoded HTTP body, bytes as received. */
  body: Buffer;
  wireBytes: number;
  /** The URL that produced the final response (after same-host redirects). */
  url: string;
};

/** Fixed error codes of the client. No provider text ever travels in an error. */
export type ErrorCode =
  | 'bad_url'
  | 'not_allowlisted'
  | 'private_address'
  | 'dns'
  | 'redirect_cross_host'
  | 'redirect_insecure'
  | 'redirect_limit'
  | 'too_large'
  | 'too_large_decoded'
  | 'bad_encoding'
  | 'timeout'
  | 'network'
  | 'backoff'
  | 'breaker_open';

export type FetchResult = { ok: true; res: Res } | { ok: false; error: ErrorCode };

export type TransportRequest = {
  url: URL;
  method: Method;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
};

export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Raw bytes as they came off the socket: never decoded by the transport. */
  body: AsyncIterable<Uint8Array> & { destroy(error?: Error): unknown };
};

/** The only layer that touches the network; every policy check sits above it. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

// ---------------------------------------------------------------- adapters

/** One row of a registry/seed CSV, or one inline variant of a spec. */
export type Row = Readonly<Record<string, string>>;

/** What an adapter gets to build one request: the rendered registry template plus its window. */
export type BuildContext = {
  req: Req;
  row: Row;
  now: Date;
  /** The gap-stretched window of a windowed spec, else null. */
  window: { from: Date; to: Date } | null;
  /** Explicit extra values from the spec (e.g. the FR-1 Belgian codes). */
  params: Readonly<Record<string, string>>;
};

/** Stage-2 requests from a stage-1 document (FR-4 stations, FR-5 sections, LU-5 new files, Hub'Eau next). */
export type ExpandContext = {
  req: Req;
  doc: unknown;
  now: Date;
  /** Ids already fetched (LU-5), from the spec state. */
  seen: ReadonlySet<string>;
  /** The client's static URL check for this source: the checked href, or null (refused). */
  checkUrl: (raw: string) => string | null;
  /** True during the §0.1b harvest (follow every page). */
  seed: boolean;
};

export type Expansion = { reqs: Req[]; seen?: string[] };

/** Pure per-source hooks; the runner does everything else from the registry. */
export type Adapter = {
  build?: (ctx: BuildContext) => Req;
  expand?: (ctx: ExpandContext) => Expansion;
  /** Change-gate key (`lastmod-runstart`, `field` beyond a plain path); null = unreadable, so the body is stored. */
  gateKey?: (doc: unknown, headers: Readonly<Record<string, string>>) => string | null;
  /** A value whose change raises an alert (LU-4 thresholds, NL-4 file names). */
  alertKey?: (doc: unknown) => string | null;
  /** First and last timestamps of a payload, for the seed report. */
  coverage?: (doc: unknown) => { from: string; to: string } | null;
};
