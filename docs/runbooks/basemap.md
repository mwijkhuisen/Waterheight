# Runbook: the basemap refresh

**Trigger:**
- the P3 `[owner]` criterion of issue #18: the extract job ran on the VPS, its log is attached and the sha256 of the tile files matches the manifest (`docs/plan/PHASES.md` P3);
- the quarterly refresh of the basemap (the timer, once you enable it), and any failed or missed run of it;
- a bad extract that must be taken out of service: a rollback (§6).

The map is drawn from two static PMTiles files cut out of a Protomaps build: the Rhine basin (bbox `1.5,45.8,12.5,54.0`, z0–14, about 4.3 GB) and the world at z0–6 (about 45 MB). The files live in `/srv/rws/tiles`, which Caddy serves read-only as `/tiles/…` (A§9.1). `rws-basemap-refresh` brings in a newer build with two one-shot Compose jobs of the server image (role `basemap`, go-pmtiles 1.31.2 at `/app/bin/pmtiles`), one after the other:

| Service | Role | Network | Mounts | Does |
|---|---|---|---|---|
| `basemap` | `basemap fetch` | `egress` (TCP 443 and DNS) | `/srv/rws/tiles` read-only as `/tiles`; `/srv/rws/tiles/.staging` read-write as `/staging` | Reads the build list (`https://build-metadata.protomaps.dev/builds.json`), picks a build, extracts both files from `https://build.protomaps.com/<build>.pmtiles` into `.staging`, records their sha256 and writes `result.json` |
| `basemap-promote` | `basemap promote` and `basemap rollback` | none (`network_mode: none`) | `/srv/rws/tiles` read-write as `/tiles` | Checks what `fetch` staged, moves the two files into `/srv/rws/tiles` and writes `manifest.json` (current = the new build, previous = the build that was current). `rollback` swaps the two |

Only the owner runs it, on the VPS, as root through `sudo` (`rws-basemap-refresh` is one of the `rws-*` scripts that `bootstrap.sh` links into `/usr/local/bin`). The jobs need no secret.

## 1. The rules it keeps

| Rule | Consequence |
|---|---|
| `fetch` never writes the directory Caddy serves, and `promote` has no network | Caddy follows symlinks and holds the TLS keys. A compromised `fetch` can leave anything, links included, in `.staging`, which Caddy has no route to; only checked regular files leave it (threat model T-WEB-1, T-MAP-1) |
| Every run starts clean: `fetch` empties `.staging` first, and go-pmtiles `extract` cannot resume | An interrupted fetch costs the whole download again. A dry run changes nothing |
| A file name in `/srv/rws/tiles` is immutable: `promote` refuses a name that already holds other bytes (`exists_different`) | Browsers keep a dated file for a year. A re-extract of a build that is already served can differ byte for byte: take the previous extract back with `--rollback` (§6), not with `--build` |
| Only builds of the tiles version 4.x (`tiles_major` in `registry/basemap.yaml`), with a real date no later than tomorrow (UTC), count; a date that the list gives twice with two versions is dropped | Protomaps' next tiles major makes `no_eligible_build` until a reviewed registry change and a style check (ADR-0016) |
| Without `--build` it only moves forward: it does nothing when the newest eligible build is the current one, older than the current one, or the build that was rolled back from | A scheduled run does not undo a rollback while the build you rolled away from is still the newest (§6) |
| It has its own lock, `rws-basemap`, and never takes the `rws-deploy` lock | A refresh takes hours. A deploy during one is harmless: `fetch` touches only `.staging`, and `promote` runs for seconds. A second refresh logs `another basemap refresh is still running: nothing to do` and exits 0 |
| It sends no healthchecks.io ping (the 16 checks are a closed set) | A failed run is a failed unit and the journal (§9, §10); the map keeps working from the last good extract. Nothing alerts on a refresh that never ran: look after each scheduled date (§5) |

## 2. Before you start

1. **A release with the basemap job is deployed**: `sudo cat /var/lib/rws/current` names a release from P3 on. On an older release the script stops with `the active release has no basemap job (it predates P3): deploy a newer release first`.
2. **Bootstrap has run from that release** (`docs/runbooks/bootstrap.md`, "the release with the basemap job"). Until it has, `rws-update` pings `update` `/fail` with `host_files_changed`. It installs `rws-basemap-refresh` and its service and timer unit (the timer is not enabled), re-owns `/srv/rws/tiles` to uid 65532 (root's before P3) and creates `/srv/rws/tiles/.staging`. **Run it before the first refresh**: without it Docker creates `.staging` as root, and `fetch` cannot write there.

   **Check:**

   ```bash
   command -v rws-basemap-refresh
   stat -c '%n %a %U:%G' /srv/rws/tiles /srv/rws/tiles/.staging     # 755 65532:65532, then 700 65532:65532
   systemctl is-enabled rws-basemap-refresh.timer                   # disabled, until §7
   ```
3. **`rws.env` is complete** (`sudo rws-update --dry-run` does not say "rws.env is not complete"): the job needs `RWS_DOMAIN` and `RWS_CONTACT_EMAIL` for the User-Agent it sends to Protomaps.
4. **The disk has room**: `df -h /srv/rws`. The extracts take about 4.3 GB, and the current and the previous extract about 9 GB together. The job refuses to start when the disk would pass 75% with its two files at their size limits (6.1 GB; §8).
5. **No special time**: it holds neither the deploy lock nor the database. Backups and deploys run beside it. A reboot or a `docker` restart during a run loses the run (§9).

## 3. The first run

Three runs, from `ssh ops@<domain>`. A run takes hours: the timer's unit stops it after 4 hours (`TimeoutStartSec`), a manual run has no limit of its own, and each extract is cut off after 4 hours. It writes to the terminal, so keep a copy of the output with `tee`: it is what the `[owner]` criterion asks for (§4). If the SSH session drops, the run stops with it (§9).

1. **A dry run.** It reads the build list, probes the file with a one-byte `Range` request, checks the disk and prints what it would do. It writes nothing and promotes nothing:

   ```bash
   sudo rws-basemap-refresh --dry-run 2>&1 | tee ~/basemap-dry-run.log
   ```

   Expect a line `basemap fetch (dry run: nothing is written or promoted): this can take hours`, the role's JSON lines `builds_listed` (`eligible` and `newest`), `tiles_reachable` (`bytes`) and `disk_ok` (`used_pct`, `projected_pct`), then the plan (the build, the version and the percentages are examples):

   ```
   dry run: would stage build 20261001 (tiles 4.15.2) from https://build.protomaps.com/20261001.pmtiles
   disk: 21.3% used, 33.1% with the new files (limit 75%)
   would run: /app/bin/pmtiles extract --quiet https://build.protomaps.com/20261001.pmtiles /staging/.tmp/basemap-20261001.pmtiles --bbox=1.5,45.8,12.5,54 --minzoom=0 --maxzoom=14 --download-threads=4
   would run: /app/bin/pmtiles extract --quiet https://build.protomaps.com/20261001.pmtiles /staging/.tmp/planet-z6-20261001.pmtiles --minzoom=0 --maxzoom=6 --download-threads=4
   … rws-basemap-refresh: dry run done: fetch only, nothing promoted
   ```

   (`--build <build> --dry-run` is accepted too.) `eligible` must be 2 or more. A failure here names its code (§9) and has changed nothing.
2. **An older build.** The criterion asks that `manifest.json` lists a current and a previous extract, and "previous" exists only after a second build is promoted. Protomaps keeps its builds for about a week only, so take the older one now. List the eligible builds, oldest first:

   ```bash
   curl -fsS https://build-metadata.protomaps.dev/builds.json | jq -r '.[] | select((.version // "") | startswith("4.")) | .key' | sort | tail -n 8
   ```

   Pick one from the middle of the list, not the oldest: Protomaps deletes its oldest builds, and a build that disappears during the download fails the extract. Then:

   ```bash
   sudo rws-basemap-refresh --build <the older build> 2>&1 | tee ~/basemap-run-1.log
   ```

   The log ends with `basemap fetch done: promoting` and `basemap refreshed`; `promoted` (`build`, `previous` null) is the role's own line. `/srv/rws/tiles` now holds that build as current. Nothing on the public site draws the map before P4, so the order has no visible effect.
3. **The newest build.**

   ```bash
   sudo rws-basemap-refresh 2>&1 | tee ~/basemap-run-2.log
   ```

   It picks the newest eligible build, promotes it and makes the older build the previous one. From the third extract on, the oldest one is deleted (`retention_deleted`).

To start a run that survives a dropped session, run it under systemd instead, and read it with the journal (a unit started this way writes to the journal, not to the terminal):

```bash
sudo systemd-run --unit=rws-basemap-manual --collect /usr/local/bin/rws-basemap-refresh --build <the older build>
sudo journalctl -fu rws-basemap-manual
```

The duration and memory of a real 4.3 GB extract under the job's 512 MB limit (`GOMEMLIMIT` 400 MiB) have not been measured yet (KG-096): note the start and end times from the log, and tell the build agent if the run was killed (§9, exit 137).

## 4. Record the result

For the `[owner]` criterion, paste into issue #18:

- the output of the runs (`basemap-dry-run.log`, `basemap-run-1.log` and `basemap-run-2.log`, or `sudo journalctl -u rws-basemap-refresh --since '-1d'` for a run that the unit made);
- the manifest, and the proof that the files are the ones it names. The files and `manifest.json` are world-readable, so no `sudo` is needed:

  ```bash
  cd /srv/rws/tiles
  jq . manifest.json
  jq -r '(.current, (.previous // empty)) | .basemap, .planet | "\(.sha256)  \(.file)"' manifest.json | sha256sum -c -
  ```

  `sha256sum -c` prints `<file>: OK` for the four files. `ls -la /srv/rws/tiles` must show nothing but those four, `manifest.json` and `.staging`. `sha256sum /srv/rws/tiles/*.pmtiles` prints the same sums, for reading by eye. Hashing a 4.3 GB file takes a minute or more.

The agent then ticks the criterion in `docs/plan/PHASES.md` and updates KG-094 to KG-096 (`docs/known-gaps.md`).

## 5. Check from outside

```bash
scripts/verify-prod.sh <domain>      # from a checkout with `pnpm install --frozen-lockfile`; no SSH
```

The basemap lines (A§9.1):

| Check | Passes when |
|---|---|
| `tiles manifest` | `/tiles/manifest.json` is 200 with `Cache-Control: public, max-age=60` and parses as a manifest |
| `tiles <file>` (four after the second run) | A `Range: bytes=0-15` request for each file the manifest lists is 206, `Content-Range` is `bytes 0-15/<the manifest's byte count>`, `Cache-Control` is exactly `public, max-age=31536000, immutable`, there is no `Content-Encoding` (the request offers gzip and zstd) and the first bytes are the PMTiles magic |
| `tiles previous` | n/a while the manifest has no previous extract (after the second run: pass) |
| `tiles 404` | `/tiles/`, `/tiles/.staging/` and a dated name that nothing promoted answer 404, and none of them is marked immutable |
| `map assets` | A pinned glyph file under `/assets/map/028c18f/` is 200 and immutable |

Before the first extract, `tiles manifest` and `tiles previous` **fail**: expected until §3 is done. By hand, `curl -sS -D - -o /dev/null -r 0-15 https://<domain>/tiles/<file>` shows the status line, `Content-Range` and `Cache-Control` of one file.

After a scheduled run, look within a day: `sudo journalctl -u rws-basemap-refresh --since '-1d'` ends with `basemap refreshed` (or `already current`, §7), `curl -fsS https://<domain>/tiles/manifest.json | jq '{current: .current.build, previous: .previous.build, created_at: .current.created_at}'` shows the new build, and `verify-prod.sh` is green.

## 6. Roll back

```bash
sudo rws-basemap-refresh --rollback
```

Journal lines: `basemap rollback: promoting the previous build again`, the role's `rolled_back` (`current`, `previous`) and `basemap rolled back`. It takes seconds and needs no network.

- It checks the previous extract first (regular files, one link each, the size and sha256 of the manifest) and then swaps `current` and `previous` in one atomic manifest write. No file is moved or deleted. Browsers learn the change from the manifest, which they keep for 60 seconds.
- **A second rollback undoes the first.** To return to the build you rolled away from, roll back again; do not fetch it again with `--build` (`exists_different`, §1).
- `--rollback` takes no other flag (exit 64).
- **A scheduled run does not undo it, for a while.** Without `--build` the job skips the build you rolled away from (`rolled_back_build`) and any build older than the current one (`not_newer`). The next quarterly run finds a newer build, fetches it and makes it current: the rolled-back state lasts only until then. To stay on the older extract longer, stop the timer (`sudo systemctl disable --now rws-basemap-refresh.timer`) and enable it again (§7) when you want refreshes back.
- After a rollback, run `scripts/verify-prod.sh <domain>`. The map itself is checked by looking at it; before P4 there is no production page that draws it.

## 7. Later runs and the timer

`sudo rws-basemap-refresh` at any time is safe. When the newest eligible build is the one that is current it prints `already current: <build>` and exits 0 (`not newer than the current build …` and `… is the build that was rolled back: nothing to do` are the other two no-ops). A real refresh promotes the new build, makes the build that was current the previous one and deletes every tile file that neither manifest entry names: the disk holds two extracts at rest (about 9 GB) and three during a run.

**Enable the quarterly timer** once §3 and §5 are done:

```bash
sudo systemctl enable --now rws-basemap-refresh.timer
systemctl list-timers 'rws-*'          # the NEXT column of rws-basemap-refresh.timer
```

It fires on the 15th of January, April, July and October at 05:10 UTC plus a random delay of up to one hour (clear of the 03:40 UTC unattended-upgrades reboot) (`Persistent=true`: a run that came due while the host was off starts after the next boot). The unit has a 4-hour limit (`TimeoutStartSec`). A scheduled run that fails is not retried before the next quarter: the map stays on the last good extract, and `sudo rws-basemap-refresh` by hand is the retry (§9).

## 8. Disk

The two extracts take about 9 GB (A§11.4); `/srv/rws` alerts at 75% (`docs/runbooks/disk-full.md`). Before it downloads anything, `fetch` computes (used + 6.1 GB, the size limits of the two files) ÷ the disk's total, and refuses with `disk` above 75%. Free space as `disk-full.md` says, then run again. Do not delete a tile file that `manifest.json` names; `.staging` leftovers are safe to delete while no refresh runs (`disk-full.md` §2).

## 9. When it fails

A failed run exits 1 after one line from the script. The line above it, the role's own, carries the fixed code; the tables below read both. Provider text never appears in them, except that `extract_failed` also logs `status` and a tail of at most 400 ASCII characters of go-pmtiles' own message.

The script's lines (`<UTC> rws-basemap-refresh: …`; an error starts with `error:`):

| Line | Meaning | Do |
|---|---|---|
| `no release is deployed yet` | No `/var/lib/rws/active` | The first deploy (`docs/runbooks/bootstrap.md` §5) |
| `rws.env is not complete (owner steps A2-A4 …)` | `RWS_DOMAIN`, `RWS_CONTACT_EMAIL` or an address is missing | `docs/runbooks/bootstrap.md` §4 |
| `the active release has no basemap job (it predates P3) …` | The running release has no `basemap` service | Deploy a newer release (`docs/runbooks/deploy-rollback.md`) |
| `another basemap refresh is still running: nothing to do` | The lock is held (exit 0) | Wait. If nothing runs, look for a leftover container (below) |
| `basemap fetch failed (exit N): nothing was promoted` | The fetch job exited with N: 1 failure, 78 configuration, 64 usage; 137 is the container killed from outside, most likely out of memory (KG-096) | Read the code in the role's line above it (table below) |
| `basemap promote failed (exit N)` | The staged files were not (fully) promoted; `.staging` still holds what was not moved | The table below says which. After the cause is fixed, run `sudo rws-basemap-refresh` again: it first promotes what is staged, before it fetches anything; or promote alone (below). When the staged files themselves are bad, empty `.staging` (`sudo find /srv/rws/tiles/.staging -mindepth 1 -delete`) and refresh |
| `basemap rollback failed (exit N)` | Nothing changed | Table below |

The role's codes (`{"role":"basemap","msg":"<code>",…}`; exit 1 unless noted):

| Code | Meaning | Do |
|---|---|---|
| `env_contact` (78) | `RWS_DOMAIN` or `RWS_CONTACT_EMAIL` missing or malformed in the container | `/etc/rws/rws.env` (`docs/runbooks/bootstrap.md` §4) |
| `registry_unreadable`, `registry_invalid` (78) | The image's `registry/basemap.yaml` cannot be read or fails its schema | A broken release: roll it back (`docs/runbooks/deploy-rollback.md`) and fix it in a PR; nothing to repair on the host |
| `tiles_dir` (78, every command), `staging_dir` (78, `fetch` only) | A mount is missing or not a directory in the container | `stat` both directories (§2, step 2); run the release's bootstrap |
| `builds_<code>`, `tiles_<code>` | The build list or the probe failed with the HTTP client's code: `timeout`, `network`, `dns`, `too_large`, `bad_encoding`, `bad_status` and the like. `private_address`, `not_allowlisted` or `bad_url` mean the name resolved to a private address or the registry's URL is outside its hosts | A network or provider problem: try again later; `rws-reachability` has the target `protomaps-builds`. For the other three, a DNS problem or a bad registry edit: do not retry blindly, open an issue |
| `builds_redirect`, `tiles_redirect` | The host answered with a redirect, which the job refuses (the registry names the final URL) | Protomaps moved the file: a reviewed change of `registry/basemap.yaml` (a PR). `curl -sI https://build-metadata.protomaps.dev/builds.json` shows where |
| `builds_status` | The build list did not answer 200 | As above, or wait |
| `builds_invalid` | The list is not UTF-8 or not a bounded JSON array | The format changed: open an issue |
| `no_eligible_build` | No listed build is of tiles version 4.x, dated up to tomorrow | Protomaps moved to another tiles major: do not change `tiles_major` without the style check of ADR-0016 |
| `build_not_eligible` | `--build` names a build that is not in the eligible list (older than the list, a bad date, another major) | List the builds again (§3, step 2) and pick another |
| `tiles_status` | The one-byte `Range` probe did not answer 206 with a `Content-Range` total: the file is gone, or the host ignores `Range` | Pick another build with `--build` |
| `disk`, `disk_unknown` | The disk would pass 75% (§8), or its size could not be read | Free space and run again; `df /srv/rws` |
| `staging_clean` | `.staging` could not be emptied | Look at `sudo ls -la /srv/rws/tiles/.staging` (an entry owned by root, from before bootstrap); empty it as root (`disk-full.md` §2), run bootstrap, run again |
| `extract_failed` | go-pmtiles exited non-zero, hit the 4-hour limit, or was stopped. The `extract_failed` line has `kind` (`basemap` or `planet`), `status` (`exit N`, `signal …`, `not_started`) and `tail` | A dropped connection, a build that left Protomaps' list mid-download, a redirect to another host, or memory (KG-096). Run again: nothing is resumed, the whole download starts over |
| `extract_output` | The output file is missing, not a regular file, empty, larger than the registry's limit (6 GB for the basin, 100 MB for the world) or changed while it was hashed | The limits are `max_bytes` in `registry/basemap.yaml`; raising one is a reviewed change |
| `manifest_invalid` | `/srv/rws/tiles/manifest.json` exists but is not exactly the manifest this version writes (`fetch`, `promote` and `rollback`) | Nothing of ours writes such a file (every write is checked first), so it was changed from outside. Do not edit it; open an issue |
| `staging_dir` (from `promote`) | `.staging` is a link or cannot be read | Look at `ls -ld /srv/rws/tiles/.staging`; it must be a real directory (0700, uid 65532) |
| `result_invalid` | `result.json` is not what `fetch` writes | Run the whole refresh again (`fetch` empties `.staging`) |
| `not_regular_file` | A staged or served tile file is a link, a pipe or has more than one link | **Not in normal operation.** Do not promote. `sudo ls -la /srv/rws/tiles /srv/rws/tiles/.staging`, empty `.staging`, and open an issue (T-MAP-1) |
| `file_too_large`, `sha_mismatch`, `file_changed`, `staged_missing` | A staged file is over its limit, differs from the sha256 that `fetch` recorded, changed during the check, or is gone | Run the whole refresh again |
| `exists_different` | A file of that name is already served with other bytes | Do not delete served files to get past this. If `manifest.json` names the file, take another build; if it does not (an orphan of a promote that was cut off, described below the table), delete that one file and run again |
| `verify_failed` | `pmtiles verify` rejected the archive (limit 30 minutes) | A damaged download: run again; if it repeats, open an issue |
| `header_unreadable`, `header_type`, `header_zoom`, `header_bounds` | The PMTiles header is not what the registry says: vector tiles, z0–14 (basin) and z0–6 (world), basin bounds inside the bbox ± 0.01°, a world extract that spans the world | Protomaps changed the build: check the style against it (ADR-0016) before any registry change. The log has a line `file_refused` with `kind` and `reason` |
| `retention_failed` | The new build **is** promoted, but an old tile file could not be deleted | The map is fine. Run promote alone (below); or delete the old build's two files by hand, only names that `manifest.json` does not list |
| `no_manifest`, `no_previous` | `rollback` has nothing to roll back to (nothing was promoted yet; only one extract so far) | Nothing to do |
| `previous_missing`, `previous_changed` | A file of the previous extract is gone, or differs from the manifest's size or sha256 | Do not roll back to it: the tiles are not backed up. Keep the current extract, or fetch another build with `--build` |
| `unexpected` | A bug: the line has `name` and `error_code` | Open an issue with that line |

**Promote alone.** `promote` is idempotent: a name that is already served with the staged bytes is kept, and `result.json` goes last. So a promote that stopped half way (a reboot, `retention_failed`, a fixed cause after `promote failed`) is finished by running it again. `rws-basemap-refresh` does that itself: every run promotes what is staged before its `fetch` empties `.staging`, and stops (`basemap promote of the build an earlier run staged failed`) without fetching when that fails. To promote only, with the `rwsc` function of `docs/runbooks/replay.md` §2:

```bash
rwsc run --rm --no-deps -T basemap-promote basemap promote --dry-run   # what it would do, or the code that stops it
rwsc run --rm --no-deps -T basemap-promote basemap promote
```

A promote that was cut off after it moved a file but before it wrote the manifest leaves that file in `/srv/rws/tiles` without a manifest entry; the next run's first promote finds it there with the staged sha256 and finishes the job. Only if `.staging` was emptied by hand in between can a fetch of the same build bring other bytes, and `exists_different` stop the run: then delete that one orphan (a tile name that `manifest.json` does not list), not any other, and run again.

**A leftover container.** If the script was killed (the SSH session dropped, the unit was stopped or timed out), the `fetch` container may still be running: it is not verified that the signal reaches a `compose run` container, and the lock goes with the script. A leftover go-pmtiles keeps downloading into `.staging/.tmp`, and the next run would empty that directory beneath it. Look first, and remove it before the next run:

```bash
sudo docker ps --filter name=basemap
sudo docker rm -f <the container name that it shows>
```

An interrupted `fetch` leaves only `.staging` behind (a partial `.tmp`, perhaps a `result.json`): nothing is served from there, and the next run empties it.

## 10. Logs

```bash
sudo journalctl -u rws-basemap-refresh --since '-7d'      # runs of the timer (or of `systemctl start rws-basemap-refresh`)
sudo journalctl -u rws-basemap-manual                     # a run started with systemd-run (§3)
```

A run from a shell is not in the journal: its output is the terminal, so keep it (§3). The role's lines are pino JSON, one per event: `staging_cleared`, `builds_listed`, `tiles_reachable`, `disk_ok`, `extract_started` and `extract_done` per file, `staged`; from `promote`, `file_moved`, `promoted` (`build`, `previous`), `retention_deleted`; `already_current`, `not_newer`, `rolled_back_build` and `nothing_staged` for the no-ops; `rolled_back` for a rollback. To read them: `… | grep '"role":"basemap"' | jq -c '{msg, build, kind, eligible, newest}'`.

## What not to do

- Do not put a tile file or `manifest.json` into `/srv/rws/tiles` by hand, and do not delete a file the manifest names (`disk-full.md`). `promote` is the only writer.
- Do not mount `/srv/rws/tiles` read-write into the `basemap` (fetch) service, in a compose change or by hand: Caddy follows symlinks and holds the TLS keys (T-WEB-1).
- Do not empty `.staging` by hand after a cut-off promote: the next run finishes it from there (§9).
- Do not start a second run while a `fetch` container is still alive (`sudo docker ps --filter name=basemap`).
- Do not enable the timer before the first run has gone through and `verify-prod.sh` is green (§3, §5, §7).
- Do not change `tiles_major`, a zoom range or a bbox in `registry/basemap.yaml` without the style check of ADR-0016: the styles and the promote checks follow it.
