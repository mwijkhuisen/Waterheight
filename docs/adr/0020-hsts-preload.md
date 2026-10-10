# ADR-0020: HSTS preload is not requested at launch

- **Status:** Accepted (2026-10-10; decision D17, `docs/plan/PHASES.md` §6.1)
- **Date:** 2026-10-10
- **Revisit:** about three months after the go-public switch (P12b), as a new ADR that supersedes this one or a line appended here.

## Context

Both sites send `Strict-Transport-Security: max-age=31536000; includeSubDomains` (A§9.1; `deploy/web/site.caddy` and `deploy/web/owner.caddy`, pinned by the header tests). The `preload` token and a submission to the browsers' preload list would make every browser refuse plain HTTP for the domain and all its subdomains before it has ever seen the site. D17 left the decision to P12. It is a one-way door in practice: a listed domain leaves the browser lists only through a removal request and the release cycle of each browser, which takes months, and a name on the list cannot be served over plain HTTP in the meantime.

## Decision

- **Not at launch.** The header stays `max-age=31536000; includeSubDomains` without `preload`. No Caddy, header or test change.
- **Revisit about three months after go-public**, with the evidence below. The owner decides; an agent never submits a domain.

## What preload would require (checklist for the revisit)

1. The header on the apex answer (the HTTPS answer of the exact domain) reads `max-age` of at least 31536000 (one year), `includeSubDomains` and `preload`, on every HTTPS answer of the site, error answers included (the `handle_errors` blocks carry it already).
2. Plain HTTP on the apex redirects to HTTPS on the same host first (Caddy does this by default), and every subdomain that exists or will exist is HTTPS-only with a valid certificate. The listing covers **every** subdomain, so a later HTTP-only host (a status page, a test host, a printer) is no longer possible.
3. The owner site `owner.<domain>` has no public DNS record and is reachable only over WireGuard with `tls internal` (ADR-0017). The listing would cover that name too. It is HTTPS-only already, and a browser that trusts the exported root CA is unaffected, but a device without the root CA could no longer click through the certificate warning. The owner accepts that, or the revisit moves the owner site to a different registered domain first. Check this before submitting.
4. No certificate trouble in the three months: no failed ACME renewal, no `cert` check (healthchecks) alert, CAA records in place (`CAA 0 issue "letsencrypt.org"`, plus the CDN's CA if D20 is armed; `docs/runbooks/cdn-break-glass.md`).
5. The owner has read the removal procedure and accepts the delay (months) if the domain or its hosting ever changes.
6. Submission is on the preload list's own web form by the owner, with a note in `docs/known-gaps.md` and the Caddy files and header tests changed in one reviewed PR (`preload` added at the same time).

## Consequences

- Visitors get HSTS from their second visit, not from the first. The window is the first visit over an untrusted network; HTTP on port 80 redirects at once, and the site carries nothing a visitor must keep secret (no accounts on the public site, no cookies).
- Nothing in the code base depends on the preload state.
- The decision costs nothing to reverse in this direction: adding `preload` later is one header change plus the submission.
