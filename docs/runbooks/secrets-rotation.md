# Runbook: secrets rotation drill (P12a, issue #27 criterion 9)

The inventory is `docs/security/secrets.md`. This is the drill that proves each rotation works **and that the old credential stops working**. Run it as a whole after any change to the inventory, after any suspected leak (then only the steps of the leaked secret, at once) and at least once a year. An [owner] task: it needs the VPS, the healthchecks.io account and the owner's devices. Agents have no production access and no WireGuard peer.

The compose end-to-end test (`deploy/tests/e2e/run.sh`) runs steps 3 and 4 against **throw-away test credentials** (a test `basic_auth` password and a test WireGuard peer in the `ext`/`wgpeer` namespaces): it rotates the test password and proves the old one answers 401 and the new one 200, then revokes the test peer and proves that the peer's handshake no longer succeeds. It never touches a production secret.

Rules for every step: no secret on a command line (use `sudoedit`, stdin or a password manager), no secret pasted into an issue or a PR (paste the output of the check commands only), edit files **in place**, and write the date and the result into the drill record at the end.

## Before you start

```bash
ssh ops@<domain>
sudo stat -c '%n %a %U:%G' /etc/rws/secrets/* /etc/wireguard/wg0.key   # 440 root:rws-* ; 600 root:root
sudo docker compose -p rws ps                                           # everything healthy
sudo rws-wg-peer list                                                   # only the owner's devices
```

## 1. healthchecks.io ping URLs (`hc_ping_key`)

The ping URLs are `https://hc-ping.com/<ping key>/<slug>` (18 slugs, `deploy/healthchecks.yaml`). Anybody holding the key can send pings for them.

1. In the healthchecks.io project settings, create a new ping key and revoke the old one (the button names may change; the point is that the old key's URLs stop answering).
2. `sudoedit /etc/rws/secrets/hc_ping_key` and replace the line with the new key (in place; do not replace the file). Capture and the watchdog read it before every ping, so no restart is needed.
3. Wait 10 minutes. **Check:** every check in the project is green again (the `cap-*`, `update`, `watchdog`, `cert`, `disk`, `load`, `publisher` and `owner-publisher` ones within their timeouts; `backup` at the next :17).
4. **Old key is dead.** From your workstation, with the old key from your password manager: `curl -s -o /dev/null -w '%{http_code}\n' https://hc-ping.com/<old key>/watchdog` must **not** print `200` (it prints `404`). Delete the old key from the password manager afterwards.
5. If `deploy/bin/rws-hc-sync` uses an API key (`hc_api_key`, on your workstation only), re-create that one in the account settings too, replace `~/secure/hc_api_key`, and run `rws-hc-sync --dry-run` once.

## 2. Database role passwords

For each role to rotate (`docs/runbooks/bootstrap.md` §3, "Rotating a database password"): empty the secret file in place, re-run `bootstrap.sh`, `rws-deploy` the current tag, restart the consumer.

```bash
sudo sh -c ': > /etc/rws/secrets/db_rws_api'
sudo /usr/local/lib/rws/deploy/host/bootstrap.sh
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"
sudo docker restart rws-api-1
```

**Check:** `sudo docker compose -p rws ps` shows the consumer healthy; `curl -s https://<domain>/api/v1/health` answers; `sudo stat` still shows `440 root:rws-db…`. **Old password is dead:** `rws-deploy` set the new password on the role in the database, so the old value no longer logs in (the integration test `roles.int.test.ts` proves the grants, not the rotation; this step is the proof). Rotate `db_rws_owner_api` (restart `rws-publish-owner-1` and `rws-api-owner-1`) the same way when the owner overlay is on.

## 3. The owner `basic_auth` password

Canonical procedure: `docs/runbooks/owner-password-rotation.md`. The drill's checklist:

1. Generate a new password of at least 32 random characters **in your password manager** (not on the VPS). Keep the old one until step 4.
2. Make the bcrypt hash on the VPS without putting the password on a command line (stdin from your terminal): `sudo docker run --rm -i --entrypoint caddy "$(sudo docker inspect -f '{{.Config.Image}}' rws-caddy-owner-1)" hash-password` and paste the password when it asks. If the runbook above gives a different command, use that one.
3. `sudoedit /etc/rws/secrets/owner_basic_auth` and replace the line with `owner <the new hash>` (one line, in place), then `sudo docker restart rws-caddy-owner-1` (the file is read when Caddy loads its config).
4. Over WireGuard, with `scripts/verify-owner.sh` (it asks for the password; nothing on argv): **the old password answers 401 on every path, the new one answers 200**, `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow` are on both answers. Also try no credentials: 401.
5. Delete the old password from the password manager. **Check:** `sudo stat -c '%a %U:%G' /etc/rws/secrets/owner_basic_auth` is `440 root:rws-ownerauth`; `sudo docker logs rws-caddy-owner-1 2>&1 | grep -c -F "<a fragment of the old password>"` is 0 (the password is not logged; the `Authorization` header is deleted from the access log).

## 4. A WireGuard peer: revoke and replace

1. Add a replacement first if the device is still yours: `sudo rws-wg-peer add laptop-2 >laptop-2.conf` (the client config is printed once, to stdout; the notes go to stderr), import it on the device through a channel you control, then delete the file from the VPS (`shred -u laptop-2.conf`).
2. Revoke the old peer: `sudo rws-wg-peer revoke laptop`. Its session ends at once.
3. **Check:** `sudo rws-wg-peer list` and `sudo wg show wg0` list only the owner's current devices; the revoked public key is gone. From the revoked device the tunnel no longer completes a handshake (`wg show` there shows no recent handshake) and `scripts/verify-owner.sh` over it fails with a timeout, not a 401.
4. **Server key** (only after a suspected leak of the VPS itself): it is a re-provisioning of every device (`docs/runbooks/owner-device.md`); do it as an incident, not as a drill.
5. `caddy-owner`'s internal CA root (volume `caddy_owner_data`) rotates only with a re-import of the root certificate on each device (same runbook).

## 5. The other secrets (annually, or on suspicion)

- `rws_x_api_key`: new UUID in the file, `sudo docker restart rws-capture-1`, tell RWS (C7). **Check:** `/status/capture.json` shows the NL group capturing without `auth` errors.
- `s3_credentials`: create the new VPS key at the bucket, `sudoedit` the file, run `sudo rws-backup` once, **then** delete the old key at the bucket. **Check:** `/status/ops.json` shows a fresh `last_backup`; the old key's `restic snapshots` from your workstation fails with an access error.
- `restic_password`: only with a restore drill (`docs/runbooks/restore.md`).
- SSH keys: add, test a second session, remove (`docs/runbooks/lost-ssh.md`).

## 6. Record the drill

Append to the issue or PR you are working in: date, which steps, and these lines of evidence (no secret values): the `stat` listing, `rws-wg-peer list` names, the healthchecks project status, the `401`/`200` results of step 3 and the `404` of step 1.4. Anything that did not behave as written is a finding: fix the runbook or the system, and note it in `docs/known-gaps.md`.
