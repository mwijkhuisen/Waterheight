# Security policy

## Reporting a vulnerability

Please report security problems **privately**, never in a public issue, pull request or discussion.

- Use GitHub's private vulnerability reporting: the **Security** tab of this repository → **Report a vulnerability** (`https://github.com/mwijkhuisen/Waterheight/security/advisories/new`).
- Once the project's domain exists (decision D2), `security@<domain>` and a `security.txt` (P12) are a second channel. `<domain>` is a placeholder until then.
- If the **Report a vulnerability** button is not available yet (it is switched on with the repository settings, owner action B1), open an issue titled "Security contact request" **with no details at all**; the owner will reply with a private channel.

Include what you found, where (file and line, URL or workflow), how to reproduce it and the impact you expect. Do not include real personal data or secrets; describe them instead.

## What to expect

This is a one-person, non-commercial project. The owner aims to acknowledge a report within 7 days and to agree on a disclosure date with you. There is no bug bounty.

## Scope

In scope: this repository (code, CI workflows, the SessionStart hook, scripts, the registry) and, once they exist, the public site and its API. Especially welcome: anything that could expose **owner-audience data** (invariant 11 in `CLAUDE.md`), leak a secret, or let a pull request or a dependency gain write access.

Out of scope: the data providers' own services (report to them), denial of service by volume, and findings that need physical access to the owner's devices.
