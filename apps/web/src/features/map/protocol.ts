/**
 * The `pmtiles://` protocol is global in MapLibre (one handler per scheme), but
 * maps come and go: React's StrictMode mounts twice, a page can hold two maps.
 * The handler is registered for the first map and then kept for the page's
 * life: removing it with the last map let tile requests that MapLibre had
 * already queued fall through to the browser's own fetch of a `pmtiles://` URL,
 * which the CSP blocks (KG-130: WebKit, a map unmounted while it loaded a tall
 * viewport). Each map still acquires and releases, so the count says how many
 * live maps use it.
 */
export const SCHEME = 'pmtiles';

interface Host<H> {
  addProtocol(scheme: string, handler: H): void;
}

let registered = false;
let users = 0;

/** Registers `handler()` on the first acquire of the page; the returned release is idempotent. */
export function acquireProtocol<H>(host: Host<H>, handler: () => H): () => void {
  if (!registered) {
    host.addProtocol(SCHEME, handler());
    registered = true;
  }
  users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
  };
}

/** How many live maps hold the protocol (the spike's unmount test reads it). */
export const protocolUsers = () => users;
