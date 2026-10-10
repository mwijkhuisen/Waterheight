# Runbook: an owner device (WireGuard), add and revoke

The owner site (`https://owner.<domain>`) is reachable only through WireGuard, from the owner's own devices (ADR-0017, A§11.5). **Owner only: no second user, no peer for anyone else.** Each device is one peer, `10.66.0.N/32`, whose config allows only `10.66.0.1/32` (a split tunnel: the rest of the device's traffic does not go through the VPS). `rws-wg-peer` is on the VPS (root).

## Prerequisites (once)

- `sudo /usr/local/lib/rws/deploy/host/bootstrap.sh` has run from a release with P12a: it installs `wireguard-tools`, makes `/etc/wireguard/wg0.key` (root `0600`, never printed) and starts `wg-quick@wg0`.
- `RWS_OWNER_SITE=on` is in `/etc/rws/rws.env` and `/etc/rws/secrets/owner_basic_auth` holds `owner <bcrypt hash>` (docs/runbooks/owner-password-rotation.md); the next `rws-deploy` brings up caddy-owner on `10.66.0.1:443`. See `docs/runbooks/owner-exposure.md`.

## Add a device

Run it from the device, so the config never rests on the VPS:

```bash
umask 077
ssh ops@<vps> 'sudo rws-wg-peer add laptop' > laptop.conf
```

- The name is `[a-z][a-z0-9-]{0,30}`. The client config (with the device's private key and a preshared key) is printed **once** on stdout; the private key is not stored on the VPS, not logged and not in argv. Lost config = revoke and add again.
- Import `laptop.conf` into the WireGuard app (or `sudo wg-quick up ./laptop.conf`). Delete the file afterwards if the app keeps its own copy.
- Make the name resolve to the tunnel address. There is **no public DNS record** for `owner.<domain>` (criterion 10): add `10.66.0.1 owner.<domain>` to the hosts file (`/etc/hosts`; on Windows `C:\Windows\System32\drivers\etc\hosts`).
- Trust the site's own CA (`tls internal`; the certificate is not publicly trusted):

```bash
ssh ops@<vps> 'sudo docker exec rws-caddy-owner-1 cat /data/caddy/pki/authorities/local/root.crt' > owner-root.crt
```

  Import `owner-root.crt` as a trusted root in the device's OS or browser store, or pass it to curl (`--cacert owner-root.crt`) and to `scripts/verify-owner.sh --cacert`. Check the fingerprint against the VPS (`openssl x509 -in owner-root.crt -noout -fingerprint -sha256` on both) once. The CA lives in the `caddy_owner_data` volume: it survives restarts and deploys; a restore from backup makes a new one (re-export).
- Open `https://owner.<domain>`; the browser asks for the owner password.

## List and revoke

```bash
sudo rws-wg-peer list            # name, address, last handshake, public key
sudo rws-wg-peer revoke laptop   # out of /etc/wireguard/wg0.peers.conf and out of the running wg0 at once
sudo wg show wg0                 # only your own devices may be listed
```

A lost or stolen device: revoke it first, then rotate the owner password (docs/runbooks/owner-password-rotation.md), because the device may hold the saved password.

## Where things are

| File | What |
|---|---|
| `/etc/wireguard/wg0.conf` | the interface (from `deploy/host/wireguard/wg0.conf.template`; no key, replaced by bootstrap) |
| `/etc/wireguard/wg0.key` | the server key (root `0600`) |
| `/etc/wireguard/wg0.peers.conf` | the peers (root `0600`; only `rws-wg-peer` writes it; bootstrap never touches it) |

The endpoint in a client config is `RWS_PUBLIC_IPV4` from `rws.env`, UDP `51820` (open in `deploy/host/nftables.conf`). Rotating the server key: `sudo rm /etc/wireguard/wg0.key`, run bootstrap, `sudo systemctl restart wg-quick@wg0`, and re-add every device (their configs hold the old server public key).
