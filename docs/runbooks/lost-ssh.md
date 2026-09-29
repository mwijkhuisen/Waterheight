# Runbook: SSH access lost

SSH is keys-only, `AllowUsers ops` and no root login (`/etc/ssh/sshd_config.d/10-rws.conf`), and nftables allows at most 6 new connections a minute per source address. The **provider console** is the break-glass path (A3). Test it before you need it.

## 1. Rule out the rate limit

Wait one minute and connect once: `ssh -v ops@<domain>`. `Connection timed out` after many attempts means the limit; `Permission denied (publickey)` means keys.

## 2. From the provider console (log in as root with the console password)

```bash
systemctl status ssh
sshd -t                                   # the config parses?
cat /home/ops/.ssh/authorized_keys        # your key present?
nft list chain inet rws input             # 22 still accepted?
journalctl -u ssh -n 50
```

| Cause | Fix |
|---|---|
| Key lost or rotated | Add the new public key to `/home/ops/.ssh/authorized_keys` (`0600`, owned by `ops`) |
| sshd config broken | `rm /etc/ssh/sshd_config.d/10-rws.conf && systemctl restart ssh`, get in, then re-run `bootstrap.sh` from the current release directory |
| Firewall | `systemctl stop rws-firewall` (removes only `table inet rws`), get in, then `systemctl start rws-firewall` |

## 3. If the console is gone too

Restore the provider's last snapshot, or rebuild (`docs/runbooks/restore.md`). The raw archive is safe in the bucket.

Never add a second person's key: the VPS carries owner-audience data (invariant 11).
