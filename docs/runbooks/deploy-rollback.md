# Runbook: deploys and rollbacks

How a release reaches the VPS (A§11.2, ADR-0008):

1. A merge to `main` runs `release.yml`: images are built, signed and attested.
2. You approve `promote` (environment `production`), which publishes `prod-<UTC>` with a signed `release-manifest.json` and the deploy bundle. On GitHub's Releases page it is titled `v0.0.<PR number>` (after the switch to v1, `v1.<minor>.<n>`; `.github/release-title`), and its notes link the PR, the issues it closes and the commit; a push that no merged PR produced keeps the tag as its title. The title is only a label: the VPS, `rws-deploy` and every runbook use the tag `prod-<UTC>`, shown with each release.
3. Within 5 minutes, `rws-update.timer` verifies the manifest and every image against the release workflow's identity and deploys.

GitHub holds no credential for the server.

## Where things are

| | |
|---|---|
| `/var/lib/rws/current` | the last release that passed its smoke test |
| `/var/lib/rws/active` | → the release directory whose `compose.yaml` runs now |
| `/var/lib/rws/skip_upto` | releases up to this tag are never deployed automatically (a failed release, or a manual rollback) |
| `/var/lib/rws/releases/<tag>/` | the verified `compose.yaml`, `images.env`, manifest and bundle (the last 5) |
| `journalctl -u rws-update` | every run |

```bash
sudo journalctl -u rws-update --since '-1h'
sudo rws-update --dry-run          # what the next run would do
```

## A deploy failed

`rws-update` has already rolled back to `current` (if there was one) and pinged `update` `/fail` with a fixed code: `verify_failed`, `pull_failed`, `rolled_back`, `rollback_failed` or `first_deploy_failed`. A release with a database (P2a on) can also fail before `up`, with `db_start_failed`, `db_prepare_failed` or `migrate_failed`; that ping is followed by the rollback's own (`rolled_back`, `rollback_failed` or `first_deploy_failed`). It will not retry a release that failed after `up`: its tag is now in `skip_upto`. Find out why:

```bash
sudo journalctl -u rws-update -n 50          # verify, pull or smoke?
sudo docker compose -p rws ps; sudo docker logs --tail 80 rws-caddy-1
```

| Failure | Meaning | Next |
|---|---|---|
| `did not verify` | **First check B4**: a private GHCR package fails `cosign verify` (the signature cannot be fetched), which reads as "no valid signature". Otherwise the manifest or an image is not signed by `release.yml@refs/heads/main` | Set the packages public (B4). Otherwise do **not** override: check the Actions run and the release assets. The run pages `/fail` and retries every 5 min until a good release exists |
| `pull failed` | GHCR unreachable | Nothing changed. It retries next run by itself |
| `smoke test failed` | `/healthz` or a fresh `capture.json` missing after `up` | It rolled back. Fix the release in a new PR |
| `no previous release` | The first deploy failed | The containers were left as they are (capture may be recording). Fix the cause, then `sudo rws-deploy <tag>` |
| `latest_older` (`refused: release … is older than the current …`) | GitHub's "latest" release is older than the one running | Nothing deploys until a newer release is the latest again. Check the Releases page: was the newest release deleted or un-marked as latest? |
| `db_start_failed` | `up -d --wait db` did not get `db` healthy within 180 s | `sudo docker logs --tail 80 rws-db-1`; the disk (`docs/runbooks/disk-full.md`); the `db_postgres` secret readable by gid 61004. Nothing was migrated |
| `db_prepare_failed` | The roles and passwords were not set. The journal names the cause: `no installed roles.sql` (run the release's `bootstrap.sh`), `the secret db_<role> is missing or not 64 lowercase hex characters` (bootstrap generates them: empty the file and run it again), or `psql in the db container failed` (psql's output is discarded on purpose: it can quote a statement; look at `docker logs rws-db-1`) | Fix the cause, then `sudo rws-deploy <tag>` |
| `migrate_failed` | The `migrate` job exited non-zero. Its lines start with `migrate:` in the journal (the database URL and the password are scrubbed): dbmate's error, or, after dbmate, a partition or registry-sync error (a registry problem names the registry rows; a database error shows only its code) | The failed migration is not undone. Fix it forward in a new release (§ Migrations) |
| `host_files_changed` (`brings changed host files`) | The running release brings host files that `bootstrap.sh` has not installed | The release runs; run its bootstrap (below, "Host files"). Every run pages until then (never during a rollback hold) |

## Migrations: expand, then contract; never an automatic down

`migrate` (dbmate 2.36.0 in the server image, as `rws_migrator` acting as `rws_owner`) runs at every deploy, after `db` is healthy and its roles and passwords are set, and before `load` and `api` start. Then it creates the partitions and syncs the registry.

- **No automatic `dbmate down`.** A failed deploy rolls the images back, never the schema. The `-- migrate:down` blocks exist for development and for CI, which migrates, rolls back every migration and migrates again (`scripts/db-check.sh`). They are not a production procedure.
- **A migration must be expand-only for one release**: add a table, column or view, never drop or rename what the previous release still reads. The old image then keeps working on the new schema, and that is exactly what a rollback runs. The contract step (drop, rename, tighten) goes into a later release, once no release you could roll back to needs the old shape.
- A migration that failed half-way is not retried by hand: dbmate runs each file in a transaction, so a failed file leaves nothing behind. Fix it forward in a new release.
- A rollback to a P1b release (before the database) removes `db`, `load` and `api` (`up -d --remove-orphans`) and **keeps the `pgdata` volume**. Redeploying a P2a release later finds the data and applies only migrations that are newer.
- While no release with an `api` runs, `/api/v1/health` is a 404: the watchdog sends no `load` ping, and healthchecks.io alerts on the `load` check after about 15 minutes. Pause that check during a deliberate rollback.
- The first release with the database needs a different order (stop the timer, bootstrap, deploy on purpose): `docs/runbooks/bootstrap.md`, "the first release with the database".
- The release with P2b deploys in the normal way but brings one new host file (`rws-drill`), so `update` pings `host_files_changed` until its bootstrap has run, and the NL-1 payloads since P1 need one replay afterwards: `docs/runbooks/bootstrap.md`, "the release with P2b".
- The nightly database dump and a deploy take turns on the deploy lock: the dump waits up to 25 minutes for a running deploy, `rws-update` skips a run while a dump holds the lock, and `rws-deploy` waits for it.

## Roll back on purpose

```bash
sudo ls /var/lib/rws/releases            # the kept releases
sudo rws-deploy prod-20261001T120000Z    # any signed release, older ones included
```

`rws-deploy` takes the tag, never the title: to go back to, say, `v0.0.45`, open that release on GitHub and use its `prod-…` tag. This deploys the named release through the same checks. If it is older than the release that ran before it (a rollback), automatic updates skip everything up to the newer of that release and the latest one, so the rollback sticks until the next new release, also when GitHub cannot be reached at that moment. Redeploying the current release holds nothing back. To undo a hold, deploy the newest release on purpose.

A rollback changes only images and `compose.yaml`: the host files stay those of the newer release you bootstrapped. **Never run an older release's bootstrap**: it would install its older host scripts, units and firewall. While the hold lasts (`skip_upto` newer than `current`), the host-file check pauses, and it resumes once a newer release runs.

## Host files

`rws-update` changes only images and `compose.yaml`. When the running release brings other host files (`deploy/bin`, `deploy/host`, `deploy/systemd`, `deploy/postgres`, the healthchecks, reachability and owner-term lists, and the two `[owner]` tests; not the image build inputs, which arrive as signed images), every run pings `update` `/fail` with `host_files_changed` and logs `brings changed host files`, until you run the bootstrap inside that verified release directory (`docs/runbooks/bootstrap.md`, last section). Not during a rollback hold: see above, and never run an older release's bootstrap.
