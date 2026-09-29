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
