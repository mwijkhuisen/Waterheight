# Launch checklist (E4)

The owner signs this page before the public launch (PHASES §6.2 E4, issue #27 P12b). **It ships unsigned**: no box below is ticked, no date and no signature is filled in, and an agent never ticks one. The owner ticks a box after doing the check themselves and signs each section; the last section is the go/no-go for the launch commit, the one reviewed change that moves `RWS_SITE_PHASE` in `deploy/compose.yaml` from `prelaunch` to `launch` (`deploy/web/phase-launch.caddy`: pages indexable, `robots.txt` and `sitemap.xml`).

How to read it: **[CI]** items are proven by an offline test, **[owner]** items need your access or judgement. Output that names owner sources or devices (`scripts/verify-owner.sh`, `wg show`) stays in your private notes: post only counts (review SR-5). Nothing in this page may hold an owner-audience value (invariant 11).

Machine-checked by `test/launch-checklist.test.ts`: tables (a) and (c) below equal the registry, so they fail CI until they are updated in the same commit as a registry change (the DE-2 flip is one).

## 1. Licences and attribution

### (a) Public sources: licence, attribution and channels

`D/A/B/H` = display, api, bulk_export, history_export (catalogue §0.7); `-` = off. The attribution is the primary text of the source's registry row, verbatim from catalogue §1b. The language variants (CH-1 to CH-5) are checked against §1b by `packages/contracts/test/registry.test.ts`. A bracketed or parenthesised date in the text is filled in from the source's last update or retrieval at publish time (`sources.json`, `status.json`). FR-3, FR-4 and FR-5 carry no logo (Vigicrues forbids it), and no public attribution text mentions one.

| ID | Licence | Attribution (§1b, primary text) | D/A/B/H |
|---|---|---|---|
| NL-1 | cc0 | Waterstanden en afvoeren: Rijkswaterstaat – WaterWebservices (CC0), https://rijkswaterstaatdata.nl/waterdata/ | DABH |
| NL-2 | cc0 | Waterstanden en afvoeren: Rijkswaterstaat – WaterWebservices (CC0), https://rijkswaterstaatdata.nl/waterdata/ | DABH |
| NL-4 | cc0 | Waterstanden en afvoeren: Rijkswaterstaat – WaterWebservices (CC0), https://rijkswaterstaatdata.nl/waterdata/ | DABH |
| DE-1 | dl-de-zero-2.0 | Pegeldaten: WSV/GDWS via PEGELONLINE (pegelonline.wsv.de), Datenlizenz Deutschland – Zero – Version 2.0 (https://www.govdata.de/dl-de/zero-2-0). Ungeprüfte Rohdaten. | DABH |
| DE-6 | cc-by | Datenquelle: www.hochwasserzentralen.de | DABH |
| DE-7 | dl-de-zero-2.0 | Datenquelle: LANUK NRW, Hochwasserportal.NRW | DABH |
| DE-8 | dl-de-zero-2.0 | Datenquelle: LANUK NRW, Hochwasserportal.NRW | DABH |
| FR-1 | etalab-2.0 | Données hydrométriques : Hub'Eau / SCV – réseau Vigicrues (PHyC), Licence Ouverte Etalab 2.0 – https://hubeau.eaufrance.fr/page/api-hydrometrie | DABH |
| FR-3 | etalab-2.0 | Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0 | DABH |
| FR-4 | etalab-2.0 | Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0 | DABH |
| FR-5 | etalab-2.0 | Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0 | DABH |
| LU-1 | cc0 | Source: Administration de la gestion de l'eau (AGE), Luxembourg – inondations.lu; Moselle stations: Service de la navigation | DABH |
| LU-5 | cc-by | LU-Alert | DABH |
| LU-6 | cc0 | Source: Administration de la gestion de l'eau (AGE), Luxembourg – inondations.lu; Moselle stations: Service de la navigation | DABH |
| CH-1 | ch-open-use | Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum) | DABH |
| CH-2 | ch-open-use | Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum) | DABH |
| CH-3 | ch-open-use | Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum) | DABH |
| CH-4 | ch-open-use | Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum) | DABH |
| CH-5 | ch-open-use | Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum) | DABH |

### (b) Permission tracker C1 to C13

The tracker is [`docs/permissions.md`](permissions.md) (one table, kept there; none is repeated here). The registry state a silent or an objecting provider leads to is tested in `test/launch-checklist.test.ts`: with no objection CH-1 to CH-5 stay public; if BAFU objects to public use (C13), CH-2, CH-4 and CH-5 become `owner` with a permission record and CH-1 stays public; DE-9, DE-10, DE-12, DE-13, BE-1 and BE-2 stay `off`; LU-1 keeps Bollendorf and Gemünd withheld (`registry/permissions/LU-1.md`).

### (c) Owner-audience sources: `private_basis`

The owner view is used by the owner alone and is never shared. Each owner source cites its catalogue §0.8 row; the test requires a retrieval date at most 12 months before 2026-12-04. Clause, URL and date are in `registry/sources.yaml`; this page repeats no clause text.

| ID | §0.8 clause | `private_basis` retrieved |
|---|---|---|
| DE-2 | §0.8 DE-2 / DE-3 BfG forecasts | 2026-09-23 |
| DE-3 | §0.8 DE-2 / DE-3 BfG forecasts | 2026-09-23 |
| BE-3 | §0.8 BE-3 SPW Wallonia | 2026-09-23 |
| LU-2 | §0.8 LU-2 / LU-3 / LU-4 AGE Luxembourg | 2026-09-23 |
| LU-3 | §0.8 LU-2 / LU-3 / LU-4 AGE Luxembourg | 2026-09-23 |
| LU-4 | §0.8 LU-2 / LU-3 / LU-4 AGE Luxembourg | 2026-09-23 |

### Checks

- [ ] [CI] `pnpm check` and `pnpm test` are green on the launch commit's parent (tables (a) and (c) equal the registry; no channel is wider than its licence default or its permission record).
- [ ] [owner] I read table (a) against the live credits on `sources.json` (both languages) and found no source credited wrongly or missing.
- [ ] [owner] Every `owner` source in table (c) stays out of the public site (invariant 11): `scripts/verify-prod.sh <domain> --profile prelaunch` shows no `owner` FAIL.

Signed (owner): ______________________  Date: ____-__-__

## 2. Permissions, notices and legal pages

- [ ] [owner] C1 to C13 answered, or past their go/no-go date with the fallback of [`docs/permissions.md`](permissions.md) applied and recorded there (C13: 2026-10-31 for CH-2 and CH-5, 2026-11-06 for CH-4). **The test of the fallbacks is date-blind:** `test/launch-checklist.test.ts` proves which registry state each outcome leads to, not that a date has passed or that you applied it. For every go/no-go decision, set the registry yourself (permission records, `audience` and channel flags) and run `pnpm check` before you sign; nothing fails on its own when you forget.
- [ ] [owner] **E1**: the BfG Belegexemplar is sent ([`e1-bfg-belegexemplar`](legal/requests/e1-bfg-belegexemplar.md)) and `registry/permissions/DE-2.md` is recorded from `registry/permissions/DE-2.md.template`. DE-2 stays `owner` until that record exists (the gate in `packages/contracts/src/registry.ts`: `GATED` plus every source whose baseline licence kind is not open; a record whose text fields still say TODO is refused); leave this box open to launch with DE-2 as an owner source. **At the flip, the DE-2 runs captured in the owner period become public history**, within the `history_export` channel the record grants; the flip PR says so.
- [ ] [owner] **E2**: the go-live notice is sent to RWS, ITZBund and BAFU ([`e2-go-live`](legal/requests/e2-go-live.md)); date: ____-__-__.
- [ ] [owner] **E5**: the disclaimer, colophon (operator name and contact) and privacy notice are approved in NL and EN, and the privacy notice matches the logging configuration (`test/privacy-policy.test.ts` holds the numbers to `deploy/web/site.caddy`). Approved on: ____-__-__. Text changes are owner work.
- [ ] [owner] `RWS_OPERATOR_NAME` and `RWS_CONTACT_EMAIL` are set in `/etc/rws/rws.env` (the colophon and `verify-prod` `runtime config` PASS).

Signed (owner): ______________________  Date: ____-__-__

## 3. Flood readiness

- [ ] [CI] The flood drill passed: `scripts/flood-drill` runs in the compose end-to-end stack (`RWS_E2E_MODE=drill`, `deploy/tests/flood/run.sh`, `.github/workflows/loadtest.yml`); it is CI only and refuses anything else. Run: ______________.
- [ ] [owner] The egress budget in [`docs/capacity.md`](capacity.md) has the owner inputs filled in (`inputs` of `docs/capacity-egress.json`: uplink and monthly quota from the plan ordered in A3), and the flood-day peak is judged against D20.
- [ ] [owner] The production k6 run passed: `.github/workflows/loadtest.yml`, `workflow_dispatch` with mode `production` (the `production` environment, your approval; static-only burst against `vars.LOADTEST_TARGET`). From one runner it may hold 32 connections to 443 (#132, KG-337): dropped iterations mean the runner's distance, not the site. Run: ______________.
- [ ] [owner] The brownout and the CDN break-glass are read and understood: [`brownout`](runbooks/brownout.md), [`cdn-break-glass`](runbooks/cdn-break-glass.md) (pre-written, not armed).

Signed (owner): ______________________  Date: ____-__-__

## 4. Security

- [ ] [owner] [`docs/security/launch-verdict.md`](security/launch-verdict.md) is filled in by the security review and shows no open High or Critical finding. (Round 1: SR-1 and SR-7 below are open launch preconditions, owner actions.)
- [ ] [owner] **SR-1**: `scripts/gh-settings.sh --check` prints no drift: rulesets, branch protection with `ci` and `security` required, secret scanning with push protection, and the `production` environment with its reviewers. On 2026-10-11 the agent's read-only check reported drift (no ruleset, no branch protection, scanning off, no reviewers); that may be a token without admin rights, so confirm with an admin token and run `scripts/gh-settings.sh` until the check is clean. KG-025, R-002, KG-333.
- [ ] [owner] **SR-7**: the web image runs Caddy 2.11.7 or newer (issue #131, after the 7-day release-age rule) and the Grype scan was run again on the release you launch; R-095's accepted findings expire 2026-11-10. KG-334.
- [ ] [owner] **CAA**: the zone's `CAA` record allows `letsencrypt.org` only (read it with `dig CAA <domain>`; no tooling checks it). KG-335.
- [ ] [owner] `sudo deploy/tests/hardening.sh --prod` passes on the VPS (every container hardened; only `caddy` and `caddy-owner` publish ports).
- [ ] [owner] `scripts/verify-owner.sh <domain>` (on an owner device, tunnel up) shows no FAIL. Post only the PASS and FAIL counts; the output stays in your private notes.
- [ ] [owner] `sudo wg show wg0` lists exactly your own device(s) and no other peer. Paste it into your private notes only (it names devices and endpoint addresses).
- [ ] [agent-prod] The owner site is reachable over WireGuard only: `scripts/verify-prod.sh <domain>` check `owner listener` PASS (TCP 443 with SNI `owner.<domain>` fails or answers 421, TCP 8443 closed, no public DNS record for `owner.<domain>`).
- [ ] [owner] [`docs/security/secrets.md`](security/secrets.md) is current: no secret in the repository, logs or the manifest; token rotation dates noted in your password manager ([`token-rotation`](runbooks/token-rotation.md)).

Signed (owner): ______________________  Date: ____-__-__

## 5. Operations

- [ ] [owner] **Restore drill**: `sudo rws-restore-drill --force` restores the raw sample and the database dump into a throw-away database and replays a settled day, and passes (`/status/ops.json` shows the drill). At: ____-__-__ __:__ UTC. Runbook: [`restore`](runbooks/restore.md).
- [ ] [owner] **E3**: the timed rebuild drill on a temporary VPS is done ([`vps-rebuild`](runbooks/vps-rebuild.md)): `sudo deploy/tests/rebuild-check.sh <drill hostname> --production <production domain>` shows no FAIL and its `bucket key` row is PASS (not SKIP), the timing sheet is filled in from your clock ([`docs/drills/rebuild-timing-sheet.md`](drills/rebuild-timing-sheet.md), copied to `docs/drills/rebuild-<date>.md`), the total is at most 240 minutes with 0 Q7 gaps in the judged sources, and the temporary VPS is deleted. Date: ____-__-__.
- [ ] [owner] **All 18 checks are up** on the healthchecks.io dashboard, before the alert drill and again before you sign. The export of 2026-10-11 showed eight checks without a success ping and three down flips each on `watchdog`, `cert` and `disk`, which may be standing alerts, and unexplained down flips on `cap-fr` (18) and `update` (14); write the cause of each in the issue ([`docs/ops/alert-tuning.md`](ops/alert-tuning.md), KG-321).
- [ ] [owner] **Alert drill**: run only when the dashboard is all green (the restoring ping would hide a real outage of the same check). `sudo deploy/tests/alert-drill.sh` was run, and every healthchecks.io alert in its receipt table reached you (last column filled in). The grace values stand as in [`docs/ops/alert-tuning.md`](ops/alert-tuning.md). Date: ____-__-__.
- [ ] [owner] The runbooks for a provider outage, a DST check and a VPS rebuild exist and were read ([`provider-outage`](runbooks/provider-outage.md), [`dst-check`](runbooks/dst-check.md), [`vps-rebuild`](runbooks/vps-rebuild.md)).

Signed (owner): ______________________  Date: ____-__-__

## 6. The public site, before and after the switch

- [ ] [agent-prod] Before the switch: `scripts/verify-prod.sh <domain> --profile prelaunch` is all PASS (noindex everywhere, no `robots.txt` or sitemap, no owner source named).
- [ ] [owner] The launch commit is reviewed and merged (the one change of the `RWS_SITE_PHASE` default; production's `rws.env` never sets it, while the rebuild drill's pins `prelaunch`: [`vps-rebuild`](runbooks/vps-rebuild.md) §4) and deployed: `sudo rws-deploy "$(sudo cat /var/lib/rws/current)"`.
- [ ] [agent-prod] After the switch: `scripts/verify-prod.sh <domain> --profile launch` is all PASS (pages without `X-Robots-Tag`; `/api`, `/data`, `/status/`, `/tiles` and the 404 shells still `noindex`; `robots.txt`, the sitemap and the Open Graph image in place; `robots.txt`, the sitemap, `sources.json` and `status.json` name no owner source or host).
- [ ] [owner] No CDN is armed: `https://<domain>/runtime-config.json` shows `"cdn":""`, and the privacy page says so (D20, [`cdn-break-glass`](runbooks/cdn-break-glass.md)).

Signed (owner): ______________________  Date: ____-__-__

## 7. Sign-off (E4)

- [ ] Sections 1 to 6 are signed. Any box left open is written below with the reason and the date I accept it.

Open boxes accepted: ______________________________________________

I approve the public launch of this site.

Owner: ______________________  Date: ____-__-__
