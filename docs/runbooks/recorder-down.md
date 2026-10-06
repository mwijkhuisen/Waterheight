# Runbook: the recorder is down or stale

**Trigger:**
- a `cap-*` healthchecks alert (one provider group, no successful run for 3 × its cadence);
- `watchdog` failing with `capture_stale` or `healthz_*`;
- `verify-prod.sh` reports `FAIL freshness`.

Every hour down loses unrecoverable forecast runs and class states (ADR-0003), so start here.

## 1. Is it one provider or all of them?

```bash
curl -s https://<domain>/status/capture.json | jq -r '.specs[] | "\(.spec) \(.last_success) \(.last_failure_status) \(.failed_items // [] | join(","))"'
```

- **Only one group is stale** and `last_failure_status` names an HTTP status or a code (`timeout`, `dns`, `backoff`, `breaker_open`): the provider is down or blocks us. See §4.
- **`fr-1-obs` or `lu-5-cap` is stale and `last_failure_status` is `404`, `400`, `invalid` or `too_large`:** a page of a walk failed (#42). Every run asks the same window again from the same point. Hub'Eau keeps one month, so no FR-1 data is lost while it recovers; for LU-5, dumps behind the failed page may stay unfetched (KG-011). The manifest query below shows which page failed and since when. If the query prints nothing, the first request itself failed (variant `default`); the handling is the same. If it lasts for hours, open an issue with that output. Do not edit the state by hand.
- **Everything is stale, or `generated_at` is old:** the capture process itself is the problem. Continue with §2.
- **A fresh spec that names `failed_items`:** a partial run (#39). Its lists came in, and those items did not: an FR-4 station, an FR-5 section or an LU-5 file. The run still counts; `last_failure_status` keeps the first failure of the last run that had one. The next run asks again: an FR-4 station while it is listed, an LU-5 file because it is not marked seen, an FR-5 section at the next daily run or its hourly retry. An LU-5 `file/<id>` that stays in the list for hours with the daily alert `item_refused` was never requested: data.public.lu changed the host or path of the dump URL, so the recorder refuses it (#44); open an issue, do not edit the state. Act only when the same items fail for hours (§4). A spec whose items all failed, one of them transiently, is no success and goes stale like any other. A spec whose items all failed non-transiently (a 404, a 200 carrying `error_msg`, an invalid body, a redirect or `too_large`) still counts and stays fresh with none of them stored (R-059): only `failed_items`, the daily `invalid` alert and the `run done` log line's `ok` and `failed_items` counts show it.

The failed walk pages of FR-1 and LU-5 in the manifest (read-only, on the VPS; the last field is `true` for a seed request):

```bash
sudo jq -c 'select(((.spec == "fr-1-obs" and (.variant | test("#[0-9]+$"))) or (.spec == "lu-5-cap" and .variant == "list"))
  and ((.status != 200 and .status != 206) or .validity.ok == false or .error != null))
  | [.fetched_at.start, .spec, .variant, .status, .error, .validity.reason, (.seed // false)]' \
  /srv/rws/raw/_manifest/*.jsonl
```

Lines with status 200 and reason `count` from before the #42 release are empty last pages, not failures: Hub'Eau ends every walk over a closed window with one, and the recorder now reads it as the end of the walk.

## 2. The container

```bash
sudo docker compose -p rws ps                      # capture: healthy?
sudo docker logs --tail 100 rws-capture-1          # JSON lines (pino)
sudo systemctl status rws-tick.timer docker        # rws-tick restarts an unhealthy container every 10 min
```

| What you see | Cause and fix |
|---|---|
| Exit 78, restarting | `RWS_DOMAIN` or `RWS_CONTACT_EMAIL` missing or malformed in `/etc/rws/rws.env` (A2). Fix it, then `sudo rws-deploy "$(sudo cat /var/lib/rws/current)"` |
| `EACCES` on `/run/secrets/…` | Secret file mode or group changed. Re-run `sudo /usr/local/lib/rws/deploy/host/bootstrap.sh` (it resets `root:<gid> 0440`) |
| `ENOSPC` | The disk is full: `docs/runbooks/disk-full.md` |
| `unhealthy` for > 10 min | `sudo docker restart rws-capture-1`; if it recurs, capture the logs and open an issue (T-CAP-8) |
| Container missing | `sudo rws-deploy "$(sudo cat /var/lib/rws/current)"` recreates the stack from the current verified release |
| Healthy, `/srv/rws/public/status/capture.json` fresh, but the site's copy old | The copy job: `systemctl status rws-status-copy.path rws-status-copy.service` and `sudo journalctl -u rws-status-copy -n 20`. `refused: … not a regular file` or `not the … contract document` means capture wrote something it never should: treat it as a compromise (T-WEB-1), do not copy it by hand. `names an owner-audience term (invariant 11 tripwire)` means the public file names an owner source, spec or host, or the owner canary: a capture bug or a compromise, an invariant-11 incident; never copy it by hand (`sudo jq . /srv/rws/public/status/capture.json` shows it to you, on the VPS only). If the path unit is `failed` or `inactive`, `sudo systemctl restart rws-status-copy.path` (`rws-tick` re-arms it within 10 min). Otherwise `sudo rws-status-copy`; `rws-tick` also runs it every 10 min |

## 3. The host

```bash
systemctl is-active rws-firewall docker     # both active
sudo nft list set inet rws resolvers4       # must hold the host's DNS servers
getent hosts api.hochwasserzentralen.de     # DNS from the host works
```

An empty resolver set means containers have no DNS. Run `sudo rws-resolvers` (it runs by itself at boot once the network is up, whenever `resolv.conf` changes, and every 10 minutes from `rws-tick`).

## 4. One provider fails

- **403 or 451, or a Cloudflare challenge:** our address may be blocked. Run `sudo -u ops rws-reachability --only <target>` and compare with `docs/reachability-*.md`. Record the block and its fallback in `docs/risk-register.md`, and contact the provider (§6.2 C-actions).
- **404 on NL-4:** the file moved (the CTD switch on 2026-11-05). The alert names the new file; update `registry/capture.yaml` in a PR.
- **429 from `www.vigicrues.gouv.fr` (FR-3, FR-4, FR-5):** Vigicrues throttles without a documented limit and sends no `Retry-After` (R-059). A few stations in `failed_items` during an event are expected. If `fr-4` goes stale, no station of its runs came in: the `run done` log lines (`sudo docker logs rws-capture-1 | grep '"fr-4"'`) show `transient: true` and how many items failed (`failed_items` in the status file lists 20 at most). Check that the spec still has `space_ms: 2000` in `registry/capture.yaml`, and record the event under R-059.
- **5xx or timeouts:** the provider's outage. Capture backs off (30 s → 30 min) and the gap-stretch window refills what the provider keeps (A§7.3).

## 5. After a fix

- `curl -s https://<domain>/status/capture.json | jq .generated_at` is less than 2 min old;
- the stale specs show a new `last_success` within one cadence;
- the healthchecks check turns green by itself.
