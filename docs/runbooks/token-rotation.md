# Runbook: token and credential rotation (index)

**Trigger:**
- a suspected leak of any credential, or the yearly rotation;
- a provider tells us to renew a key or token;
- you need to know which runbook rotates what.

The inventory is `docs/security/secrets.md`; this page only points. Rules for every rotation: no secret on a command line or in an issue, edit files in place, and check that the **old** credential stops working.

## 1. Pick the runbook

| Credential | Runbook |
|---|---|
| healthchecks.io ping key, database role passwords, WireGuard peers, the other VPS secrets (`rws_x_api_key`, S3 key, ACME) | `docs/runbooks/secrets-rotation.md` (drill steps 1 to 5) |
| owner site `basic_auth` password | `docs/runbooks/owner-password-rotation.md` |
| WireGuard peer of a lost device | `docs/runbooks/owner-device.md` and `rws-wg-peer revoke <name>` |
| SSH keys of `ops` | `docs/runbooks/lost-ssh.md` |
| CDN and DNS logins, CDN purge token (D20) | the owner's password manager; `docs/runbooks/cdn-break-glass.md` |
| `restic_password` | `docs/runbooks/restore.md` (a restic key change, restore-drill-checked) |

```bash
sudo stat -c '%n %a %U:%G' /etc/rws/secrets/*
sudo rws-wg-peer list
```

Expected: every secret file `440 root:<gid>` and only the owner's devices in the peer list.

## 2. Provider tokens not in that table

- **RWS `x-api-key`** (`rws_x_api_key`, C7): a new UUID in the file, tell RWS (their Servicedesk Data form, `docs/sources/SOURCE-CATALOGUE.md` Appendix A), then `sudo docker restart rws-capture-1`. Check: `curl -s https://<domain>/status/capture.json | jq -r '.specs[] | select(.spec | startswith("nl-1")) | "\(.spec) \(.last_success)"'` shows a new `last_success` within one cadence.
- **BE-1 and BE-2 credentials** (HIC and VMM, `off` until they arrive): no credential is stored anywhere yet. When they arrive they get a row in `docs/security/secrets.md` and a rotation step here first (TODO owner, with the source's flip to `owner`).
- **No other provider uses a key.** A request that fails with 401 or 403 is a block or a changed licence, not a token: `docs/runbooks/provider-outage.md` §2.

## 3. After any rotation

```bash
scripts/verify-prod.sh <domain>
scripts/verify-owner.sh <domain> --cacert owner-root.crt
```

Expected: green (the owner script from an owner device with the tunnel up). Record the date in the drill record (`docs/runbooks/secrets-rotation.md` §6).
