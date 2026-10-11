# Runbook: the brownout (flood mode)

**Trigger:**
- the API is overloaded in a flood spike (the API 5xx share climbs, `docs/runbooks/api.md` §3) and the map must keep working from static files;
- the site shows the "reduced service" banner and you need to know why, or want it off;
- before a planned load test or an announced flood warning, when you want the brownout on before the traffic arrives.

The brownout is the cheap way to shed load. While it is on:
- **API** (`api`): a series request spans at most 30 days; `res=raw` is refused with HTTP 503 and the error code `brownout` (header `X-Brownout: 1`); the automatic resolution never picks raw; the cache lifetimes of mutable answers are raised (a mutable URL never becomes `immutable`).
- **Static files** (Caddy): the mutable classes get longer cache lifetimes; `meta.json` is exempt because it carries the flag.
- **Publisher** (`publish`): `meta.json` has `"brownout": true`. The owner publisher never sets it.
- **Web**: an NL/EN banner beside the degraded banner, and the history view is limited to 30 days.
- Capture, the loader, the registry and the warnings step are **not** touched: ingestion keeps its priority and the warnings refresh still runs every cycle.

Users see the banner and shorter history; the live map, the station panels and the last 30 days work as before. They never see an error caused by the switch itself, except an explicit raw request.

## 1. The flag

`/srv/rws/brownout/` (root, 0755) holds two files; `api`, `publish` and `caddy` mount the directory read-only at `/run/rws-brownout`.

| File | Meaning |
|---|---|
| `mode` | `on`, `off` or `auto` (written by `rws-brownout`; a missing file counts as `auto`) |
| `active` | exists exactly while the brownout is on |

The containers re-check `active` about every 2 seconds, so a switch takes effect within a few seconds and needs no restart.

## 2. Look at it

```bash
sudo rws-brownout status
```

```text
mode: auto
active: no
window 5 min: requests=1840 5xx=12 share=0.65%
calm since: 1790000000        # only while active and the share is under 0.5 %
```

`requests` and `5xx` count only `/api/v1/*` in Caddy's access log over the last 5 minutes. The brownout's own refusals (503 with `X-Brownout`) are left out of both numbers, so a brownout never keeps itself armed. Every switch is one journal line without request data:

```bash
sudo journalctl -t rws-brownout --since "2 hours ago"      # or: -u rws-brownout.service
```

## 3. Switch by hand

```bash
sudo rws-brownout on      # flood expected or in progress: on now, and auto-mode stays out of the way
sudo rws-brownout off     # the site is fine and the banner is wrong: off now, and it stays off
sudo rws-brownout auto    # hand control back to the evaluator
```

A manual `on` or `off` **overrides** the automatic mode until you run `auto`: the evaluator does nothing while `mode` is `on` or `off`. Remember `auto` afterwards, or the next flood will not arm itself. `auto` leaves the flag as it is; the evaluator disarms a brownout only after 10 minutes of calm (below), so `on` followed by `auto` on a quiet site switches off 10 minutes later.

Check the effect:

```bash
curl -s https://<domain>/data/v1/meta.json | jq .brownout          # true within one publisher cycle
curl -s -o /dev/null -w '%{http_code}\n' 'https://<domain>/api/v1/series?...&res=raw'   # 503 while on
```

## 4. What auto does

`rws-brownout.timer` runs `rws-brownout evaluate` every 15 seconds as root. It acts only when `mode` is `auto`.
- It reads what Caddy appended to `/var/lib/docker/volumes/rws_caddy_data/_data/access/access.log` since the last run (inode and offset in `/var/lib/rws/brownout/pos`; a log rotation or a truncation restarts at the start of the new file; a run reads at most 4 MiB).
- **Arms** when more than 2 % of the API requests of the last 5 minutes answered 5xx, and there were at least 200 requests (so a quiet night with two errors never arms). Engagement is therefore within the 15 s timer period of the share crossing 2 %, well inside the 60 s of the criterion.
- **Disarms** when that share has been under 0.5 % (or there were no API requests) for 10 minutes in a row. Between 0.5 % and 2 % it stays as it is, so it does not flap.

## 5. Troubleshooting

| You see | Do |
|---|---|
| `active: no` during an obvious overload | `mode` is `off`? `rws-brownout auto`. Otherwise the API may not be answering at all (then no 5xx is logged by Caddy only if Caddy itself answers 502/503: they count). Switch `on` by hand |
| `active: yes` after the flood, `mode: auto` | Wait 10 minutes of calm (`calm since:` shows the start). `off` if you cannot wait, then `auto` |
| `requests=0` while the site is busy | The access log path is wrong or Caddy does not log (`docker volume ls`, the path in `deploy/bin/rws-brownout` `RWS_BROWNOUT_LOG`); `sudo docker exec rws-caddy-1 ls -l /data/access` |
| `rws-brownout.timer` inactive | `systemctl enable --now rws-brownout.timer` (bootstrap enables it); `systemctl status rws-brownout.service` |
| banner still shown after `off` | `meta.json` updates on the next publisher cycle; hard-refresh the browser |

The flag never changes data: after `off` everything is back at once, and no file needs regenerating.

During a flood also read `docs/runbooks/api.md` (rate limits, saturation) and, for the CDN fallback of the tiles and assets, the CDN break-glass runbook of the same PR.
