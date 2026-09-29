# Permission tracker (C1–C13)

Owner actions C1–C13 of issue #14 (PHASES §6.2 C). The e-mail drafts are in [`docs/legal/requests/`](legal/requests/README.md). **Every request asks** whether (a) machine-readable redistribution through our public API and exports is allowed and (b) we may keep and republish a history archive (catalogue §0.2, §0.7).

How to use it: when you send an e-mail, fill in *Sent* and a *Go/no-go* date (the date after which the fallback ships, catalogue §0.2). When an answer arrives, fill in *Answered*, *Outcome*, *Conditions* and the *Channels granted* (`display`, `api`, `bulk_export`, `history_export`; channels a permission does not name stay off). A grant becomes `registry/permissions/<ID>.md` in a P13 PR (P12 for DE-2), which CI requires before an audience or channel changes. Keep the original e-mails in your own mail archive, never in this public repository, and write no names or addresses of provider staff here.

## Requests

| # | Provider · source IDs | Contact | Draft | Kind | Sent | Answered | Outcome · conditions | Audience now → on grant | Channels granted | Go/no-go | Reminder |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | HIC · BE-1 | hic@vlaanderen.be | [c1-hic](legal/requests/c1-hic.md) | TYPE-3 credentials + User Agreement for a **personal, non-commercial, private viewer**; optional question on public display | – | – | – | `off` → `owner` (public only if the agreement allows) | – | set when sent | +10 working days |
| C2 | VMM · BE-2 | hydrometrie@waterinfo.be | [c2-vmm](legal/requests/c2-vmm.md) | API token for a **personal, non-commercial, private viewer**; optional public display under the Modellicentie | – | – | – | `off` → `owner` (public once the token terms allow) | – | set when sent | +10 working days |
| C3 | SPW · BE-3 | hydrometrie@spw.wallonie.be | [c3-spw](legal/requests/c3-spw.md) | **Optional**: public display only | – or "deferred" | – | – | `owner` → `public` | – | none (optional) | – |
| C4 | AGE · LU-2, LU-3, LU-4, LU-7 (+ LU-1 third-party gauges) | hydrometrie@eau.etat.lu; Service de la navigation (address not researched) | [c4-age](legal/requests/c4-age.md) | **Optional**: public display only; CC0 scope of the LU-1 third-party and LfU RLP-origin series | – or "deferred" | – | – | LU-2/3/4 `owner` → `public`; LfU RLP-origin series `off` until C4 or C11 | – | none (optional) | – |
| C5 | NLWKN · DE-9 | HWVZ@nlwkn.niedersachsen.de | [c5-nlwkn](legal/requests/c5-nlwkn.md) | Written permission to store and publicly display | – | – | – | `off` → `public` | – | set when sent | +10 working days |
| C6 | BfG · DE-2, DE-3 | vorhersage@bafg.de | [c6-bfg](legal/requests/c6-bfg.md) | Credit wording, `WV` licence, flood behaviour; Belegexemplar at launch (E1) | – | – | – | `owner` → DE-2 `public` after E1 (P12); DE-3 per D4 (P13) | – | launch gate (P12) | +10 working days |
| C7 | RWS · NL-1 (NL-2, NL-4) | "Servicedesk Data" form on rijkswaterstaatdata.nl; GitHub Discussions (without the `X-API-KEY` value) | [c7-rws](legal/requests/c7-rws.md) | Courtesy notice + questions (CTD hosts, forecasts, NL-4, `kanne`) | – | – | – | `public` (unchanged) | – | before 2026-10-02 | – |
| C8 | ITZBund / WSV · DE-1, DE-5 | contact on pegelonline.wsv.de (not researched) | [c8-itzbund-wsv](legal/requests/c8-itzbund-wsv.md) | Courtesy notice; `WV` and mirror licence; DE-5 scripting | – | – | – | DE-1 `public`; DE-5 `off` (P14) | – | – | – |
| C9 | BAFU · CH-1…CH-8 | abfragezentrale@bafu.admin.ch; hydrologie@bafu.admin.ch | [c9-c13-bafu](legal/requests/c9-c13-bafu.md) | Courtesy notice; `threshold_customer`; CH-8 history order | – | – | – | CH-1…CH-5 `public`; CH-8 `off` (P14) | – | – | – |
| C10 | Backlog: HLNUG (DE-11), LfU Bayern (DE-13), Dutch water boards (NL-5, NL-6) | not researched | [c10-backlog](legal/requests/c10-backlog.md) | After launch | – | – | – | `off` | – | – | – |
| C11 | LfU Rheinland-Pfalz · DE-10 (+ LfU RLP-origin LU series) | poststelle@lfu.rlp.de | [c11-lfu-rlp](legal/requests/c11-lfu-rlp.md) | Consent to capture, store and publicly display (66 forecast gauges, 46 alert regions, W/Q) | – | – | – | `off` → `public` | – | set when sent | +10 working days |
| C12 | LUBW · DE-12 | Pegelinfo@lubw.bwl.de | [c12-lubw](legal/requests/c12-lubw.md) | Consent (Murg, Kinzig) | – | – | – | `off` → `public` | – | set when sent | +10 working days |
| C13 | BAFU hydrodaten · CH-2, CH-4, CH-5 | abfragezentrale@bafu.admin.ch (in the C9 e-mail) | [c9-c13-bafu](legal/requests/c9-c13-bafu.md) | Polling permission and interval; silence keeps them public | – | – | – | `public`; → `owner` if BAFU objects to public use; capture stops only if asked | – | **2026-10-31** (P7: CH-2, CH-5) and **2026-11-06** (P8: CH-4) | +10 working days |

Also optional, not in §6.2: the LANUK NRW courtesy notice ([optional-lanuk](legal/requests/optional-lanuk.md)). Launch e-mails: [E1 BfG Belegexemplar](legal/requests/e1-bfg-belegexemplar.md) and [E2 go-live notice](legal/requests/e2-go-live.md).

## Owner-audience sources and their `private_basis`

The clause, URL and retrieval date are copied verbatim into `registry/sources.yaml` (catalogue §0.8; the registry test compares them).

| Source | Terms | Retrieved | Public only with |
|---|---|---|---|
| BE-3 SPW | https://hydrometrie.wallonie.be/mentions-legales.html (+ Metawal CGU) | 2026-09-23 | SPW's prior written consent (C3) |
| LU-2, LU-3, LU-4 AGE | https://inondations.public.lu/fr/support/aspects-legaux.html | 2026-09-23 | AGE's written authorisation (C4) |
| DE-2, DE-3 BfG | https://6wochenvorhersage.bafg.de/ | 2026-09-23 | DE-2: the Belegexemplar (E1, P12); DE-3: decision D4 (P13) |
