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

`rws-update` has already rolled back to `current` (if there was one) and pinged `update` `/fail`. It will not retry that release: its tag is now in `skip_upto`. Find out why:

```bash
sudo journalctl -u rws-update -n 50          # verify, pull or smoke?
sudo docker compose -p rws ps; sudo docker logs --tail 80 rws-caddy-1
```

| Failure | Meaning | Next |
|---|---|---|
| `did not verify` | The manifest or an image is not signed by `release.yml@refs/heads/main` | Do **not** override. Check the Actions run and the release assets. The run pages `/fail` and retries every 5 min until a good release exists |
| `pull failed` | GHCR unreachable, or the packages are private (B4) | Nothing changed. It retries next run by itself |
| `smoke test failed` | `/healthz` or a fresh `capture.json` missing after `up` | It rolled back. Fix the release in a new PR |
| `no previous release` | The first deploy failed | The containers were left as they are (capture may be recording). Fix the cause, then `sudo rws-deploy <tag>` |

## Roll back on purpose

```bash
ls /var/lib/rws/releases                 # the kept releases
sudo rws-deploy prod-20261001T120000Z    # any signed release, older ones included
```

This deploys the named release through the same checks. If it is older than the latest release, automatic updates skip everything up to that latest one, so the rollback sticks until the next new release. To undo that, deploy the newest release on purpose.

## Host files

`rws-update` changes only images and `compose.yaml`. When a release changes the host scripts, units or firewall, its log says `brings changed host files`. Run the bootstrap inside that verified release directory (`docs/runbooks/bootstrap.md`, last section).
