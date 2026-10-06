// What the privacy page says about the logs, as numbers (P10b): `parts/LogPolicy.tsx` prints them, so no message holds
// one. `test/privacy-policy.test.ts` fails when deploy/web/site.caddy, deploy/web/owner.caddy or the beacon's cap in
// apps/server/src/api/beacon.ts says something else. No imports: Node reads this file as it is.

export const LOG = {
  /** Bits kept of an IPv4 address in the access log (`ip_mask`). */
  ipv4: 24,
  /** Bits kept of an IPv6 address. */
  ipv6: 48,
  /** Days a daily access-log file is kept (`roll_keep_for`, in hours). */
  keepDays: 14,
  /** The largest report the beacon takes, at Caddy and at the api. */
  beaconMaxBytes: 8192,
} as const;
