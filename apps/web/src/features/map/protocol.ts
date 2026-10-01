/**
 * The `pmtiles://` protocol is global in MapLibre (one handler per scheme), but
 * maps come and go: React's StrictMode mounts twice, a page can hold two maps.
 * Each map acquires the protocol and releases it on unmount; the handler is
 * registered for the first user and removed with the last.
 */
export const SCHEME = 'pmtiles';

interface Host<H> {
  addProtocol(scheme: string, handler: H): void;
  removeProtocol(scheme: string): void;
}

let users = 0;

/** Registers `handler()` on the first acquire; the returned release is idempotent. */
export function acquireProtocol<H>(host: Host<H>, handler: () => H): () => void {
  if (users === 0) host.addProtocol(SCHEME, handler());
  users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users === 0) host.removeProtocol(SCHEME);
  };
}

/** How many live maps hold the protocol (the spike's unmount test reads it). */
export const protocolUsers = () => users;
