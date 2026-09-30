# Runbook: deploys and rollbacks

How a release reaches the VPS (A§11.2, ADR-0008):

1. A merge to `main` runs `release.yml`: images are built, signed and attested.
2. You approve `promote` (environment `production`), which publishes `prod-<UTC>` with a signed `release-manifest.json` and the deploy bundle.
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

`rws-update` has already rolled back to `current` (if there was one) and pinged `update` `/fail` with a fixed code: `verify_failed`, `pull_failed`, `rolled_back`, `rollback_failed` or `first_deploy_failed`. It will not retry a release that failed after `up`: its tag is now in `skip_upto`. Find out why:

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
| `host_files_changed` (`brings changed host files`) | The running release brings host files that `bootstrap.sh` has not installed | The release runs; run its bootstrap (below, "Host files"). Every run pages until then (never during a rollback hold) |

## Roll back on purpose

```bash
sudo ls /var/lib/rws/releases            # the kept releases
sudo rws-deploy prod-20261001T120000Z    # any signed release, older ones included
```

This deploys the named release through the same checks. If it is older than the release that ran before it (a rollback), automatic updates skip everything up to the newer of that release and the latest one, so the rollback sticks until the next new release, also when GitHub cannot be reached at that moment. Redeploying the current release holds nothing back. To undo a hold, deploy the newest release on purpose.

A rollback changes only images and `compose.yaml`: the host files stay those of the newer release you bootstrapped. **Never run an older release's bootstrap**: it would install its older host scripts, units and firewall. While the hold lasts (`skip_upto` newer than `current`), the host-file check pauses, and it resumes once a newer release runs.

## Host files

`rws-update` changes only images and `compose.yaml`. When the running release brings other host files (`deploy/bin`, `deploy/host`, `deploy/systemd`, the healthchecks, reachability and owner-term lists, and the two `[owner]` tests; not the image build inputs, which arrive as signed images), every run pings `update` `/fail` with `host_files_changed` and logs `brings changed host files`, until you run the bootstrap inside that verified release directory (`docs/runbooks/bootstrap.md`, last section). Not during a rollback hold: see above, and never run an older release's bootstrap.
