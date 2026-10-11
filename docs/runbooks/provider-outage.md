# Runbook: a provider is down for hours or days

**Trigger:**
- a `cap-*` healthchecks alert that lasts more than one cadence and `last_failure_status` names an HTTP status or `timeout`, `dns`, `backoff`, `breaker_open` (`docs/runbooks/recorder-down.md` §1 tells one provider from all of them);
- `/api/v1/health/sources` shows `outage` or `coverage.gaps` for one source;
- the provider announces maintenance, or a visitor reports a stale station.

**D19: a payload that was due while the provider was down is lost, unless the spec's fill window covers it.** The recorder cannot ask a provider for what it does not offer. What comes back is exactly what the provider's own window and our `window.max` reach (§3). Everything else is a gap, and Q7 shows it. Say so; never promise a backfill.

## 1. Detect and name the provider

```bash
curl -s https://<domain>/status/capture.json | jq -r '.specs[] | select(.last_failure_status != null) | "\(.spec) \(.last_success) \(.last_failure_status)"'
curl -s https://<domain>/api/v1/health/sources | jq -r '.sources[] | select(.outage != null) | "\(.id) \(.outage.from) \(.outage.to) \(.outage.missing_buckets)"'
```

Expected: the specs of one provider with a failure status and an old `last_success`, and the matching source with an `outage` window (`from`, `to`, `missing_buckets`), for example:

```text
fr-1-obs 2026-10-10T08:20:00Z 503
FR-1 2026-10-10T08:20:00Z 2026-10-10T14:40:00Z 25
```

The values are examples. A source that is only slow shows an old `last_success` and no `outage` yet (the scan runs every 10 minutes).

## 2. The breaker and the back-off

`breaker_open` means the politeness layer (`apps/server/src/http/politeness.ts`) stopped asking after repeated failures; `backoff` is the wait between tries (30 s up to 30 min). Both are automatic and reset by one successful request. Do not restart `capture` to "retry": it resets nothing useful and loses the schedule.

```bash
sudo docker logs --since 1h rws-capture-1 2>&1 | grep -E 'breaker|backoff' | tail -n 5
sudo -u ops rws-reachability --only <target>
```

Expected: the log lines name the spec, and `rws-reachability` (compare `docs/reachability-*.md`) says whether the provider answers from our address. A 403, 451 or a challenge page is a block, not an outage: `docs/runbooks/recorder-down.md` §4.

## 3. What the fill window refills

```bash
grep -n -B8 'window:' registry/capture.yaml | grep -E 'id:|window:'
```

Expected: one `id:` and one `window: { default, max, overlap }` per spec. After the provider returns, the next run asks for the gap up to `max` (for example NL-1 `P31D`, FR-1 `P29DT23H`). A provider that keeps less than that (or a spec with no window, such as a forecast run or a class state) loses the rest. Forecast runs and alert states of a missed cycle are never refilled (ADR-0003).

## 4. Contact the provider

Contacts come from `docs/sources/SOURCE-CATALOGUE.md` Appendix A (role mailboxes and contact forms, never a person). An outage of a few hours needs no mail: look at the provider's own status page first. Mail after a day, or when a block is suspected.

```bash
grep -n -A16 'Appendix A: contact points' docs/sources/SOURCE-CATALOGUE.md
```

Expected: the table of providers, contacts and purposes. Record the event in `docs/risk-register.md` only if it repeats or involves a block.

## 5. After the provider is back

```bash
curl -s https://<domain>/status/capture.json | jq -r '.specs[] | "\(.spec) \(.last_success)"'
curl -s https://<domain>/api/v1/health/sources | jq -r '.sources[] | select(.id == "<ID>") | {outage, gaps: .coverage.gaps}'
scripts/verify-prod.sh <domain>
```

Expected: every `last_success` within one cadence, the gap list showing the outage once and no new gap after it, `verify-prod` green on freshness. A gap that the fill window did not cover stays in the list: that is the D19 loss, not a fault. No replay is needed, because nothing was archived for the lost payloads.
