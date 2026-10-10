# Runbook: rotate the owner site password

The owner site is behind `basic_auth` at the site level (`deploy/web/owner.caddy`). The credential is one line, `owner <bcrypt hash>`, in the Docker secret file `/etc/rws/secrets/owner_basic_auth` (root, group `61010`, `0440`). Rotate it when a device is lost or stolen, when the password was typed somewhere it should not be, and about once a year. Owner only.

## Rotate

On the VPS (as `ops`, with sudo). The web image is the running one; the new password is typed at the prompt and never appears in argv or in the shell history:

```bash
img=$(sudo docker inspect -f '{{.Config.Image}}' rws-caddy-owner-1)
read -r -s -p 'new owner password: ' pw; echo
hash=$(printf '%s\n' "$pw" | sudo docker run -i --rm --entrypoint caddy "$img" hash-password)
unset pw
printf 'owner %s\n' "$hash" | sudo tee /etc/rws/secrets/owner_basic_auth.new >/dev/null
sudo chown 0:61010 /etc/rws/secrets/owner_basic_auth.new && sudo chmod 0440 /etc/rws/secrets/owner_basic_auth.new
sudo mv -f /etc/rws/secrets/owner_basic_auth.new /etc/rws/secrets/owner_basic_auth
sudo docker restart rws-caddy-owner-1
```

Use a long random password from the password manager (20+ characters; no `"` or `\`, which `scripts/verify-owner.sh` refuses). The mount is a single-file bind: the replaced file is seen only after the restart (`mv` swaps the inode), which is why the container restarts. A wrong file makes caddy-owner refuse to start (it fails closed; the public site is unaffected).

## Check

From an owner device with the tunnel up: `scripts/verify-owner.sh <domain> --cacert owner-root.crt` (it prompts for the new password). The old password must now answer 401: `curl --resolve owner.<domain>:443:10.66.0.1 -u owner --cacert owner-root.crt https://owner.<domain>/` and type the old one.

Record the rotation date in the password manager entry. Also see `docs/runbooks/secrets-rotation.md` for the other secrets.
