# Source catalogue: river water levels flowing into the Netherlands

**Status:** authoritative synthesis, compiled 2026-09-23. It merges 11 independent research reports. Each report was checked live between about 19:50 and 20:45 UTC on 2026-09-23. Planning, issue writing and implementing agents should cite this file rather than the individual reports.

**Revision, 2026-09-23 (about 21:15–22:15 UTC):** a gap check worked through `plan/CATALOGUE-GAPS.md` items 1–8, and parts of items 12, 13, 14 and 20, with new live calls. The raw evidence is in `scratchpad/gapcheck/`. Changed or new: §0.1 (rewritten, with §0.1a first slice and §0.1b day-0 harvest), §0.2, new §0.4 (flood states and fixtures), §0.5 (forecast coverage and the EFAS/GloFAS decision), §0.6 (Belgium without permissions), §0.7 (licence flags for our API), rows NL-4, DE-2, DE-6, DE-7, DE-10 and FR-5 in §1, §2.1 (NL-4 parser specification, CTD), §2.2, §2.3, §2.5, §2.6, §2.7, §4.1 (French datum check), §4.6, §4.7, new §4.9 (class crosswalk), §6.5, §6.7, §8 (C36–C45), §9, Appendix A, and the new **§10 Remaining open items**. The pre-revision file is kept as `plan/SOURCE-CATALOGUE.before-gapcheck.md`.

**Revision, 2026-09-24:** new **§0.8 Private (owner-only) use**, the per-source verdict behind the plan's hybrid audience (decision D22), with short owner-audience notes in §0.1a, §0.1b, §0.2 and §0.5. The AGE, SPW, BAFU, BfG, VMM and HIC clauses come from the research reports; the NLWKN, LfU RLP and LUBW Impressum pages were re-fetched on 2026-09-24.

**Revision, 2026-09-29 (P1a build check):** DE-7 `…/data/internet/layers/10/index.json` answers 404 (the thresholds are in `pegeldaten.zip` → `pegel_stationen.txt`); the BfG 14-day index is `https://vorhersage.bafg.de/14-Tage-Vorhersage/index.html` (the directory URL answers 404); BAFU's `hydro_sensor_pq_forecast.geojson` lists 54 forecast stations; the LU-1 CSV has one row with one more value column than its header; the NL-4 xlsx has 14 members. See `plan/PHASES.md` §11.

**Inputs** (in `scratchpad/research/`): `nl-rws.md`, `de-pegelonline.md`, `de-states.md`, `be-flanders.md`, `be-wallonia-lu.md`, `lu.md`, `fr-hubeau-vigicrues.md`, `ch-bafu.md`, `datum-arch.md`, `map-rivers.md`, `stack-landscape.md`. Raw responses from the live calls are in `scratchpad/` (file names are listed at the end of each report).

**Legend**

| Mark | Meaning |
|---|---|
| **[V]** | Called live on 2026-09-23 by at least one report, and the result was checked. |
| **[D]** | Read in official documentation on 2026-09-23, but not exercised live. |
| **UNVERIFIED** | Comes from inference, a secondary source or general knowledge. Confirm it before relying on it. |
| **[synth]** | A judgement made in this catalogue (effort, release slot, ordering). It is not a research finding. |
| `NL-1`, `DE-1`, … | Source IDs. The rest of the plan uses them. |

**Product constraints this catalogue serves**
- Collect from go-live. Historical backfill is a later phase.
- The first release shows water level (H/W), discharge (Q) where published, official forecasts where published, and provider thresholds, alert levels and characteristic values.
- Countries from the start: NL, DE, BE (Flanders and Wallonia), FR, LU and CH.
- Hosting: one VPS running Docker Compose.

---

## 0. The essentials (read this first)

### 0.1 The data-loss clock: what is lost for good, and what can be refilled later

Every day without production ingestion costs data, but the streams are not equal. **Most observations can be refilled later**, through the API or by an order or form. **Forecast runs, alert and class states, threshold versions and the raw payloads as published at the time cannot be refilled.** Upstream overwrites them and nobody archives them for us. The first production slice therefore protects those streams first (§0.1a). (Revised 2026-09-23 after gap check item 1. The earlier version marked CH-1 as "Lost" and pointed to §6.2; the ingestion design is in §6.5.)

| Stream | What the live API retains | Recoverable later by | Lost for good unless we capture it | Evidence |
|---|---|---|---|---|
| NL-1 RWS observations (H, Q) | Decades; at most 160,000 values per request | **API** | – | [V] Lobith daily 1901, hourly 1990/1995 |
| NL-1 RWS forecasts (H 183, Q 13 locations) | One value per timestamp; no run or issue time | **Never** | Every run | [V] Nijmegen 2026-09-20 |
| NL-4 RWS class-boundary xlsx | Only the current edition. On 2026-09-23 the waterdata page still links only the 15-4-2026 file, although the file promises quarterly updates | Never (superseded editions are not listed) | Every superseded edition | [V] gapcheck |
| DE-1 PEGELONLINE W and Q | About **31 days** (`P31D`; `P60D` is truncated; older ranges return `[]`) | API up to 31 days. After that only the DE-5 raw-data form (since 2000), which needs ITZBund/WSV consent before scripting | – | [V] |
| DE-1 characteristic values and PNP (`validFrom`) | Current values only | Never | Every change | [V] "Only the current PNP is exposed" |
| DE-2 BfG `WV` forecast | Latest run only | Never | Every run | [V] |
| DE-6 LHP station classes and regional alerts | Current state only | Never (the Wayback Machine holds 3 sporadic `/data/alerts` captures) | Every state change | [V] |
| DE-7 NRW W | `messwerte.zip`: 7 days. **`pegeldaten.zip`: 2 months of 15-min W for 253 stations, plus 2 years of daily mean and daily max** | API up to 2 months; after about 3 months the DE-8 verified archive | Raw-as-published values after 2 months | **[V]** gapcheck: 10.1 MB zip, 128 MB unpacked, W from 2026-07-23T20:40+01:00 to 2026-09-23, daily means from 2024-09-24 |
| DE-9 NLWKN | 30 days | Unknown (wasserdaten.niedersachsen.de is UNVERIFIED) | Everything after 30 days | [V] |
| DE-10 RLP W and Q | 48 h (index) and 5 days (per site); the CSV holds 90 days plus 3 years of daily values | CSV up to 90 days (needs permission) | – | [V] |
| DE-10 RLP forecasts (66 gauges) and 46 alert regions | Latest run and current class only | Never | Every run and state | [V] gapcheck |
| DE-11 HLNUG | 7 days at 15 min; daily values since about 1995 | API (daily only after 7 days) | 15-min detail after 7 days | [V] |
| FR-1 Hub'Eau `observations_tr` | **1 month** | API up to 1 month; FR-3 Vigicrues up to about 66 days; FR-2 daily aggregates; FR-6 exports (UNVERIFIED) | Sub-daily detail after about 66 days | [V] |
| FR-4 Vigicrues forecasts | Current run, only during events (**correction** 2026-10-01 (#39): the national list is never empty (27–31 stations on 2026-09-29/10-01, none in A/B/D/E1–E3); NL-bound forecasts still only during events; FR-4 fetches only NL-bound stations) | Never | Every run | [V] |
| FR-5 Vigicrues `NivInfViCr` | Current state | Never (Wayback holds sporadic captures, one from 2023-12-11 with levels 2 and 3) | Every state | [V] gapcheck |
| BE-1/BE-2/BE-3 KiWIS observations | Decades | API (HIC and VMM with credentials; SPW with permission) | – | [V] |
| BE-1 HIC forecasts | Current run | Never | Every run | [V] |
| LU-1 CSV / LU-2 JSON | 5 days / 7 days (P5b: the LU-1 CSV holds 7 days since 2026-09-30) | API up to 5–7 days; after that the LU-7 validated archive (2002–2024) **by order** | Raw-as-published values after 7 days | [V] |
| LU-3 AGE forecasts | Latest run only | Never | Every run | [V] |
| LU-4 AGE thresholds | Current values only | Never | Every change | [V] |
| LU-5 LU-Alert CAP | Every file since 2025-06: **833 dumps, 30 MB** | **API** (data.public.lu keeps them) | – | [V] gapcheck |
| CH-1 LINDAS values | Latest only | CH-3 up to 40 days; after that **by order** (CH-8: 5- and 10-min data from 1974, free) | – | [V] |
| CH-1 `dangerLevel`, CH-5/CH-6 warning and class states | Current state | Never | Every state | [V] |
| CH-2 thresholds (`wl_1..wl_4`) and fault notices | Current values | Never | Every change | [V] |
| CH-4 BAFU forecasts | Current run only | Never (Wayback: a handful of files) | Every run | [V] |

#### 0.1a First production slice: a raw archiver for the unrecoverable streams [synth]

Before any schema or UI exists, run a small collector that fetches these payloads, deduplicates them by sha256, compresses them with zstd and stores them. Parsing can follow later; this archive will be the product's only source for these streams. None of them needs a permission request. The exceptions are BfG `WV`, whose terms require accepting the credit and the Belegexemplar, and CH-2, CH-4 and CH-5, which are BAFU website internals (see §10 R5).

| Stream | Endpoint | Interval | Change gate |
|---|---|---|---|
| NL-1 forecasts | `OphalenWaarnemingen` with `ProcesType: verwachting`, WATHTE (183) and Q (13) | Hourly | Body hash |
| DE-2 `WV` | `…/stations/{uuid}/WV/measurements.json` × 7 | Hourly | `initialized` |
| DE-6 LHP | `/data/stations?format=json` (all states, 616 KB) and `/data/alerts` | 10 min (the terms ask for at least every 10 min when republishing) | `If-None-Match` → 304 works [V] |
| FR-4 forecasts | `v1.1/prevision.json?FormatDate=iso`, then per station | 15–30 min | Body hash |
| FR-5 vigilance | `InfoVigiCru.geojson` (2.2 MB; no ETag or Last-Modified) | 15 min | Store only when `DtHrInfoVigiCru` changes |
| LU-5 CAP | data.public.lu resource list | 5 min | New resource id |
| CH-1 LINDAS | SPARQL river and lake cubes | 10 min, never faster | Body hash |
| CH-2 | `hydro_sensor_pq.geojson` | 10 min | Body hash |
| CH-4 | 55 `q_forecast` files (`_de` only) | Hourly | `Last-Modified` plus run start |
| CH-5 | `hydro_warn_levels_de.geojson` | 30 min | Body hash |
| NL-4 | The xlsx and the link list on https://rijkswaterstaatdata.nl/waterdata/ | Weekly | Body hash; alert on a new file name |
| DE-1 metadata | `stations.json?includeTimeseries=true&includeCharacteristicValues=true` | Daily | Body hash |
| LU-1 CSV | The CC0 CSV | 15 min | Body hash (the raw values as published disappear after 5 days; P5b: 7 days since 2026-09-30) |

Add DE-10 RLP forecasts and alert regions on the day RLP gives permission (§0.2).

**Owner audience (§0.8, revision 2026-09-24):** LU-3 forecasts (55 percentile files of the 11 AGE-computed stations, hourly, content hash) and LU-4 thresholds (station pages, weekly, body hash) are unrecoverable too; they are captured from day one for the owner view and enabled first among the owner-audience specs. BE-3 SPW needs no slot here (KiWIS keeps decades).

#### 0.1b Day-0 harvest (first production run only)

On the first run, pull every rolling window once so the database starts with weeks of history rather than none:
- PEGELONLINE `measurements.json?start=P31D` for every curated W and Q series (31 days).
- Hub'Eau `observations_tr` for the whole month, paged by cursor (1 month).
- Vigicrues `observations.json` per curated French station, H and Q (about 66 days).
- NRW `pegeldaten.zip` (2 months of 15-min W, 2 years of daily values) **[V]**. After that, `messwerte.zip` or layer 10.
- CH-3 `p_q_40days` for the curated Swiss stations (40 days).
- LU-1 CSV (5 days; P5b: 7 days since 2026-09-30) and LU-2 JSON (7 days; owner audience from day one under the AGE personal-use terms, §0.8).
- LU-5: every CAP dump since 2025-06 (833 files, 30 MB). This includes real AGE flood alerts (§0.4).
- NLWKN 30 days, only if permitted.

### 0.2 Licence gates: act in Phase 0, before go-live

**Send every permission e-mail now, and keep a permission tracker** [synth]. Record for each source: date sent, date answered, conditions, and a go/no-go date after which the fallback ships. Every request must also ask, explicitly, whether (a) machine-readable redistribution through our public API and CSV export is allowed, and (b) we may keep and republish a history archive. Our API is itself redistribution (§0.7).

| Source | What blocks public reuse | Who to contact | Fallback if refused or slow |
|---|---|---|---|
| BE-1 HIC (Flemish navigable rivers and the tidal Scheldt) | Automated use is "TYPE 3". It needs credentials **and a User Agreement**. The English disclaimer says "non-commercial" and "personal use". HIC promises a first reply "within 5 working days". | hic@vlaanderen.be | The ungated Belgian set in §0.6: RWS's own CC0 points in Belgium (`antwerpen` with a forecast, `lixhebiefaval`, `maaseik` with H and Q forecasts, `lanaken` with a forecast, `kanne`, `smeermaas.zuidwillemsvaart`) plus NL-1 at the border and FR-1 upstream. **VMM is not a fallback: it is gated too.** |
| BE-2 VMM | A token is required for automated querying. The licence itself (Modellicentie) is fine. | hydrometrie@waterinfo.be | No ungated source covers the Kempen rivers that enter NL directly (Mark, Dommel, Warmbeek, Kleine Aa/Weerijs, Noordermark); VMM has stations on all of them (§0.6). Anonymous metadata calls work; the anonymous value limits are unpublished. |
| BE-3 SPW Wallonia | The *mentions légales* say: *"il est interdit à l'utilisateur de fournir les données à un tiers … site web, webservice … sauf accord préalable et écrit du SPW"*. | hydrometrie@spw.wallonie.be | Show the Meuse from RWS (`lixhebiefaval`, `eijsden.grens`, `maastricht.sintpieter`) and Hub'Eau (Chooz, plus the Belgian Semois, Viroin, Houille and Chiers partner stations), and link to hydrometrie.wallonie.be. The Metawal clause about "support statique (… pdf ou image sur Internet)" is UNVERIFIED as a route for an image-only display; ask in the same e-mail. |
| LU-2/3/4 AGE JSON, forecasts and thresholds | They are not covered by the CC0 dataset. The site CGU (05.08.2026) forbids reproduction without written authorisation. | hydrometrie@eau.etat.lu (and the Service de la navigation for the Moselle) | Go live with the CC0 CSV (LU-1) plus the CC BY LU-Alert feed (LU-5), and link out for forecasts. Also ask whether the CC0 covers the third-party gauges inside LU-1 (LfU RLP Bollendorf and Gemünd, WSV Perl, Service de la navigation). |
| DE-9 NLWKN | The manual allows use with a source credit. The Impressum forbids commercial use, passing data to third parties and "in elektronische Systeme einzuspeichern". | HWVZ@nlwkn.niedersachsen.de | Drop the four Vechte/Dinkel stations or show LHP classes only. NRW Vechte/Dinkel gauges (DE-7) still cover the German upper reaches. |
| DE-2/DE-3 BfG forecasts | BfG terms require a source credit **and a free copy of the publication (Belegexemplar)**. It is ambiguous whether `WV` inside PEGELONLINE is covered by DL-DE Zero. | vorhersage@bafg.de | Treat `WV` as BfG data and credit it. Ask in the same e-mail how `WV` behaves above HSW / Marke II (§0.4). |
| **DE-10 LfU Rheinland-Pfalz** (moved to Phase 0) | Impressum: *"Sie dürfen nur mit Zustimmung des LfU verändert, vervielfältigt, in Vervielfältigungen an Dritte abgegeben oder zu öffentlichen Wiedergaben verwendet werden. Als Quelle ist das LfU zu nennen, soweit möglich mit Angabe des Bearbeitungsdatums."* | **poststelle@lfu.rlp.de**; Landesamt für Umwelt Rheinland-Pfalz, Kaiser-Friedrich-Straße 7, 55116 Mainz, tel. 06131 6033-0 (from the hochwasser.rlp.de Impressum) [V] | **This is the single most valuable forecast permission** (§0.5): RLP publishes p10–p90 forecasts for **66 gauges**, including 20 Rhine gauges from Maxau to Emmerich, 9 Mosel gauges (Perl, Stadtbredimus, Wasserbillig, Trier …), the Ahr (3), Nahe (5), Lahn (4), Sauer (2), Our (2), Kyll, Prüm, Saar and Sieg, plus 46 regional alert classes. Without it: LHP classes only for the Ahr, Kyll, Prüm and Nahe. |
| DE-12 LUBW, DE-13 Bayern LfU, DE-14 Saarland | Their Impressum requires consent. Bayern contradicts its own CC BY 4.0 statement, and Saarland is unreachable. | Pegelinfo@lubw.bwl.de, LfU Bayern | LUBW: send in Phase 0 too (Upper Rhine tributaries Murg and Kinzig); not needed for the first release. |
| NL-5 WRIJ Nexus / NL-6 water boards | There is no licence and no documentation, or no API at all. | Vechtstromen, Rijn en IJssel, Waterschap Limburg (addresses not researched) | Use the upstream German gauges (DE-7) and the RWS Vecht stations. |
| EU High-Value Datasets (Regulation (EU) 2023/138) | **Not a lever for real-time hydrometry.** The Earth-observation-and-environment category covers the INSPIRE themes (including Hydrography and Environmental Monitoring Facilities) and data reported under the water and flood directives, delivered "through APIs and bulk download". It sets **no real-time or update-frequency requirement** for hydrometry; only the meteorological category requires 5–10-min real-time weather-station data. Applies since about June 2024. [D] EUR-Lex CELEX 32023R0138 | – | Mention it as a soft argument only. RWS already labels its DDAPI20 WFS an HVD dataset (NGR record). |

**Sources safe for the first release without asking** (open licence, documented or official, no key needed): NL-1, NL-2, NL-4, DE-1, DE-6, DE-7, FR-1, FR-4, FR-5, LU-1 (but see the third-party question above), LU-5, LU-6, CH-1. CH-2, CH-4 and CH-5 are usable under BAFU terms, but they are undocumented website internals; ask BAFU (§10 R5).

**Owner-only use (§0.8; revision 2026-09-24):** BE-3 SPW, LU-2/3/4 AGE and the BfG forecasts (DE-2, DE-3) allow personal use, so the plan shows them to the owner alone from day one. The SPW and AGE requests above now ask only for public display, and the HIC and VMM requests ask for credentials for a personal, non-commercial, private viewer. NLWKN, LfU RLP and LUBW stay off until consent.

### 0.3 Cross-cutting facts every adapter must respect

- **Timestamps use at least 8 conventions** (full table in §4.4). Parse the offset, store UTC `timestamptz`, and never guess. The next DST fall-back is **2026-10-25** (the local hour 02:00–02:59 occurs twice, starting at 01:00Z). **[synth] Every parser of offset-less local times** (LU-1 CSV, NL-2 WFS, DE-6 feature `timestamp`, DE-1 CSV, DE-3 "GMT+1" CSV, DE-10 CSV, DE-12 "MESZ"/"MEZ", DE-13 HTML) needs DST-transition fixtures before its first production run, or stays out of the first slice. The raw archiver (§0.1a) stores bodies, so it is safe; parse LU-1 later against the JSON offsets. Use RWS REST, not the WFS, for times.
- **Units differ.** H comes in cm, mm or m, relative to a gauge zero or absolute. Q comes in m³/s or l/s. Set a per-series unit factor at metadata review; never guess it per row.
- **Real-time data everywhere is raw or unvalidated.** Every provider's terms say so. Show a disclaimer.
- **Negative W and negative Q are legitimate.** Examples: Emmerich −7 cm, Worms −22 cm, Trith-Saint-Léger Q −1.2 m³/s.
- **Q disappears at extremes.** Emmerich Q stopped below W = −1 cm; Chooz switches station below 40 m³/s.
- The hydrological situation at research time was an **extreme low-water event**. Emmerich was below its record NNW and Kaub was at 9 cm.

### 0.4 Flood-state behaviour: what has and has not been seen, and fixtures to test it

All research ran during an **extreme low-water event**, so no provider was observed in a live flood state. The table lists what is now known about flood-state payloads and where test fixtures come from (gap check item 2; raw files in `scratchpad/gapcheck/`).

| Source | Flood-state knowledge | Fixture source | Status |
|---|---|---|---|
| DE-6 LHP stations | Live: 1,590 features (all 16 states); classes 0 (1,290) and −1 (84); **216 features have no `lhpClass` key at all** (MV 180, HE 26, BW 9, TH 1; `stateClassName` "Ohne Hochwasser-Einstufung"); 72 have no `timestamp`. | **Test server** `https://api.hochwasserzentralen.de/public/v1/test/data/stations?format=json`: 1,259 features frozen at **2024-01-25** (the January 2024 flood), classes 0: 1,199, **1: 32, 2: 14, 3: 1**, −1: 13. It has **no class 4 and no class-less features**, so hand-edit those cases. | [V] |
| DE-6 LHP alerts | Live `/data/alerts` returned 0 features. **The alert schema is now verified from the test server**: 40 features (TH 12, BY 10, HE 7, RP 7, BB 2, SN 2), geometry **Polygon or LineString**, properties only `areaDesc`, `areaType` (`Region`/`River`), `alertHeadline`, `lhpClass`, `lhpClassName`. **`lhpClass` is a string** (`"4"`) here but an integer in stations. **The alert scale differs from the station scale**: legend 6 "Sehr großes Hochwasser", 5 "Großes Hochwasser", 4 "Hochwasser", 2 "Vorwarnung", 1 "Entwarnung" (no 3). Alerts carry **no issue or validity time**; only the collection's `updated`/`lastModified`. | Test server `…/public/v1/test/data/alerts` (classes 1, 2, 4, 5; no 6) | [V] |
| FR-5 Vigicrues | All 337 sections were level 1. | Wayback capture `https://web.archive.org/web/20231211164225id_/https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson/` has sections at **level 2 and 3** (Isère, Arve, Midouze). The capture is truncated at 1 MiB, and it uses **different property casing** (`LbEntCru`, `AcroEntCru`, `TypEnSup_1`) from today's lowercase `lbentcru`, `typentcru`, `cddient_1`. The parser must accept both. | [V] (partial) |
| FR-4 Vigicrues forecasts | Only a Loire station (K490003010) had a forecast; territory 2 had none. | No archived forecast from an NL-bound basin was found. Capture one live during the next event; until then use the Loire payload for schema only. | Open |
| LU-5 LU-Alert | **Real AGE flood alerts exist in the open archive** (25 `[AGE]` messages since 2025-06): 2025-09-08/09 **red** (ALERT_LVL_1, zone Sud), orange and yellow (Nord, Sud); 2025-09-23..25 yellow → orange → information (Sud); 2026-02-13/14 **Moselle** yellow → information. `Cancel` messages have **no `<info>` block**: resolve them through `<references>` (`[AGE],<identifier>,<sent>`). A **TEST message has `<status>Actual</status>`** and `cb-eu-level` `TEST` (2026-02-02), so filter on the level and the headline, not on `status`. Each alert has three `info` blocks (fr-FR, de, en-US) and an `expires`. | `scratchpad/gapcheck/cap/` (all 833 dumps) | [V] |
| CH-4 BAFU forecasts | Seen only at low flow. | Wayback: `https://web.archive.org/web/20231102103317id_/https://www.hydrodaten.admin.ch/plots/q_forecast/2020_q_forecast_it.json` (storm Ciarán, 2023-11-02): median rising to 476 m³/s, max 800 m³/s, threshold bands 700/1100/1450/1800. The capture is gzip-encoded. Trace names are language-specific ("Mediana", "Misurato", "Min / Max" and "Min. / Max."), so always fetch `_de` and match by position as well as by name. | [V] |
| CH-5 warning sections | One section was seen. | No archived flood-state capture found. | Open |
| DE-2 BfG `WV` | Unknown above HSW. BfG documents that the **14-day forecast is hidden above HSW (Marke II), where navigation stops**, and that during floods the state flood centres' forecasts are the official information. `WV` runs on working days, and also at weekends and on holidays **when Ruhrort is below 4 m** [D]. | Ask vorhersage@bafg.de whether `WV` is capped, stopped or kept above HSW. | Open ([D] for the schedule) |
| DE-10 RLP | Live classes at low water only. | No test server. The config lists 7 alert classes and HW2–HW100 legend levels, so a hand-made fixture is easy. | Open |

**Flood drill before public launch** [synth]: replay these fixtures (plus a synthetic class-4 LHP file, a Vigicrues level-4 section and a CAP red/Cancel pair) through the whole pipeline and the UI, and load-test the API while they play.

### 0.5 Forecast coverage per river: first release versus after each permission [synth from verified facts]

"Official forecasts where published" is weakest exactly where floods start. The **LfU RLP permission changes the picture most**, so it moved to Phase 0 (§0.2).

| River / reach | First release (no permission needed) | After a permission | Not available |
|---|---|---|---|
| Swiss Rhine and Aare | CH-4, 55 stations, about 115 h | – | – |
| Upper Rhine Basel → Maxau | – | LUBW (UNVERIFIED whether its forecasts are in the JS data) | – |
| Rhine Maxau → Emmerich | DE-2 `WV` at 7 gauges (Oestrich … Emmerich), 96 h, BfG credit | **RLP: 20 gauges** (Maxau, Speyer, Mannheim, Worms, Mainz, Oestrich, Bingen, Kaub, Braubach, Koblenz, Andernach, Neuwied, Oberwinter, Bonn, Köln, Düsseldorf, Duisburg-Ruhrort, Wesel, Rees, Emmerich), p10–p90, about 45–48 h | – |
| Dutch Rhine branches | NL-1, about 34 h, H and Q | – | Longer RWS fan forecasts (not in the API) |
| Mosel (FR) | FR-4, event-only | – | – |
| Mosel (LU/DE) | – | **RLP: Perl, Stadtbredimus, Wasserbillig, Trier, Zeltingen, Wintrich, Detzem, Cochem, Ruwer**; LU-3 (AGE, 14 stations) | – |
| Sauer / Sûre, Our | – | RLP: Bollendorf, Rosport, Gemünd, Dasbourg; LU-3 | – |
| Saar | FR-4 (event-only, French part) | RLP: Fremersdorf | Saarland |
| Nahe, Ahr, Kyll, Prüm, Lahn, Sieg, Wied, Nette | – | **RLP**: Nahe 5, Ahr 3 (Altenahr, Bad Bodendorf, Müsch), Kyll 2, Prüm 1, Lahn 4, Sieg 2, Wied 2, Nette 1; Lahn also HLNUG (`vhs.60`) | – |
| Main, Neckar | – | HLNUG (Main tributaries), LUBW (UNVERIFIED) | Bavarian HND (18 h; robots) |
| Meuse (FR) | FR-4, event-only | – | – |
| Meuse (Wallonia) | – | – | SPW publishes none |
| Grensmaas and Dutch Meuse | NL-1 (`eijsden.grens`, `maaseik`, `lanaken`, `maastricht.*`, `venlo` …) | HIC 48 h and 10-day ensembles | – |
| Scheldt, Leie, Dender, Zeeschelde | NL-1 `antwerpen` (tidal forecast) and Western Scheldt stations | HIC; VMM `H_voorspeld` (UNVERIFIED which stations) | – |
| Ems, Vecht | NL-1 (`nieuwestatenzijl.dollard`, `delfzijl`) | – | NLWKN publishes none |

**Owner view (§0.8, revision 2026-09-24):** without any permission, LU-3 fills the Sauer/Sûre and Our rows (its Mosel LU/DE runs are computed by LfU RLP and wait for C4 or RLP consent, see §0.8), and DE-3 adds the BfG 14-day and 6-week forecasts to the Rhine Maxau → Emmerich row, in the owner view only. DE-2 is owner-only until the Belegexemplar is sent and public from launch. The "First release" column above describes the public site at launch and is unchanged.

**EFAS and GloFAS: decision.** Neither is used in the first release.
- **EFAS** real-time forecasts are *"a restricted service only available to registered authorised EFAS users"*; archived forecasts become open 30 days after release (EWDS and MARS). [D] ECMWF CEMS "Data Access".
- **GloFAS** forecasts are on the EWDS (`cems-glofas-forecast`, updated daily, 0.05°, "CEMS-FLOODS datasets licence"). They are open but **modelled, not official**, so they do not meet "official forecasts where published". Reconsider only as a clearly labelled "model outlook" layer later.

### 0.6 Belgium without permissions: what can be shown on day one [V]

HIC, VMM and SPW are all gated, so the map must not rely on them. Two ungated sources cover part of Belgium (checked live on 2026-09-23 at about 21:30Z):

**RWS (NL-1, CC0) points on Belgian soil**, live in the WFS:

| RWS code | Place | Series (live) | Forecast |
|---|---|---|---|
| `antwerpen` | Zeeschelde, Antwerpen | H (`ZLXXREG_ZEGE`) | **H** |
| `lixhebiefaval` | Meuse, Lixhe downstream of the weir (last weir before NL) | H | – |
| `maaseik` | Grensmaas, Maaseik | H (NAP, TAW, PLAATSLR), **Q F006** | **H and Q** |
| `herenlaak` | Grensmaas, Maaseik-Herenlaak | H | – |
| `lanaken` | Lanaken-Smeermaas | H | **H** |
| `kanne` | Kanne (Jeker/Geer or canal; UNVERIFIED which) | Q (`LBXXREG_AFVOER`) | – |
| `smeermaas.zuidwillemsvaart` | Zuid-Willemsvaart intake (canal transfer) | H and Q | – |

`antwerpen.bonapartedok`, `antwerpen.loodsgebouw`, `antwerpen.prosperpolder`, `prosperpolder`, `kallosluis.schelde` and `fortliefkenshoek` exist in the catalogue but delivered no value in the last 24 h. **Correction:** `sasvangent` (Sas van Gent) is in the Netherlands, not in Belgium; its last value was 13 h old.

**Hub'Eau (FR-1, Etalab 2.0) Belgian partner stations:** 21 stations with commune code 99131 (Belgium). **18 NL-bound ones were live**, hourly:
- Chiers basin: Chiers at Athus (Messancy), Chiers at Torgny, Ton at Harnoncourt.
- Semois: Membre, Tintigny, Chiny, Bouillon (Q only), Sainte-Marie, Straimont (Q only).
- Viroin: Treignes, Couvin (Q only), Nismes (Q only); Houille at Felenne.
- Sambre basin: Thure at Bersillies-l'Abbaye, Hante at Beaumont and Wiheries.
- Scheldt basin: Trouille at Givry (H only), **Lys at Menen-Ropswalle** (H on TAW, Q).
- (Yser at Roesbrugge is live but does not drain to NL.)
- **Not delivering:** `E240041201` Escaut at Tournai and `D021000101` Sambre at Solre-Erquelinnes (registered, no data at all in `observations_tr` or `obs_elab`). **Correction:** the gap note listed Escaut/Tournai and the Sambre as available; they are not.

**Result:** without permissions Belgium has about 25 live points: the Meuse at Lixhe and the Grensmaas (RWS), the Zeeschelde at Antwerp (RWS), the Semois, Chiers, Viroin, Houille and upper Sambre tributaries and the Lys at Menen (Hub'Eau). The Walloon Meuse between Chooz and Lixhe, the Scheldt between Maulde and Antwerp, the Dender, and the Kempen rivers stay empty. The Kempen rivers that enter NL directly need VMM: `getStationList` with `bBox=4.6,51.0,5.95,51.5` (anonymous, 337 stations) shows VMM gauges on the **Mark** (Minderhout L11_047, Merksplas L11_048, Hoogstraten/Laermolen, the Meer weirs K11_200–204), **Dommel** (Neerpelt L11_025, De Wulp L11_026, Overpelt L11_022, Peer L11_023), **Warmbeek** (Achel L11_024), **Kleine Aa/Weerijs** (Wuustwezel L11_044, Brecht L11_046) and **Noordermark** (Baarle-Hertog). Whether they deliver live values was not checked.

### 0.7 Our public API and exports are redistribution [synth]

Every `/snapshot`, `/series` or CSV response republishes the ingested data. Several terms forbid exactly that (SPW *"site web, webservice"*; NLWKN *"an Dritte weiterzugeben"*; the AGE CGU; RLP *"in Vervielfältigungen an Dritte abgegeben"*; LUBW; HIC TYPE-3 terms unknown). Others attach a duty to each response. So:
- Store **per-source licence flags** on the source table and inherit them per series: `display`, `api`, `bulk_export`, `history_export`, `attribution_text`, `attribution_url`, `needs_last_updated`, `needs_retrieval_date`.
- The API and export layer **filter on those flags**. A source permitted "for display only" appears on the map but never in `/series` or CSV.
- Every response carries the attribution and the "last updated"/"Stand"/retrieval date wherever a licence requires it: Etalab/Vigicrues (date of last update), LHP ("Stand" from `updated` plus a clickable link), HIC (retrieval date), BfG (credit; Belegexemplar), CH (Bezugsdatum), LU-Alert ("LU-Alert").
- Default flags for the first-release sources: all four flags on for CC0 / DL-DE Zero / Etalab / CC BY / Modellicentie sources (with attribution); `api` and exports off for anything received under a written permission until the permission says otherwise.

### 0.8 Private (owner-only) use without consent [V, 2026-09-23/24]

The product owner decided on a **hybrid audience** (plan decision D22, 2026-09-24): the public site keeps the open sources, and a login-only **owner view**, used by the owner alone and never shared, additionally shows sources whose terms allow personal use. This table is the per-source verdict. Each `audience: owner` source cites its row here as its `private_basis` (clause, URL, retrieval date). The clauses were read live on 2026-09-23 (research reports) and the three Impressum pages were re-fetched on 2026-09-24. **This is not legal advice.** Whether rights in raw measurements are enforceable was not assessed; the plan follows the terms as written.

| Source | Terms (URL; read) | Verbatim clause | Private use without consent? | Audience (D22) |
|---|---|---|---|---|
| **BE-3** SPW Wallonia | https://hydrometrie.wallonie.be/mentions-legales.html (2026-09-23); Metawal CGU of the measurement records 49373603-… and 9e8f77db-… | *"La reproduction des données figurant sur le site… est autorisée sans accord préalable. L'utilisateur indique la mention « Sources des données : Service public de Wallonie »… Le SPW est seul habilité à distribuer les données. Sauf accord préalable et écrit du SPW, il est interdit à l'utilisateur de fournir les données à un tiers sous quelque forme que ce soit - fichiers, site web, webservice, etc - ou de diffuser celles-ci au public."* Metawal: *"L'Utilisateur ne peut pas redistribuer les données à un tiers ni publier les données sur Internet via un service web."* | **Yes**, for one person, with the credit. Never to a third party or the public, in any form | `owner`. Public only with SPW's prior written consent (C3, optional) |
| **LU-2 / LU-3 / LU-4** AGE Luxembourg | https://inondations.public.lu/fr/support/aspects-legaux.html (Aspects légaux, dated 05.08.2026; read 2026-09-23) | *"aucune reproduction des informations ou Services, totale ou partielle, sous quelque forme que ce soit et par quelque moyen que ce soit, n'est permise sans l'autorisation écrite préalable de la Bibliothèque nationale du Luxembourg. Sauf indication contraire, l'usager est autorisé à consulter, télécharger et imprimer les documents et informations disponibles aux conditions suivantes : Les documents ne peuvent être utilisés qu'à titre personnel, pour information et dans un cadre strictement privé ; Les documents et informations ne peuvent être modifiés de quelque manière que ce soit ; Les documents et informations ne peuvent être diffusés en dehors du site."* | **Yes**: personal, informational, strictly private use. Values are shown as published (unit and time conversion for display only) and never leave the owner channel | `owner`. Public only with written authorisation (C4, optional). LU-1 (CC0) and LU-5 (CC BY) stay public |
| **CH-2 / CH-4 / CH-5** BAFU hydrodaten files | BAFU delivery and usage conditions 2020 (https://www.bafu.admin.ch/dam/de/sd-web/g7vjiKP5LJ11/liefer-nutzungsbedingungen-hydrologische-daten.pdf) and general conditions 16.09.2019 (https://www.bafu.admin.ch/dam/de/sd-web/5NAitqNKub6m/allgemeine_bedingungenfuerdasherunterladenaktuellerhydrologische.pdf) (2026-09-23) | *"Freie Nutzung"*; §6: download *"nicht häufiger als alle 10 Minuten"*; §8: forecasts *"dürfen frei verwendet werden"* | **Yes**, and public use too | `public`. If BAFU objects to public use in its C13 answer: `owner` instead of stopping. If BAFU asks us to stop fetching the files, capture stops |
| **DE-2 / DE-3** BfG forecasts | https://6wochenvorhersage.bafg.de/ (2026-09-23) | *"Der Nutzer / die Nutzerin verpflichtet sich, in Veröffentlichungen, die auf der Grundlage der bereitgestellten Daten entstanden sind, die BfG als Datenquelle zu nennen und der BfG ein entsprechendes Belegexemplar unentgeltlich zur Verfügung zu stellen."* | **Yes**. The credit and free-copy (Belegexemplar) duties attach to publications; the owner view keeps the credit anyway | `owner`. DE-2 turns `public` once the Belegexemplar is sent (E1, P12); DE-3 public display follows D4 (P13) |
| **BE-2** VMM Flanders | https://vmm.vlaanderen.be/disclaimer; https://waterinfo.vlaanderen.be/default.aspx?path=Public%2FOver+waterinfo%2FFAQ+open+data (2026-09-23) | *"Alle datasets van de Vlaamse Milieumaatschappij worden ter beschikking gesteld onder de modellicentie voor gratis hergebruik"*; *"VMM vraagt … steeds gebruik te maken van de token access bij geautomatiseerde databevraging"* | The licence allows reuse, commercial and public included, with attribution. Only registration is needed: a free token, requested by e-mail stating the data and the frequency | `off` until the token arrives, then `owner` until the token terms are read; public is allowed by the licence (C2) |
| **BE-1** HIC Flanders | HIC disclaimer on https://hicws.vlaanderen.be and the HIC manual, chapters 1 and 5 (2026-09-23) | IP clause: the right to *"download information for personal use and to reproduce … provided the source is acknowledged"*; *"intended for information and non-commercial purposes"*; TYPE 3: *"data are requested in an automatic process and/or scheduled in a tool/viewer/software… (example: integration of HIC webservices in a viewer …)"*, which requires authentication, and *"A User Agreement fit to your needs is put in place after consultation with HIC"* | Personal use is granted, but scheduled use in a viewer is TYPE 3, which needs credentials and a User Agreement | `off` until TYPE-3 credentials for a personal, non-commercial, private viewer arrive (C1), then `owner`; public only if the agreement allows |
| **DE-9** NLWKN | https://www.pegelonline.nlwkn.niedersachsen.de/Impressum (re-fetched 2026-09-24) | *"Es ist weder gestattet, die bereitgestellten Daten und Informationen zu kommerziellen Zwecken zu nutzen, sie zu vervielfältigen oder zu übersetzen, noch deren Inhalte in irgendeiner Weise zu verändern, sie an Dritte weiterzugeben oder sie in elektronische Systeme einzuspeichern."* | **No**. Even private storage is excluded, so there is no live pass-through mode either | `off` until consent (C5) |
| **DE-10** LfU Rheinland-Pfalz | https://www.hochwasser.rlp.de/ Impressum (`/static/shared/partials/impressum.phtml`; re-fetched 2026-09-24) | *"Sie dürfen nur mit Zustimmung des LfU verändert, vervielfältigt, in Vervielfältigungen an Dritte abgegeben oder zu öffentlichen Wiedergaben verwendet werden."* The CSV export has deliberate Referer hot-link protection: never circumvent it | **No** | `off` until consent (C11). Its gauges keep LHP (DE-6, CC BY 4.0) classes and the federal PEGELONLINE gauges |
| **DE-12** LUBW | https://www.hvz.baden-wuerttemberg.de/ Impressum (re-fetched 2026-09-24) | *"Sie dürfen nur mit Zustimmung der LUBW verändert, vervielfältigt, in Vervielfältigungen an Dritte abgegeben oder zu öffentlichen Wiedergaben verwendet werden."* | **No** | `off` until consent (C12). Its gauges keep LHP classes and the federal gauges |

Notes:
- The **RLP-operated gauges inside the CC0 LU-1 file** (Bollendorf, Gemünd) stay withheld (series `audience: off`) in both audiences until AGE confirms that its CC0 covers them (C4) or RLP consents (C11). The same applies to the other LfU RLP data AGE republishes, which come in their own files and are therefore not fetched at all: the LU-2 `Bollendorf.json` and `Gemünd_Our.json` and the LU-3 Moselle forecasts at Perl, Stadtbredimus and Wasserbillig, which LfU RLP computes (§2.6). The owner view therefore has LU-3 for the 11 AGE-computed stations only.
- **DE-13 LfU Bayern** stays in the backlog (`off`); its terms were not re-assessed for owner use.
- Owner-only use must stay owner-only. Showing the owner view to anyone else, sharing its credentials or WireGuard keys, or publishing screenshots would be distribution to third parties under every row marked `owner`.

---

## 1. Data-source table

### 1a. Technical characteristics

> `<NLWKN_PUBLIC_KEY>`: the key NLWKN publishes in its webservice manual (BenutzerhandbuchWebservicePegelonline.pdf). It is redacted here so that secret scanners stay quiet. Once NLWKN gives permission (owner action C5), take it from the manual and store it as a VPS secret, never in git.

Quantities: **H** = water level, **Q** = discharge, **F** = forecast, **T** = thresholds, alert levels or characteristic values.

| ID | Country / region | Provider – service | API base URL | Live-verified | Quantities | Cadence / latency | History via API | Auth | Rate limits |
|---|---|---|---|---|---|---|---|---|---|
| **NL-1** | NL | Rijkswaterstaat – WaterWebservices REST (WADAR, "DDAPI20") | `https://ddapi20-waterwebservices.rijkswaterstaat.nl` | yes | H (`WATHTE` cm NAP) at 663 locations; Q (m3/s) at 199; F: H at 183 locations and Q at 13, about 34 h ahead; astronomical tide to the end of 2027. T: none in the API (see NL-4) | 10 min; about 20 min latency (Eijsden Q about 75 min) | Decades | None (optional `X-API-KEY` header) | None published. Hard caps: 160,000 values per request, 100,000 series per request, 50,000 series for `OphalenLaatsteWaarnemingen`. No CORS, no gzip. |
| **NL-2** | NL | RWS – DDAPI20 OGC WFS/WMS (GeoServer) | `https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/wfs` (also `/ows`, `/wms`) | yes | Latest H+Q per series with coordinates (about 319 H and 109 Q stations live) | Refreshes every 10 min; about 10 min behind REST | Latest only | None | CORS `*`, gzip, `CountDefault` 1,000,000 |
| NL-3 | NL | waterinfo.rws.nl internal JSON | `https://waterinfo.rws.nl/api/point/latestmeasurement?parameterId=…` | yes | Latest H with Waterinfo class label, colour and `possiblyFaulty` | about 13 min lag; `max-age=300` | Latest only | None | Undocumented |
| NL-4 | NL | RWS Waterinfo legend-class spreadsheet (**display classes, not alert levels**) | `https://rijkswaterstaatdata.nl/publish/pages/223004/grenswaarden-en-legendakleuren-zoals-gebruikt-op-waterinfo-15-4-2026-.xlsx` | yes (495 KB; parsed in the gap check) | T: per-location H classes (237 codes) and Q classes (27 codes), **varying by month or season** (`Period`, `FromMonth`…`ToDay`), with `Priority` and slug duplicates; see the parser specification in §2.1 | "Quarterly" per the file; only the 15-4-2026 edition was online on 2026-09-23 | – | None | URL may break when the site becomes CTD on 5 Nov 2026 |
| NL-5 | NL | Waterschap Rijn en IJssel – Nexus ArcGIS FeatureServer | `https://opengeo.wrij.nl/arcgis/rest/services/WaterData/Nexus_P/FeatureServer/0/query` | yes | H (m NAP), Q, F (`Afvoeren_verw_534`, `Waterstandsverw_539`) at 3,622 points | Syncs about every 30 min; hourly values | UNVERIFIED | None | Undocumented, no licence |
| NL-6 | NL | Water boards: Vechtstromen, Waterschap Limburg (`waterstandlimburg.nl` returned 403), WRIJ portal (`waterdata.wrij.nl` unreachable) | – | no API found | – | – | – | – | – |
| **DE-1** | DE (federal waterways) | WSV/ITZBund – PEGELONLINE REST API v2 | `https://www.pegelonline.wsv.de/webservices/rest-api/v2` | yes | H (`W`, cm above gauge zero PNP; some series in `m+NN`) at 737 series; Q at 94 stations (17 on the Rhine). T: characteristic values (W only) and state flags | Mostly 15 min (some 1, 5 or 10 min); a new value appears about 2 min after its timestamp | About 31 days | None | None documented. ETag/`If-None-Match` gives 304; gzip; CORS `*` |
| **DE-2** | DE (Rhine) | BfG forecasts inside PEGELONLINE (`WV`) | `…/rest-api/v2/stations/{uuid}/WV/measurements.json` | yes | F: W, 2-hourly, 0–48 h "forecast" plus 48–96 h "estimate", for 7 Rhine gauges | Runs on working days, and also at weekends and on holidays when Ruhrort is below 4 m [D] (BfG "Vorhersagen" page, re-read 2026-09-23); a 07:00 run was seen. Behaviour above HSW is unknown (§0.4) | Latest run only | None | As DE-1 |
| DE-3 | DE (Rhine) | BfG CSV forecasts | `https://vorhersage.bafg.de/14-Tage-Vorhersage/`, `https://vorhersage.bafg.de/6-Wochen-Vorhersage/index.html` | yes | F: 14-day daily-mean quantiles (7 gauges); 6-week weekly W/Q box quantiles | Daily (`Last-Modified` 09:45 GMT) | Latest | None | – |
| DE-4 | DE | PEGELONLINE HyDAS API (beta) | `https://pegelonline.wsv.de/api/v1/stations` | yes | H, Q; also `stationingOrigin`, `state`, `operatorUrl` | – | About 31 days | None on the documented sub-paths | Beta: "inkompatibel ändern" |
| DE-5 | DE | PEGELONLINE long-term raw download (web form) | `https://pegelonline.wsv.de/gast/historische-zeitreihen/prepare-download` | yes (one small test) | Raw H and Q | – | Since 2000-01-01 | Session cookie | A form, not an API; a file can take up to 15 s |
| **DE-6** | DE (all states) | Länderübergreifendes Hochwasserportal – LHP PublicAPI | `https://api.hochwasserzentralen.de/public/v1` | yes | T only: station flood class `lhpClass` −1…4 for **1,590 gauges in all 16 states** (216 without any class), plus regional alerts on a **different class scale** (1, 2, 4, 5, 6; schema verified on the test server, §0.4). **No values.** | Updated every minute; `max-age=60`; `If-None-Match` → 304 works | None | None | CORS `*` |
| **DE-7** | DE-NW | LANUK (formerly LANUV) – Hochwasserportal.NRW official downloads plus WISKI-Web JSON | `https://www.hochwasserportal.nrw/data/downloads/messwerte.zip`; `https://www.hochwasserportal.nrw/data/internet/…` | yes | H only (cm above PNP) at 255 stations in the zip and 302 in layer 10. T: `LANUV_MNW`/`MW`/`MHW`, `LANUV_Info_1..3`, `alarmlevel.json`. **No real-time Q.** | 15 min (some 5 min); the zip is refreshed about every 5 min | 7 days (zip); **2 months of 15-min W for 253 stations + 2 years of daily mean and max (`pegeldaten.zip`, 10.1 MB, refreshed daily; verified in the gap check)** | None | None documented; layer JSON answers `If-Modified-Since` with 304 |
| DE-8 | DE-NW | opengeodata.nrw.de – `hygon` (daily mirror) and `hydro` (verified archive) | `https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/{hygon,hydro}/` | yes (H files); `hydro/q` listing only [D] (gap check: `hydro/q/index.json` lists decade ZIPs such as `Ahreinzugsgebiet-NRW-Q_1980-1989_EPSG25832_CSV.zip`; not downloaded) | Verified H (and Q in `hydro/q`) plus station metadata (PNP, DHHN2016) | `hygon` daily at about 05:09; verified data lags about 3 months | Since 1930-01-01 | None | – |
| **DE-9** | DE-NI | NLWKN Pegelonline public REST (Azure API Management) | `https://bis.azure-api.net/PegelonlinePublic/REST/` | yes | H (cm) at 112 stations; T: `Meldestufen` 1–3 | 15 min (`IntervallSek` 900) | 30 days max | Public key `<NLWKN_PUBLIC_KEY>` as `?key=` (an invalid key returns 401) | None documented |
| DE-10 | DE-RP | LfU Rheinland-Pfalz – hochwasser.rlp.de SPA API | `https://www.hochwasser.rlp.de/api/v1/` | yes | H (+Q) at 292 sites; F: p10…p90 (9 percentiles, 46–48 steps, about 45–48 h) at **66 gauges** (Rhine 20, Mosel 9, Nahe 5, Lahn 4, Ahr 3, Sauer 2, Our 2 …); T: 46 regional alert classes (1–7) and HW2–HW100 station legend | 15 min; forecast runs about every 3–5 h (`nextUpdateTime`), Rhine daily at low water | 48 h (index), 5 days (per site); CSV 90 days + 3 years daily | None; the CSV needs a `Referer` | Hot-link protection on the CSV |
| DE-11 | DE-HE | HLNUG – WISKI-Web JSON | `https://www.hlnug.de/static/pegel/wiskiweb3/data/` | yes | H, Q; F: `vhs.60` about +24 h, `abs.60`/`nor.60` about +7 days | About 15 min | 7 days at 15 min; daily since about 1995 | None | – |
| DE-12 | DE-BW | LUBW HVZ – JavaScript data arrays | `https://www.hvz.baden-wuerttemberg.de/js/jf-data-db-peg.js` | yes | Latest H, Q (333 stations) | About 5 min | None (GIF charts only) | None | – |
| DE-13 | DE-BY | LfU Bayern – GKD / HND | `https://www.gkd.bayern.de`, `https://www.hnd.bayern.de/pegel` | yes | H, Q (HTML); HND 18-hour forecasts | – | Download centre from 1963 | None | `robots.txt` disallows `/webservices/` and the downloadcenter paths |
| DE-14 | DE-SL | LUA Saarland | `https://www.saarland.de/…/wasserstaende_warnlage_node.html` | **no** (403 Bunny Shield). The legacy `umweltserver.saarland.de/extern/wasser/Daten.js` has been frozen since 23.02.2023. | – | – | – | – | – |
| DE-15 | DE-NW (Rur) | Wasserverband Eifel-Rur (WVER) | `https://wver.de/karten_messwerte/Messdatenportal/` | yes (main site); `server.wver.de` no | H, Q, about 70 gauges | 15 min | About 1 year per station JSON | None | – |
| DE-16 | DE-NW | Niersverband (PDF charts only); Ruhrverband (HTML only) | `https://www.niersverband.de/gewaesser/pegelwesen/daten`, `https://www.talsperrenleitzentrale-ruhr.de/online-daten/gewaesserpegel` | yes | – | – | – | – | – |
| DE-17 | DE | ELWIS | `https://www.elwis.de/…` | yes (terms) | – | – | – | – | – |
| **BE-1** | BE-Flanders | Waterbouwkundig Laboratorium – HIC KiWIS (navigable rivers, tidal Zeeschelde, Grensmaas) | `https://hicws.vlaanderen.be/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=4` | yes | H, W (tidal) in m TAW; Q m³/s. F: 48 h and 10-day ensembles; astronomical tide to 2028-01-03. T: `DrempelPrewaak`/`Waak`/`Alarm`; HW/LW with tide numbers | Tidal 10 min, others 1–15 min; latency about 5–12 min | Tidal 10-min since 1996; HW/LW since 1888 | **OAuth2 client credentials plus a User Agreement (TYPE 3)** | Credit-metered (about 1 credit per 10,000 theoretical values); 250,000 values per call; anonymous callers "may be blocked" |
| **BE-2** | BE-Flanders | VMM KiWIS (non-navigable rivers) | `https://download.waterinfo.be/tsmdownload/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=1` | yes | H (use `Absolute Value`, m TAW), Q; F parameters `H_voorspeld`/`Q_voorspeld`. T series exist but were empty in samples | 15 min; latency about 7–35 min | 15-min since 1973 (Sint-Joris-Weert) | Token for automated use | Anonymous limits unpublished; 250,000 values per call |
| **BE-3** | BE-Wallonia | SPW – hydrometrie.wallonie.be KiWIS (DGH "WACONDAH" + DCENN "AQUALIM") | `https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0` | yes | H (relative m; absolute m DNG), `Habs`, Q, `QADM` (hourly). T: statistics and percentiles, `CrueDeReference`; numeric alert thresholds not found (a `NIVCRU` attribute exists) | DGH 5 min, DCENN 10 min, QADM hourly; 277 of 320 level series were under 30 min old | Since 1969; `-Alarmes` web series since 2019-01-01 | None (`X-spw-user: public`) | None documented; edge cache 300 s; 250,000 values per bulk download |
| BE-4 | BE-Wallonia | SPW INSPIRE OGC API Features (station locations) | `https://geoservices.wallonie.be/geoserver/inspire_ef/ogc/features/v1/…` | yes | 33 WFD gauging-site locations | Static | – | None | – |
| BE-5 | BE-Brussels | hydria.be (flowbru.be redirects to it) | – | no API found (UNVERIFIED) | – | – | – | – | – |
| **FR-1** | FR | Hub'Eau Hydrométrie API v2 (from PHyC / SCV) | `https://hubeau.eaufrance.fr/api/v2/hydrometrie/` | yes | H (**mm**, relative to the gauge zero), Q (**l/s**) | Native 5/6/10/15 min (partner stations 60 min); the API is updated every 5 min; latency 15–75 min | 1 month | None | None documented. "Abusive" use may be refused. `size` is at most 20,000. CORS `*`, gzip |
| FR-2 | FR | Hub'Eau `obs_elab` (daily and monthly aggregates) | `https://hubeau.eaufrance.fr/api/v2/hydrometrie/obs_elab` | yes | Daily and monthly Q; daily and monthly max H | Daily, 1–4 days late | Since 1953 at Chooz ("depuis 1900 pour certaines stations") | None | 20,000-row depth cap; at most 100 codes per call |
| FR-3 | FR | Vigicrues `observations.json` | `https://www.vigicrues.gouv.fr/services/observations.json/index.php` | yes | H (m), Q (m³/s) | 5 min | About 2 months | None | `max-age=120`; returns the whole series every time (752–865 KB per station) |
| **FR-4** | FR | Vigicrues forecasts | `https://www.vigicrues.gouv.fr/services/v1.1/prevision.json`, `https://www.vigicrues.gouv.fr/services/previsions.json/index.php` | yes | F: H/Q hourly P10/P50/P90, about 21 h ahead | **Only during events** (**correction** 2026-10-01 (#39): the national list is never empty (27–31 stations on 2026-09-29/10-01, none in A/B/D/E1–E3); NL-bound forecasts still only during events; FR-4 fetches only NL-bound stations) | Current run | None | – |
| **FR-5** | FR | Vigicrues vigilance and reference data | `https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson`, `…/TerEntVigiCru.json`, `…/StaEntVigiCru.json`, `…/station.json/index.php` | yes | T: `NivInfViCr` 1–4 per river section (tronçon); `CruesHistoriques` flood heights per station. The station list of each section is in `TronEntVigiCru.json?CdEntVigiCru=<code>&TypEntVigiCru=8` (`aNMoinsUn`) [V] | Updated "au moins deux fois par jour" | Current | None | No ETag or Last-Modified; gate on `DtHrInfoVigiCru` |
| FR-6 | FR | HydroPortail | `https://www.hydro.eaufrance.fr/` | yes (site only) | UI exports only | – | Long (UNVERIFIED) | UNVERIFIED | – |
| **LU-1** | LU | AGE – `Water-Levels-LocalTime.csv` (listed on data.public.lu) | `https://inondations.public.lu/dam-assets/ctie/datas/Water-Levels-LocalTime.csv` | yes | H (cm, one station in m) at 42 stations | 15 min; latency about 11–25 min | 5 days (P5b: 7 days and 672 labels since 2026-09-30) | None | None documented; Cloudflare `max-age=14400` |
| LU-2 | LU | AGE per-station JSON | `https://inondations.public.lu/content/dam/inondations/ctie/datas/<File>.json` | yes (41 of 42; `SN_Remich.json` returns 404) | H (cm) | 15 min; 11–19 min typical, 30–60 min at Perl, Eischen and Ubersyren | 7 days | None | No CORS; `robots.txt` has `Disallow: /*?*` |
| LU-3 | LU | AGE forecasts | `https://inondations.public.lu/percentile/<slug>-p{10,30,50,70,90}.json` | yes | F: H p10–p90, hourly, about 45 h, for 14 stations | AGE hourly per the site text [D] (observed only twice, 8 min apart: partly verified); LfU RLP runs (Moselle) about every 3–5 h (RLP `nextUpdateTime`) | Latest run only | None | – |
| LU-4 | LU | AGE station pages (`data-to-json`) | `https://inondations.public.lu/{fr\|de\|en}/<basin>/<river>/<station>.html` | yes | T: yellow/orange/red vigilance levels, HQ2–HQ100 equivalent levels, gauge zero, river km | Changes rarely; scrape weekly | Current only | None | – |
| **LU-5** | LU | LU-Alert CAP-LU dumps on data.public.lu | `https://data.public.lu/api/2/datasets/67aca67bcaea3ae62308114f/resources/?page_size=20` | yes | T: flood vigilance for 3 zones (Nord, Sud, Moselle) | Published about 4 min after issue | Since about 2025-06 (836 files) | None | – |
| LU-6 | LU | geoportail.lu station geometry and river network | `https://features.geoportail.lu/collections/655/items?f=json`; WMS `https://wms.geoportail.lu/public_map_layers/service` layer `655`; rivers `https://features.geoportail.lu/collections/749/23` | yes | 51 station points in WGS84; 311 primary-river features | Static | – | None | CORS `*` |
| LU-7 | LU | AGE validated archive | On request from the Service Hydrologie et hydrométrie | page verified | Validated H + Q, 2002–2024 | On request | Deep | – | – |
| **CH-1** | CH | BAFU – LINDAS SPARQL cubes `river` and `lake` | `https://ld.admin.ch/query` (also `https://lindas.admin.ch/query`); cube `https://environment.ld.admin.ch/foen/hydro/river` (and `/lake`) | yes | Q (m³/s), H (m a.s.l. LN02), temperature, `dangerLevel`, for 199 river and 34 lake stations | 10 min; lag about 14–24 min | **None** | None; CORS `*` | Download no more often than every 10 minutes (BAFU 2019 conditions §6); a 30-second per-query limit is UNVERIFIED |
| **CH-2** | CH | hydrodaten.admin.ch live GeoJSON | `https://www.hydrodaten.admin.ch/web-hydro-maps/hydro_sensor_pq.geojson` | yes | Latest Q/H, 24 h min/mean/max. T: `wl_1..wl_4` (180 of 207 stations), `failure_text` | About 8 min lag; `max-age=30` | None | None | Undocumented |
| CH-3 | CH | hydrodaten plot JSON (7 and 40 days) | `https://www.hydrodaten.admin.ch/plots/p_q_40days/{id}_p_q_40days_{lang}.json` | yes | H, Q at 5-min steps | Regenerated every 5–15 min | 40 days | None | Undocumented |
| **CH-4** | CH | hydrodaten forecast JSON | `https://www.hydrodaten.admin.ch/plots/q_forecast/{id}_q_forecast_{lang}.json` | yes | F: hourly median, 25–75 % band, min/max, about 115 h; 55 stations | Daily, more often during floods | Current run | None | Undocumented |
| **CH-5** | CH | hydrodaten warning sections | `https://www.hydrodaten.admin.ch/web-hydro-maps/hydro_warn_levels_{de,en,fr,it}.geojson` | yes | T: 93 river, lake and region sections with `level`, `valid_from`, `valid_until` | One seen issued 07:24 local, valid until 25.09 11:00 (the national warning map, CH-6, updates about twice a day) | Current | None | Undocumented |
| CH-6 | CH | geo.admin.ch open-data GeoJSON (classes only) | `https://data.geo.admin.ch/ch.bafu.hydroweb-messstationen_{zustand,gefahren,vorhersage,temperatur}/…_{lang}.json`; `…/ch.bafu.hydroweb-warnkarte_national/…_{lang}.json` | yes | T: percentile class 1–5, danger level 1–5, warning map | About 15 min; the warning map about twice a day | None | None | – |
| CH-7 | CH | STAC station and catchment metadata | `https://data.geo.admin.ch/api/stac/v1/collections/ch.bafu.hydrologie-hydromessstationen/items` | yes | Station and catchment shapes (EPSG:2056) | Static (2024-06-01) | – | None | – |
| CH-8 | CH | BAFU Datenservice Hydrologie (orders) | `https://www.bafu.admin.ch/de/datenservice-hydrologie-fuer-fliessgewaesser-und-seen` | page and sample verified | CSV at 5 min, 10 min or hourly from 1974; daily from the 19th century | On request, "some days" (UNVERIFIED) | Deep | Order by e-mail or form | Free since 2020-01-01 |
| CH-9 | CH | Kanton Basel-Stadt – data.bs.ch | `https://data.bs.ch/api/explore/v2.1/catalog/datasets/100089/records` (Rhein 2289), `…/100236/records` (Birs 2106) | yes | 5-min Q, H and gauge reading, in UTC | Near real time | 100089 since 2020-06-22; 100236 since 2022-10-29 | None | `X-RateLimit-Limit: 500000` per day |
| CH-10 | CH | existenz.ch (third-party mirror) | `https://api.existenz.ch/apiv1/hydro/latest` | yes | Q, H | 10 min | About 30 days | None | Not official |
| CH-11 | CH | opendata.swiss CKAN (metadata) | `https://ckan.opendata.swiss/api/3/action/package_search` | yes | – | – | – | Returns 403 with a default User-Agent | – |

### 1b. Licence, attribution, effort, release slot and risks

Attribution strings are exact where a provider or report gives them. "Suggested" means the licence does not require it.

| ID | Licence | Attribution text (exact) | Effort [synth] | Release [synth] | Key risks |
|---|---|---|---|---|---|
| **NL-1** | CC0: *"Op de inhoud van de WaterWebservices is de Creative Commons zero verklaring (CC0) van toepassing…"* | Suggested: **"Waterstanden en afvoeren: Rijkswaterstaat – WaterWebservices (CC0), https://rijkswaterstaatdata.nl/waterdata/"**, plus a "not for flood-safety decisions" disclaimer. Do not imply government endorsement. | M | **First release** (primary NL source; forecasts snapshotted from go-live) | Young API (live since 5 Dec 2025), with a one-week data stall (4–11 June 2026), a rollback (22 July) and limit changes. No SLA ("niet geschikt voor kritieke toepassingen"). Docs move to CTD on 5 Nov 2026. Stale headline gauges (Arnhem, Driel Q, Westervoort IJsselkop Q). |
| **NL-2** | CC0; WFS `Fees NONE`, `AccessConstraints NONE`; NGR "Geen beperkingen", HVD dataset | As NL-1 | S | **First release** (discovery and "all stations" layer; REST wins on conflict) | Timestamps are local time labelled `Z`. An old value can appear with a fresh timestamp (Driel Q). The unfiltered layer has 941,735 features. |
| NL-3 | Undocumented, no terms | – | – | **Not recommended** (inspiration for colour classes only) | Can change without notice; `/api/legend/legend` returned 500 |
| NL-4 | As NL-1; the file itself says *"hier kunnen geen rechten aan worden ontleend"* | As NL-1 | M (seasonal periods, priorities, slug duplicates) | **First release** (Waterinfo display classes for NL stations, labelled as such, **not** as official warnings) | Covers 49 of 54 curated live H series and 14 of 18 Q series; the "quarterly" update has not appeared since 15-4-2026; the URL may break with the CTD launch on 5 Nov 2026 |
| NL-5 | None stated; described as an internal dashboard layer | – | – | **Not recommended** without WRIJ consent (later phase at best) | Timestamp semantics UNVERIFIED (its Lobith mirror showed 6.28 m at "16:00Z" while RWS had 628 cm at 19:00Z) |
| NL-6 | – | – | – | Later (negotiate feeds) | No API |
| **DE-1** | DL-DE→Zero-2.0 (terms "Stand: 21.05.2024"): *"Jede Nutzung ist ohne Einschränkungen oder Bedingungen zulässig."* | Suggested: **"Pegeldaten: WSV/GDWS via PEGELONLINE (pegelonline.wsv.de), Datenlizenz Deutschland – Zero – Version 2.0 (https://www.govdata.de/dl-de/zero-2-0). Ungeprüfte Rohdaten."** | S | **First release** | 31-day retention. Raw data. Q goes stale or stops. Mixed datums and units. Whether third-party mirrors (RWS, BAFU Basel, RP Freiburg Konstanz, Ruhrverband Hattingen) are covered by DL-DE Zero is unclear: take those from their original sources. |
| **DE-2** | Ambiguous: DL-DE Zero (PEGELONLINE) or BfG terms. Treat it as BfG. | **"Wasserstandsvorhersage: Bundesanstalt für Gewässerkunde (BfG)"**, labelled forecast/estimate. BfG terms: *"…die BfG als Datenquelle zu nennen und der BfG ein entsprechendes Belegexemplar unentgeltlich zur Verfügung zu stellen."* | S | **First release** (product requirement), once the Belegexemplar obligation is accepted | Only 7 gauges; latest run only; CSV percentiles empty today |
| DE-3 | BfG terms (credit plus free copy) | As DE-2 | S | Later | 14-day CSV: `---` above 640 cm; "GMT+1"; `DD.MM.YYYY`; stamped at the start of the day |
| DE-4 | DL-DE→Zero-2.0 (in the `meta` block) | As DE-1 | – | Later (re-evaluate after beta) | Beta; `stationingOrigin` wrong for Hattingen |
| DE-5 | DL-DE→Zero-2.0 (the zip includes `nutzungsbedingungen.txt`) | As DE-1 | M | Later (backfill; **ask ITZBund/WSV before scripting**) | Undocumented form; terms checkbox; up to 15 s per file |
| **DE-6** | CC BY 4.0 | **"Datenquelle: www.hochwasserzentralen.de"** (clickable), or "Quelle: Länderübergreifendes Hochwasserportal (LHP)" linking to https://www.hochwasserzentralen.de, **plus "Stand: TT.MM.JJJJ hh:mm"** from `updated`. Keep the LHP class colours. Refresh at least every 10 min when republishing online. | S | **First release** (optional overlay; gives honest classes for Länder gauges without values) | No values; mixed time zones; the ETag changes when `updated` ticks (about every minute) but `If-None-Match` does return 304 in between; the same gauge appears under several states with conflicting classes (§4.9 rule); 216 features without `lhpClass`; alert classes use a different scale and a string type |
| **DE-7** | DL-DE→Zero-2.0 (portal Downloads page and GovData `dl-zero-de/2.0`). An older "kommerzielle Nutzung … Nutzungsvereinbarung" paragraph also appears on the page. | Courtesy: **"Datenquelle: LANUK NRW, Hochwasserportal.NRW"** | M | **First release** (top-priority state source: Rur, Wurm, Niers, Schwalm, Issel, Bocholter Aa, Berkel, Dinkel, upper Vechte, upper Ems) | WISKI JSON is internal. Placeholder IDs (`1234567`, `123456`, `1234512345`). WSV duplicates (`site_no` 102). Fixed `+01:00`. No Q. |
| DE-8 | DL-DE→Zero-2.0 | As DE-7 | M | Metadata (PNP) at first release; archive later | Irregular, change-driven timestamps; ISO-8859-1 metadata CSV (P5b: the hydro file only; the OpenHygon station file is UTF-8) |
| **DE-9** | **Conflict.** Manual: *"Die Quelle www.pegelonline.nlwkn.niedersachsen.de muss bei Verwendung der Services immer angegeben werden."* Impressum: *"Es ist weder gestattet, die bereitgestellten Daten … zu kommerziellen Zwecken zu nutzen, … an Dritte weiterzugeben oder sie in elektronische Systeme einzuspeichern."* Footer: *"Vervielfältigung nur mit unserer Genehmigung"*. | **"www.pegelonline.nlwkn.niedersachsen.de"** | S | **First release, conditional** on written OK; otherwise LHP classes | Licence; swapped lat/lon; mislabelled `Datum`; `-888` sentinel |
| DE-10 | Impressum: *"…dürfen nur mit Zustimmung des LfU verändert, vervielfältigt … Als Quelle ist das LfU zu nennen, soweit möglich mit Angabe des Bearbeitungsdatums."* | "LfU" as source, with the processing date | M | **Ask in Phase 0** (poststelle@lfu.rlp.de); first release if granted. It is the largest single gain in official forecasts (66 gauges, §0.5) | Consent; Referer check; 8- vs 10-digit IDs; carries other operators' data (DREAL, LANUK, WSA, AGE, SPW; the rights stay with them) |
| DE-11 | Download area CC BY 4.0: *„Hessisches Landesamt für Naturschutz, Umwelt und Geologie (HLNUG)"*, plus a licence link and a note of changes | **„Hessisches Landesamt für Naturschutz, Umwelt und Geologie (HLNUG)"** + link to the CC BY 4.0 licence + "changes made" | M | Later (phase 2); ask HLNUG to confirm automated retrieval | JSON paths undocumented; WSV gauges excluded |
| DE-12 | Impressum: consent required; *"Als Quelle ist die LUBW zu nennen."* | "LUBW" | M | Later, with permission | Scraping JS; `Last-Modified` 2 h behind; future timestamps |
| DE-13 | GKD download: CC BY 4.0, contradicted by the Impressum (*"Veröffentlichung nur mit unserer Einwilligung"*). LfU WMS: *"CC BY-SA 4.0; Datenquelle: Bayerisches Landesamt für Umwelt, www.lfu.bayern.de"* | As quoted | L | Later / backfill only; **not recommended** for live data | No machine interface; robots restrictions |
| DE-14 | – | – | – | **Not available** (use LHP classes and the FR Blies gauges) | Bot shield |
| DE-15 | *"Ungeprüfte Rohdaten \| Lizenzhinweis: CC BY-SA 4.0 \| Längere Zeiträume auf Anfrage"* | CC BY-SA 4.0 (no exact text given) | M | Later | ShareAlike; scraping; `server.wver.de` unreachable |
| DE-16 | Not stated | – | – | **Not recommended** (use DE-7) | PDF/HTML only |
| DE-17 | *"…solange der Inhalt unverändert bleibt und als Quelle www.elwis.de angegeben wird."* | "www.elwis.de" | – | **Not recommended** (the content may not be altered) | – |
| **BE-1** | **Not an open licence.** English disclaimer: "intended for information and non-commercial purposes"; download "for personal use"; "The HIC reserve all intellectual property rights". The Dutch version says only "informatieve doeleinden". | **Compulsory.** EN: *"Flanders Hydraulics Research. Measurements and forecasts from the database of the Hydrological Information Centre [DATA]. [date of retrieval: dd/mm/jjjj]."* NL: *"Waterbouwkundig Laboratorium. Metingen en voorspellingen afkomstig uit de databank van het Hydrologisch InformatieCentrum [DATA]. [datum van bevraging: dd/mm/jjjj]."* | M | **First release if the User Agreement is signed in time**; otherwise later | Licence; credits; tidal series return null in the value layer; slow group calls (20–45 s); IDs and groups change without notice |
| **BE-2** | Modellicentie Gratis Hergebruik v1.0 (commercial reuse allowed, unlimited period) | **"Bron: VMM – waterinfo.vlaanderen.be (Modellicentie Gratis Hergebruik v1.0)"**. Generic alternative: "bevat overheidsinformatie, verkregen onder de modellicentie voor gratis hergebruik Vlaanderen v1.0" | M | **First release** (with a token; apply now) | Token and credits; relative vs absolute `Value`; group-level `getTimeseriesValues` on group 192780 fails with HTTP 500; empty threshold series |
| **BE-3** | Redistribution to the public forbidden without written consent (quoted in §0.2). Metawal: *"ne peut pas… publier les données sur Internet via un service web"*. Third-party claims of "CC BY 4.0" are UNVERIFIED and contradicted. | If permission is granted: **"Sources des données : Service public de Wallonie (SPW)"**, hyperlinked to https://hydrometrie.wallonie.be | M | **First release only with written permission**; otherwise link-out | Licence refusal; undocumented endpoint; weir-controlled stages; missing Meuse points (Heer-Agimont, Andenne, Monsin) |
| BE-4 | CC-BY 4.0 | Not specified in the report (CC BY 4.0 requires credit) | S | Optional (station geometry) | Only 33 sites |
| BE-5 | – | – | – | Not needed (the Flemish gauges downstream of Brussels cover the outflow) | – |
| **FR-1** | Licence Ouverte / Etalab 2.0 (CGU: *"…L'utilisateur de ces données doit néanmoins veiller à citer l'auteur des Jeux de données"*) | **"Données hydrométriques : Hub'Eau / SCV – réseau Vigicrues (PHyC), Licence Ouverte Etalab 2.0 – https://hubeau.eaufrance.fr/page/api-hydrometrie"**, plus the date of last update. Licence text: https://www.etalab.gouv.fr/licence-ouverte-open-licence/ | S | **First release** (the only French observation source) | 1-month window; raw data; HTTP 206; site-level duplicate Q; bad gauge-zero metadata; v1 was shut down 2025-05-05 (now 403) |
| FR-2 | As FR-1 | As FR-1 | S | Later (backfill) | Site codes inflate counts; no daily-mean H |
| FR-3 | Etalab 2.0 plus *"…que leurs sources (© VIGICRUES) et la date de leur dernière mise à jour soient mentionnées"* | **"Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0"**. **Do not use the logo** (INPI trademark no. 4151833). | S | Gap-fill only (outages of 30–60 days) | Beta, undocumented in places, redirects |
| **FR-4** | As FR-3 | As FR-3 | S | **First release** (event-driven) | Only during events (**correction** 2026-10-01 (#39): the national list is never empty (27–31 stations on 2026-09-29/10-01, none in A/B/D/E1–E3); NL-bound forecasts still only during events; FR-4 fetches only NL-bound stations); v1.1 uses local offsets; errors come back as HTTP 200 |
| **FR-5** | As FR-3 | As FR-3 | S | **First release** (tronçon vigilance colour as the French threshold class, attached to stations through each section's station list) | No per-station numeric thresholds; **no section covers the French Escaut, Scarpe or Deûle**; property casing differs between the 2023 and 2026 payloads |
| FR-6 | UNVERIFIED | – | – | Later (manual backfill, UNVERIFIED) | No API |
| **LU-1** | **CC0** (data.public.lu "Niveau d'eau", `cc-zero`) | Courtesy: **"Source: Administration de la gestion de l'eau (AGE), Luxembourg – inondations.lu; Moselle stations: Service de la navigation"** | S–M | **First release** | Labels 15 min late; local time without offset; empty `Number` column; mixed units; format changes (P5b: it changed on 2026-09-30, from 5 days and 480 labels with a trailing field to 7 days and 672 labels without one, and the labels are on time since: §2.6, C14) |
| LU-2 | Website CGU (Aspects légaux, 05.08.2026): *"Sauf indication contraire… aucune reproduction… n'est permise sans l'autorisation écrite préalable"* | As LU-1 | S | First release **once AGE confirms**; LU-1 until then | Undocumented; site relaunched Feb 2026; Remich 404 |
| LU-3 | As LU-2 | Credit AGE or LfU RLP per station | S | First release **once AGE confirms** (product requirement); link out until then | No issue time; no archive; Moselle floor values |
| LU-4 | As LU-2 | As LU-1 | M | First release **once AGE confirms** | HTML scraping; data errors |
| **LU-5** | CC BY: *"obligation d'indiquer la source de l'alerte, à savoir LU-Alert"* | **"LU-Alert"** | M | **First release** | Covers all senders (filter on `[AGE]`/`FLOOD`); test messages |
| LU-6 | CC0 | As LU-1 | S | **First release** (station geometry) | No measured values |
| LU-7 | UNVERIFIED | – | – | Later (backfill) | Formal request needed |
| **CH-1** | BAFU 2020 conditions: *"Freie Nutzung"*; *"Die Angabe der Quelle wird empfohlen"*. 2019 conditions §6: download *"nicht häufiger als alle 10 Minuten"*. | **"Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum)"**. Proposed EN: *"Swiss river data: Federal Office for the Environment FOEN, Hydrology Division (raw, unverified data; retrieved <date>)"*. NL: *"Zwitserse riviergegevens: Bundesamt für Umwelt BAFU, afdeling Hydrologie (ruwe, ongecontroleerde gegevens; opgehaald <datum>)"*. Disclaimer: *"In case of warnings, the Naturgefahrenbulletin on www.naturgefahren.ch is authoritative; forecasts are direct model output."* | M | **First release** (official live feed) | No history; cube marked `CreativeWorkStatus/Draft`; stale and duplicate stations |
| **CH-2** | BAFU terms | As CH-1 | S | **First release** (thresholds, 24 h stats, fault notices) | Undocumented; string values with units |
| CH-3 | BAFU terms | As CH-1 | S | One-off 40-day backfill at go-live | Undocumented; about 900 KB per station |
| **CH-4** | 2019 §8: forecasts *"dürfen frei verwendet werden"*. Explaining how to read them is recommended. Warnings on small and medium rivers are the cantons' responsibility. | As CH-1, plus a forecast explanation | S | **First release** | No run ID; undocumented |
| **CH-5** | BAFU terms | As CH-1 | S | **First release** | Undocumented; `ID` not unique across types in CH-6 |
| CH-6 | opendata.swiss "Open use" (source recommended) | As CH-1 | S | Optional cross-check | Classes only; `data.zip` stale since 2024-08-27 |
| CH-7 | STAC `license: proprietary`, linked to opendata.swiss "terms_by" (**source required**) | As CH-1 | S | Optional (metadata) | Static |
| CH-8 | Free since 2020 | As CH-1 | M | Later (backfill) | Time-zone conflict in the historical CSV |
| CH-9 | opendata.swiss "Open use" | Add **"Kanton Basel-Stadt, data.bs.ch"** | S | Later (history for 2289 and 2106) | Counter-intuitive field names (`pegel` vs `pegelhoehe`) |
| CH-10 | Not official | – | – | **Not recommended** | Third party; about 30 days only |
| CH-11 | – | – | – | Metadata only | 403 with a default User-Agent |
| Basemap | ODbL (OSM data) | **"© OpenStreetMap contributors"** linking to https://www.openstreetmap.org/copyright, plus "Protomaps". OpenFreeMap fallback: **"OpenFreeMap © OpenMapTiles Data from OpenStreetMap"**, exactly as in its TileJSON. | – | First release | See §5 |

---

## 2. Per-provider integration notes

Each subsection covers: endpoints with their parameters or bodies, units, datum, timestamp format and time zone, paging, the pitfalls observed, and a trimmed sample response. Everything is **[V]** unless marked otherwise.

### 2.1 NL-1 / NL-2: Rijkswaterstaat

**What is live and what is retired**
- `https://waterwebservices.rijkswaterstaat.nl/*` (the old `*_DBO` paths) is **retired**. Every path returns `301` to `https://rijkswaterstaatdata.nl/projecten/waterwebservices-overschakeling/`, and that page returns 404. RWS switched the old services off for good on 30 April 2026 ("definitief uitgezet").
- `https://geo.rijkswaterstaat.nl/services/ogc/hws/wmdc15/wms` is retired (404).
- Old 4-letter location codes (`LOBI`, `LOBH`) are replaced by dotted slugs (`lobith.bovenrijn.tolkamer`).
- The old grootheden `WATHTEVERWACHT`, `QVERWACHT` and `WATHTBRKD` no longer exist.
- The new API landing page reads "Welkom bij Wadar webservices". The OpenAPI spec reports `"version":"1.0","x-build-number":"2.64.2"`.
- The documentation site `rijkswaterstaatdata.nl` becomes the "Centraal Toegangspunt Data (CTD)" on **5 Nov 2026** (public beta ran 14–23 Sep). Re-read on 2026-09-23 [V]: *"Vanaf dat moment komt u via de vertrouwde link rijkswaterstaatdata.nl uit op het Centraal Toegangspunt Data"*, with introduction sessions from 9 Nov. The page says nothing about the `ddapi20-waterwebservices…` or `geo.rijkswaterstaat.nl` hosts, so an API host change is still UNVERIFIED (not announced). Links under `rijkswaterstaatdata.nl/publish/…` (NL-4) are at risk. Keep all base URLs in configuration and ask in GitHub Discussions (the discussions page returned 403 to the sandbox).
- Incident log (on https://rijkswaterstaatdata.nl/waterdata/):
  - 4–11 June 2026: no new measurements for about a week.
  - 12 June: a limit of 100,000 series per request was introduced.
  - 7 July: `OphalenLaatsteWaarnemingen` was limited to 50,000 series.
  - 22 July: a release caused Bad Requests and was rolled back.
  - 24 Aug: maintenance.

**REST basics (NL-1)**
- Method: `POST` with `Content-Type: application/json`.
- OpenAPI 3.1 spec: `GET /webservices-api-docs` (about 20 KB). Swagger UI at `/swagger-ui/index.html`, its config at `/webservices-api-docs/swagger-config`. `/v3/api-docs` returns 404.
- Endpoints:
  - `POST /METADATASERVICES/OphalenCatalogus`
  - `POST /ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`
  - `POST /ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen`
  - `POST /ONLINEWAARNEMINGENSERVICES/OphalenActueleWaarnemingen` (undocumented; returned `204` on all 7 attempts, so treat it as UNVERIFIED and unusable)
  - `POST /ONLINEWAARNEMINGENSERVICES/CheckWaarnemingenAanwezig`
- **Auth:** none. The optional header `X-API-KEY` "wordt gebruikt om requests aan de aanvrager te koppelen"; there is no registration process. Send a stable project value.
- **No CORS, no gzip.** Responses carry `Cache-Control: no-cache, no-store`. "No data" is `204` with an empty body.
- **Errors have inconsistent formats.** A bad date gives a plain-text `400`: `Het parsen van 'Begindatumtijd' is mislukt. Lever geldige waarden aan in het formaat 'yyyy-MM-dd'T'HH:mm:ss+01:00'`. An unknown location gives a JSON `400`: `{"location":"Locatie 'doesnotexist' niet gevonden. …"}`.
- **Key casing:** the schema says `aquoMetadata`, but `AquoMetadata` works and is what responses use.

**Aquo combinations to use**

| Purpose | Compartiment | Grootheid | Hoedanigheid | Eenheid | ProcesType | WaardeBepalingsMethode | Locations |
|---|---|---|---|---|---|---|---|
| Live river, inland or coastal level | `OW` | `WATHTE` | `NAP` | `cm` | `meting` | `other:F007` (mean over the previous 5 and next 5 minutes) | 416 |
| Level at some ONXXREG stations (Vecht, Twentekanaal, Pannerden) | OW | WATHTE | NAP | cm | meting | `other:F155` | 20 |
| Historic hourly or 10-min | OW | WATHTE | NAP | cm | meting | `other:F001` | 152 |
| Historic manual daily readings | OW | WATHTE | NAP | cm | meting | `other:F009` / `other:F029` | 207 / 103 |
| Belgian-datum duplicate (Meuse border) | OW | WATHTE | `TAW` | cm | meting | F007 | 8 |
| Offshore | OW | WATHTE | `MSL` | cm | meting | F007/F001/F046 | 17 |
| Local datum | OW | WATHTE | `PLAATSLR` | cm | meting | F007 | 22 |
| **Level forecast** | OW | WATHTE | NAP | cm | `verwachting` | `RWSM-F232` | 183 |
| Astronomical tide, 10-min | OW | WATHTE | NAP (MSL offshore) | cm | `astronomisch` | `other:F012` (`F227` at Knock) | 98 |
| Astronomical HW/LW | OW | WATHTE | NAP | cm | astronomisch | Groepering `GETETBRKD2` (`GETETBRKDMSL2`) | 95 |
| Measured HW/LW | OW | WATHTE | NAP | cm | meting | Groepering `GETETM2` (`GETETMSL2`) | 135 |
| **Live discharge** | `OW` | `Q` | `NVT` | `m3/s` | `meting` | Varies by station: `F230` (Lobith, Millingen, Pannerden), `F006` (Tiel, Olst, Westervoort.1, Borgharen), `F103` (Venlo, Megen, Sint Pieter, Ommen, Driel, Hagestein), `F216` (Eijsden), `F128` (ADCP), `F058`, `F007` | 199 |
| **Discharge forecast** | OW | Q | NVT | m3/s | verwachting | `RWSM-F232` | 13 |

- The 13 discharge-forecast locations are `arnhem.nederrijn`, `driel.boven`, `eijsden.grens`, `hagestein.boven`, `lobith.bovenrijn.tolkamer`, `maaseik`, `maastricht.borgharen.maas.beneden`, `maastricht.sintpieter`, `megen.maas`, `olst`, `tiel.sluis.waal`, `tiel.waal` and `venlo`.
- `Kwaliteitswaardecode`: Waterinfo shows `00`, `10`, `20`, `25`, `30` and `40`. **`99` = gap, served with the value `0.0`.** Code 31 is no longer issued and became 25. What 25 means is UNVERIFIED.
- `Statuswaarde` is `Ongecontroleerd` (live), `Gecontroleerd` or `Definitief`.
- `Referentievlak` is mostly `NVT`; ignore it and use `Hoedanigheid`.
- `Bemonsteringshoogte` sentinels: `"0"` (live), `"-999999999"` (archived), `-100000000000` (WFS).
- `OpdrachtgevendeInstantie` has 53 values, for example `RIKZMON_WAT`, `ONXXREG_WAT`/`_AFVOER`/`_HOOGWTR`, `LBXXREG_WAT`/`_AFVOER`, `RIZAMON_AFVOER`, `RIKZ_AFVOER`, `NBXX_INWAT` and `ZLXXREG_ZEGE`.
- **River and tidal stations cannot be told apart from metadata.** Tidal stations also have `astronomisch` and `GETET*` series. Keep a curated list.

**Catalogue (fetch daily, cache)**
```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus \
  -d '{"CatalogusFilter":{"Compartimenten":true,"Grootheden":true,"Hoedanigheden":true,"Eenheden":true,"Groeperingen":true,"ProcesTypes":true,"WaardeBepalingsmethoden":true}}'
```
- The full response is 4.86 MB and took 5.4 s; with only Compartimenten and Grootheden it is 1.6 MB in 2.9 s.
- It contains 2,499 locations, 1,502 AquoMetadata combinations and 61,870 links. Join them via `AquoMetadata_MessageID` and `Locatie_MessageID`.
- Counts: 663 locations with WATHTE meting, 199 with Q meting, 183 with WATHTE verwachting and 13 with Q verwachting.
- **There is no location or bbox filter.**
- Coordinates are ETRS89 (EPSG:4258) for all 2,499 locations; the OpenAPI example wrongly says "RD". They can be treated as WGS84 for display.
- An Excel version of the catalogue is announced as "nog niet beschikbaar".
```json
{"Succesvol":true,
 "AquoMetadataLijst":[{"AquoMetadata_MessageID":1405,"Compartiment":{"Code":"OW"},"Eenheid":{"Code":"cm"},
   "Grootheid":{"Code":"WATHTE"},"Hoedanigheid":{"Code":"NAP"},"ProcesType":"meting",
   "WaardeBepalingsMethode":{"Code":"other:F007"},"Parameter_Wat_Omschrijving":"Waterhoogte in Oppervlaktewater t.o.v. Normaal Amsterdams Peil in cm"}],
 "LocatieLijst":[{"Locatie_MessageID":10603,"Code":"4epetroleumhaven","Coordinatenstelsel":"ETRS89","Lat":51.953524,"Lon":4.140491,"Naam":"4e Petroleumhaven"}],
 "AquoMetadataLocatieLijst":[{"AquoMetaData_MessageID":1405,"Locatie_MessageID":…}],
 "ReferentievlakLijst":["","SPRONGLG","ONB","MSL","BODM","NAP","NVT","WATSGL","HALVWTKL"],
 "StatuswaardeLijst":["Ongecontroleerd","Gecontroleerd","Definitief"]}
```

**Time series (the core collector call)**
```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen \
  -d '{"Locatie":{"Code":"lobith.bovenrijn.tolkamer"},
       "AquoPlusWaarnemingMetadata":{"AquoMetadata":{"Compartiment":{"Code":"OW"},"Grootheid":{"Code":"WATHTE"},
                                                     "Hoedanigheid":{"Code":"NAP"},"ProcesType":"meting"}},
       "Periode":{"Begindatumtijd":"2026-09-23T19:30:00Z","Einddatumtijd":"2026-09-23T21:00:00Z"}}'
```
```json
{"Succesvol":true,"WaarnemingenLijst":[{"AquoMetadata":{"…":"WATHTE/NAP/F007"},"Locatie":{"Code":"lobith.bovenrijn.tolkamer"},
 "MetingenLijst":[
  {"Meetwaarde":{"Waarde_Numeriek":627.0},"Tijdstip":"2026-09-23T20:30:00.000+01:00","WaarnemingMetadata":{"Kwaliteitswaardecode":"00","Statuswaarde":"Ongecontroleerd"}},
  {"Meetwaarde":{"Waarde_Numeriek":628.0},"Tijdstip":"2026-09-23T20:40:00.000+01:00"}]}]}
```
- **One location per request** (`Locatie` is singular).
- **Always send both `ProcesType` and `Hoedanigheid`.** Without them, forecasts and TAW/MSL/PLAATSLR duplicates get mixed in.
- There is no pagination; page by splitting `Periode`. At most 160,000 values ("ca. 3 jaar aan 10-minuut gegevens") and 100,000 series per request. The error at the limit is UNVERIFIED.
- A value list is split into separate `WaarnemingenLijst` entries whenever metadata changes (method, status and so on). Concatenate them and sort by `Tijdstip`.
- A 5-hour window for one series is about 6 KB and takes about 0.6 s.
- **Discharge:** use `{"Grootheid":{"Code":"Q"},"ProcesType":"meting"}`. Do **not** filter on a single method code, because it differs per station.

**Forecasts and tide**
- Use `ProcesType: "verwachting"` (method `RWSM-F232`). Lobith Q requested at about 19:57Z returned 205 values at 10-minute steps from `2026-09-23T20:00+01:00` to `2026-09-25T06:00+01:00`, about 34 h, 60 KB.
- RWS says forecasts are recalculated "elke 6 uur" (UNVERIFIED) and advises fetching T−10 min to T+2 days. **Correction 2026-10-03 (P8a, [V] from the owner's D2 export of the production archive, made on 2026-10-03):** RWS issues **one run a day**, not one every 6 hours. A series' new run is first seen between 05:25 and 08:45 UTC (Lobith Q and H at 06:25, 05:25 and 06:25 UTC on 2026-10-01, 10-02 and 10-03), and every run ends at 05:00 UTC two days later. A capture starts 5 minutes before its fetch (its first point is the fetch time − 5 minutes on the 10-minute grid) and spans 23 to 48 h, so a capture is a run **without its leading values**: consecutive captures of one run are exact tails of each other (73 of 76 hourly transitions at Lobith, 21 or 22 of 25 in each 3-hour tier; the others are the run change), and a new run always ends later and differs on its overlap. Each capture was one `WaarnemingenLijst` (method `RWSM-F232`, units `cm` for H and `m3/s` for Q, quality code `00`; no split list was seen). The stale series return a 204 (two of the hourly run's series) and `alblasserdam/H` returns 288 values that are all code 99. A§7.4 item 9 has the identity this implies (captures that are tails of a stored run are that run).
- **The forecast archive keeps only one value per timestamp, with no run or issue time. Snapshot every run yourself.**
- Excerpt: `{"AquoMetadata":{"Grootheid":{"Code":"Q"},"ProcesType":"verwachting","WaardeBepalingsMethode":{"Code":"RWSM-F232"}},"MetingenLijst":[{"Tijdstip":"2026-09-25T06:00:00.000+01:00","Meetwaarde":{"Waarde_Numeriek":606.0}}]}`
- Astronomical tide: `ProcesType: "astronomisch"`, method `other:F012`, 10-minute steps. Vlissingen on 2026-12-31 gave `-104, -113, -121…` cm NAP. `CheckWaarnemingenAanwezig` returned true for 2027-06-01 and 2027-12-30 and false for 2028-06-01. HW/LW need `"Groepering":{"Code":"GETETBRKD2"}` (astronomical) or `GETETM2` (measured).
- The fan and ensemble charts on waterinfo (`api/chart/getfan`) are **not** in the public API (UNVERIFIED beyond the internal JS routes).

**`CheckWaarnemingenAanwezig`**: the body key is `AquoMetadataLijst`, and the answer is a string, e.g. `{"Succesvol":true,"WaarnemingenAanwezig":"true"}`.

**`OphalenLaatsteWaarnemingen`: do not use it in the core loop.**
- It returns the last value of **every series ever recorded**: 85 series for 6 stations (some last updated in 1876, 1934 or 1947), and 417 series (675 KB, 1.7 s) for 40 stations.
- It lags by 1–2 values. RWS acknowledged this in GitHub discussion #57; the fix promised for v2.64 is not effective.
- It ignores `ProcesType`.
- It showed two identical-looking Lobith Q F230 series with different last timestamps.
- If you must use it: keep the newest `Tijdstip` per (location, Grootheid, Hoedanigheid) and filter out `Kwaliteitswaardecode = "99"`.

**Timestamps**
- REST **output** is always ISO-8601 with milliseconds and a **fixed `+01:00`** all year. `2026-09-23T20:50:00.000+01:00` is 19:50Z, which is 21:50 CEST. There is no DST ambiguity.
- REST **input** accepts `Z` or any offset.

**Latency:** REST had 19:50Z at 20:10:06Z (about 20 min). The WFS is about 10 min further behind. Eijsden Q (F216) is about 75 min late.

**WFS (NL-2): the one-call snapshot of every NL station**
```
GET https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature
  &TYPENAMES=DDAPI20:locatiesmetlaatstewaarneming&outputFormat=application/json
  &CQL_FILTER=COMPARTIMENTCODE='OW' AND GROOTHEIDCODE IN ('WATHTE','Q') AND TIJDSTIP_LAATSTE_METING > '2026-09-23T12:00'
  &PROPERTYNAME=CODE,NAAM,GROOTHEIDCODE,HOEDANIGHEIDCODE,EENHEIDCODE,WAARDEBEPALINGSMETHODECODE,WAARDE_LAATSTE_METING,
                TIJDSTIP_LAATSTE_METING,BEMONSTERINGSHOOGTE,OPDRACHTGEVENDE_INSTANTIE,KWALITEITSWAARDE_CODE,GEOMETRY
```
- URL-encode the CQL. The call returned 438 features (319 WATHTE locations and 109 Q locations), 235 KB uncompressed, in 1.1 s. `numberMatched` was 312 for WATHTE/NAP.
- **Include `GEOMETRY` in `PROPERTYNAME`**, or geometry comes back null.
- Paging with `count=`, `startIndex=` and `sortBy=CODE` works.
- GetCapabilities (`?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities`) is 95 KB. WMS 1.3.0 has the layers `locaties` and `locatiesmetlaatstewaarneming`.
- Layers:
  - `DDAPI20:locaties`: 19,003 features.
  - `DDAPI20:locatiesmetlaatstewaarneming`: **941,735 features. Always filter.**
- Output formats: `application/json`, `csv` (with `format_options=csvseparator:semicolon`), `SHAPE-ZIP`, `KML` and GML2/3/3.2.
- CRS: default `urn:ogc:def:crs:EPSG::4258`. Also 28992, 4326, 3857, 25831, 25832, 31370, 32631, 32632, 23031, 28402, 900913 and 3395.
```json
{"type":"FeatureCollection","numberMatched":45,"numberReturned":45,"crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::4258"}},
 "features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[6.1024,51.8495]},
  "properties":{"CODE":"lobith.bovenrijn.tolkamer","NAAM":"Lobith, Bovenrijn, Tolkamer","GROOTHEIDCODE":"WATHTE","HOEDANIGHEIDCODE":"NAP",
   "EENHEIDCODE":"cm","WAARDEBEPALINGSMETHODECODE":"other:F007","WAARDE_LAATSTE_METING":627,
   "TIJDSTIP_LAATSTE_METING":"2026-09-23T21:30:00.000Z","KWALITEITSWAARDE_CODE":"00","OPDRACHTGEVENDE_INSTANTIE":"RIKZMON_WAT",
   "STATUSWAARDE":"Ongecontroleerd","BEMONSTERINGSHOOGTE":0}}]}
```

**WFS pitfalls**
1. **`TIJDSTIP_LAATSTE_METING` is Europe/Amsterdam wall-clock time labelled `Z`.** REST 20:30+01:00 (19:30Z) appeared as `21:30:00.000Z`. Parse it as local time, ignore the `Z`, and expect ambiguity in the October fall-back hour. The collection-level `timeStamp` is correct.
2. **An old value can appear with a fresh timestamp.** `driel.boven` Q showed 10.19 m³/s at "21:30Z" with quality `00`, while REST had `0.0` with code `99`. The last real 10.19 value was from 2026-07-28. **REST wins.**
3. Axis order: GeoJSON is `[lon, lat]`; CSV/WKT is `POINT (lat lon)`.
4. Stale and duplicate series are included. Filter on time, on `HOEDANIGHEIDCODE IN ('NAP','NVT')` and on method.
5. `pannerden.regelwerk.boven`/`.beneden` (F155, `ONXXREG_HOOGWTR`) read 1139–1143 cm NAP while the river next to them was at 600 cm. **Exclude them** (probably structure-internal).

**History (backfill phase):** Lobith has 1901-01-01..04 daily at 08:40 (F029, 1123 cm); hourly in 1990 (F001); hourly on 1995-01-31 under F007 (1655 cm, the flood peak). `CheckWaarnemingenAanwezig` was true for 1995, 2005 and 2010. Where true 10-minute resolution starts is UNVERIFIED per station. The alternative bulk route is Waterinfo "Download historische data" (CSV by e-mail, also 160k limit). GitHub discussion #58 "Bulk historische data" is unanswered.

**Support:** the "Servicedesk Data" contact form and https://github.com/Rijkswaterstaat/WaterWebservices/discussions (RWS staff reply, e.g. #57; see also #42 on transition issues). Community clients: Deltares `ddlpy`, PyPI `rws-waterinfo`, R `wstolte/rwsapi` (currency with the new API UNVERIFIED).

**NL-3 (reference only):** `GET https://waterinfo.rws.nl/api/point/latestmeasurement?parameterId=waterhoogte` (220 KB). It uses EPSG:3857 coordinates and correct UTC. Example: `{"locationCode":"shertogenbosch.crevecoeur","latestValue":37.0,"dateTime":"2026-09-23T19:20:00Z","unitCode":"cm","qualityCode":"NAP","measurementColor":"#39870C","measurementLabel":"Normale waterstand"}`. The parameterId `waterhoogte-t-o-v-nap` returned 213 KB with class counts "Normale waterstand" 210, "Verlaagde waterstand" 23, "Geen klasse-indeling" 66, and `possiblyFaulty` true 5 times.

**NL-4 Waterinfo legend classes (`grenswaarden-en-legendakleuren-…-15-4-2026-.xlsx`) — parser specification** [V] (re-checked 2026-09-23; corrects the earlier description)
- **What it is:** the legend classes that waterinfo.rws.nl uses to colour values. They are **display classes, not alert or warning levels**. The `Uitleg` sheet: *"Deze export is d.d. 15-4-2026 gemaakt uit het beheersysteem. Deze items zijn continue onderhevig aan verbeteringen, hier kunnen geen rechten aan worden ontleend."* and *"Dit document zal eens per kwartaal geupdated worden"*. On 2026-09-23 the waterdata page still links only the 15-4-2026 edition, so the quarterly promise has not been kept; detect new editions automatically (weekly fetch of the page, alert on a new file name).
- **Sheets:** `Uitleg` (33 rows) and `ParameterLimits` (6,245 rows; columns `Code, Name, Slug, Description, Period, FromMonth, FromDay, ToMonth, ToDay, Label, From, To, Order, Priority, Color, HardColor, SoftColor`). `'NULL'` is a string.
- **Content:** H in cm NAP ("Waterhoogte in Oppervlaktewater t.o.v. Normaal Amsterdams Peil in cm") 5,722 rows for **237 location codes** (plus an area-wide `alle*` default); Q ("Debiet in Oppervlaktewater in m3/s") 480 rows for **27 codes** (plus `alle*`); plus area-wide legends (`Code = 'alle*'`) for chloride, temperature, wind and waves.
- **Periods:** `Gehele jaar` (5,637 rows) plus seasonal or monthly periods (`Mei` … `September`, `Winterstand`/`Zomerstand`, `IJsselmeerWinter`/`Zomer`, `VeerseMeer*`, `Grevelingen_*`, `Haringvliet_*`, `Droogteseizoen_overig` …). **The effective legend for a date is the union of the `Gehele jaar` rows and the rows whose FromMonth/FromDay–ToMonth/ToDay window contains the date.** Example, Lobith Q: `Gehele jaar` gives Licht verhoogd > 4,450, Verhoogd > 5,400, Hoog > 8,100, Extreem > 11,800 m³/s; the monthly rows give the Normaal/Verlaagd boundary: 1,400 (May), 1,300 (June), 1,200 (July), 1,100 (August), 1,000 (September).
- **Priority:** the explanation says the item with the "highest priority" wins in aggregations (e.g. "verhoogde" beats "normale"). In the data Extreem has 0 and Normaal 5, so **lower number = higher priority**. Values seen: 0–5, 10, 27, 39.
- **Slug variants:** most codes appear with several `Slug` values (e.g. `Aadorp(AADP)`, `-1`, `-2`, `-3`; up to 14 per code). The rows are otherwise identical: **deduplicate on (Code, Description, Period, Label, From, To)**: 6,245 rows collapse to 1,542.
- **Labels embed the bound and vary in wording:** "Licht verhoogd (>200cm)", "Verhoogde waterstand (> 220cm)", "Hoogwater (1225cm)", "Streefpeil (-40cm)", "Stormvloed (> 280cm)", "Normaal (1000 - 4450m3/s)". Take the bounds from `From`/`To`, not from the label, and map labels to the common scale by stem (§4.9).
- **Coverage of the curated NL list** (live series on 2026-09-23): **49 of 54 H series** and **14 of 18 Q series** have classes (against the series P1 captures on 2026-09-30: 61 of 69 H and 15 of 18 Q; PHASES §14). Missing H: `millingenaanderijn.pannerdensekop`, `holtheme.vecht`, `lith.beneden`, `lixhebiefaval`, `antwerpen`. Missing Q: `millingenaanderijn`, `hagestein.boven`, `maastricht.sintpieter.zuid`, `roermond.hambeek`. These stay `no-ref` unless another source gives a class.
- **URL risk:** from **5 Nov 2026** `rijkswaterstaatdata.nl` becomes the "Centraal Toegangspunt Data" (§2.1). The `/publish/pages/223004/…xlsx` path may break then. Keep a local copy, keep the URL in configuration, and alert on a 404.
- **Official NL warning phases:** WMCN issues river status bulletins as PDFs, with the colour in the file name (e.g. `https://waterberichtgeving.rws.nl/data/400-500-statusbericht_rijn_s01_geel_20250111.pdf`, HTTP 200). The Rhine warning service starts when Lobith reaches 14.00 m NAP and a rise above 15.00 m is expected (IKSR page "RWS WMCN Lelystad", via a search summary; not opened). The WMCN site (`waterberichtgeving.rws.nl/owb/`) is an Angular app behind Keycloak; no open machine-readable warning phase was found. Whether the NL-4 classes correspond to WMCN phases is UNVERIFIED (ask the Servicedesk Data).

**NL-5 WRIJ Nexus (not recommended without consent)**
- 3,622 points. `WS_THEME` values include `Waterstanden_539` (150), `Afvoeren_534` (81), `Waterstanden_rivier_539`, `Afvoeren_verw_534` and `Waterstandsverw_539`.
- Fields: `EVENT_VALUE` (m NAP or m³/s) and `EVENT_TIMESTAMP` (epoch ms). Coordinates are RD New; `outSR=4326` works.
- Examples: `175_BOV` Verdeelwerk Haarlo (Berkel), `28_BOV` Verdeelwerk Lochem (Berkel), `101_TDB` Stuw De Pol (Oude IJssel), Q 0.191 m³/s.

**Water boards (NL-6):**
- Vechtstromen shows levels only in news items and a HydroNET embed. Its ArcGIS Online account `services1.arcgis.com/3RkP6F5u2r7jKHC9` has structures but no measurement feed.
- Waterschap Limburg's `https://www.waterstandlimburg.nl` (e.g. `/Home/Waterstanden/147` Roer Vlodrop, `/LocatieInfo/ONIER06_H` Niers) returned 403; possibly a WAF or geo-block (UNVERIFIED). Lizard lists the board with 0 public time series.
- Hunze en Aa's (Westerwoldse Aa) was not researched.
- The Digitale Delta API (DD-API v3, IHW) won the "Gouden API 2026" on 21 Sep 2026, but no public DD-API endpoint serves water-board water-quantity data.

### 2.2 DE-1 to DE-5: PEGELONLINE (WSV/ITZBund) and BfG

**General behaviour**
- Headers: `Cache-Control: max-age=44` (stations) or `max-age=19` (currentmeasurement), `Expires`, `ETag`. **`If-None-Match` gives 304.** gzip is supported.
- A load-balancer cookie is set but not needed.
- Errors are JSON: `{"status":400,"message":"Given start parameter is neither a valid ISO date time, nor an ISO period."}` and `{"status":404,"message":"Timeseries does not exist."}`.
- `prettyprint=false` gives compact JSON.
- Incompatible changes get a new URL [D].
- Sizes: all 786 stations with time series and current values are 70 KB gzipped (about 1.0 s). The relevant waters with W and Q only are about 16 KB gzipped. `stations.json?timeseries=W&includeTimeseries=true&includeCurrentMeasurement=true` is 622 KB raw and 57 KB gzipped.

**Stations: `GET /stations.json`**
- 786 stations on 102 waters: 737 with W, 94 with Q, 43 with WV. 211 stations sit on the relevant waters.
- Tested parameters:
  - `waters=RHEIN` / `MOSEL,SAAR` (case-insensitive list) → 36 / 51 stations.
  - `ids=`.
  - `latitude`/`longitude`/`radius` (km).
  - `km` + `radius` with `waters`: `waters=RHEIN&km=850&radius=20` returns Rees 837.4, Emmerich 851.9, Lobith 862 and Pannerdense Kop 867.3.
  - `fuzzyId` is a **fuzzy name search** ("niers" matches NIERSTEIN), so never use it to match a station.
  - `limit`/`offset`.
  - `hasTimeseries=Q` (17 Rhine stations); `timeseries=Q`.
  - `includeTimeseries`, `includeCurrentMeasurement`, `includeCharacteristicValues`.
  - `includeForecastTimeseries=true&hasTimeseries=WV` → 43 stations.
  - `includeTrmTimeseries=true&hasTimeseries=TRM` → 120 stations.
  - **`bbox` is silently ignored** (all 786 come back).
- `/stations/{id}.json` accepts a UUID, a number or a shortname (`/stations/9598e4cb-0849-401e-bba0-689234b27644.json`, `/stations/2790020.json`, `/stations/EMMERICH.json`). **The UUID is the stable key** ("unveränderlich").
- `GET /waters.json` → 102 waters; `?ids=RHEIN&includeStations=true` works.
- Relevant waters: `RHEIN`, `MOSEL`, `SAAR`, `MAIN`, `NECKAR`, `LAHN`, `RUHR`, `EMS`, `DEK`, `WDK`, `RHK`, `DHK`, and the Dutch-side `WAAL`, `IJSSEL`, `LEK`, `ALTE_MAAS`, `NEUE_MAAS`. There is **no** MAAS, RUR, NIERS or VECHTE.

**Recommended collector call** (every 15 min at hh:02, :17, :32 and :47, with gzip and `If-None-Match`; about 16 KB, one request):
```
GET https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?waters=RHEIN,MOSEL,SAAR,MAIN,NECKAR,LAHN,RUHR,EMS,DEK&includeTimeseries=true&includeCurrentMeasurement=true&timeseries=W,Q&prettyprint=false
```
Gap filler (hourly and after any outage): `GET …/stations/{uuid}/{W|Q}/measurements.json?start=PT6H` (up to `P30D`).

**Station, time series, characteristic values and gauge zero (KÖLN, trimmed)**
```json
{"uuid":"a6ee8177-107b-47dd-bcfd-30960ccc6e9c","number":"2730010","shortname":"KÖLN","km":688.0,"agency":"STANDORT KÖLN",
 "longitude":6.9633,"latitude":50.936949,"water":{"shortname":"RHEIN","longname":"RHEIN"},
 "timeseries":[
  {"shortname":"Q","longname":"ABFLUSS_ROHDATEN","unit":"m³/s","equidistance":15,
   "currentMeasurement":{"timestamp":"2026-09-23T21:30:00+02:00","value":586.0},"characteristicValues":[]},
  {"shortname":"W","longname":"WASSERSTAND ROHDATEN","unit":"cm","equidistance":15,
   "currentMeasurement":{"timestamp":"2026-09-23T21:45:00+02:00","value":53.0,"stateMnwMhw":"low","stateNswHsw":"normal"},
   "gaugeZero":{"unit":"m. ü. NHN","value":35.038,"validFrom":"2019-11-01"},
   "characteristicValues":[
    {"shortname":"GlW","unit":"cm","value":139.0,"validFrom":"2023-01-01"},
    {"shortname":"HHW","unit":"cm","value":1069.0,"occurrences":["1926-01-01"]},
    {"shortname":"NNW","unit":"cm","value":69.0,"occurrences":["2018-10-23"]},
    {"shortname":"MNW","unit":"cm","value":114.0,"timespanStart":"2010-11-01","timespanEnd":"2020-10-31"},
    {"shortname":"MW","unit":"cm","value":297.0,"timespanStart":"2010-11-01","timespanEnd":"2020-10-31"},
    {"shortname":"MHW","unit":"cm","value":725.0,"timespanStart":"2010-11-01","timespanEnd":"2020-10-31"},
    {"shortname":"HSW","unit":"cm","value":830.0,"validFrom":"1950-01-01"},
    {"shortname":"M_I","value":620.0},{"shortname":"M_II","value":830.0}]}]}
```
- **Characteristic values** seen: GlW, TuGLW, M_I, M_II, HHW, NNW, MNW, MW, MHW and HSW; datum-arch also names Marke III and tidal values such as MThw. They come in three shapes (`validFrom`, `occurrences`, `timespanStart`/`End`).
  - They exist **for W only**. There is no MQ, MNQ or MHQ.
  - Coverage across 737 W series: MW 383, MNW 376, MHW 375, HHW 325, HSW 127.
  - None exist for the RWS mirrors, the tidal Ems, Mannheim-Neckar or Hattingen.
  - (P7a, 2026-10-03: the shortnames `NW` ("Niedrigster Tageswasserstand") and `HW` ("Höchster Momentanwasserstand") also occur, with a period and an occurrence date, for example Kaub NW 25 (2010-11-01..2020-10-31, 2018-10-22) and HW 719 (2013-06-05); they are the lowest and highest value of the period, not NNW and HHW (C22). In the recorded metadata 572 characteristic values on 198 W series are stored as references; `TuGLW` is a fairway depth, not a level, and is not stored. Five values carry a `validFrom` in the year 0007, stored without a start. Partial occurrence dates ("1953-04", "2002") are kept verbatim in the basis label.)
- **`stateMnwMhw`** is `low` (W ≤ MNW), `normal` or `high` (W ≥ MHW), and can also be `unknown`, `commented` or `out-dated`. Across 737 series: unknown 356, normal 219, low 156, out-dated 3, commented 3. `stateNswHsw` is `unknown` for 605. **Q has no state fields.**
- **Comments** explain gaps. Examples: Emmerich Q *"Abflussermittlung unter W = -1cm aktuell nicht möglich"*; Heidelberg UP Q *"…unter W=221cm nicht möglich"*; Rheinweiler Q *"Abflusswerte im niedrigen Bereich nicht plausibel"*; Mehring AMS W *"Techn. Störung"*.
- Per series: `GET …/stations/{uuid}/W.json?includeCurrentMeasurement=true&includeCharacteristicValues=true`. For Emmerich this gave gaugeZero 7.998 m ü. NHN (validFrom 2019-11-01), NNW −1 cm (2022-08-18), MNW 51, MW 239, MHW 669, HSW 870, HHW 986 (1926-01-03).

**Measurements: `GET /stations/{uuid}/{ts}/measurements.json` (also `.csv`, `.png`)**

| Call (Emmerich W) | Result |
|---|---|
| no parameters | 960 points, **10-day default** |
| `start=P31D` | 2,976 points |
| `start=P60D` | **Silently truncated** to 3,059 points starting 2026-08-23T01:15 |
| `start=2026-07-01T00:00:00%2B02:00&end=…` | `[]` with HTTP 200 |
| `start=…&end=…` over one hour | 5 points: **both ends inclusive** |
| `start=…Z` | Accepted |
| `start=2026-09-20` | Local midnight |
| `start=PT1H` | Last hour |
| `start=yesterday` | 400 |

- Encode `+` as `%2B`.
- The CSV is `timestamp;value` with **no offset**, e.g. `2026-09-23 21:15;-7`.
- PNG: `measurements.png?start=P7D&width=600&height=300`.
- Sample: `[{"timestamp":"2026-09-20T00:00:00+02:00","value":-4.0},…]`.
- Whether raw values get revised within the 31 days is UNVERIFIED (no change was seen over 8 minutes).

**Cadence and latency**
- The 22:00 CEST value was in `measurements.json` by 22:02:13. `currentmeasurement.json` showed it by 22:02:23 (server caching).
- Median age of current W across all series was 5 min. 8 series were more than 2 h old and 3 more than 24 h (including Mülheim Schlossbrücke, stale since 2026-09-05).
- Q: 20 of 94 series were more than 2 h old, including Emmerich (4 days), Heidelberg UP (26 days), Diez Hafen (8 days) and Frankfurt Osthafen (2.6 h).

**Forecasts (DE-2)**
- `WV` exists for 7 Rhine gauges: OESTRICH `665be0fe-…`, KAUB `1d26e504-…`, KOBLENZ `4c7d796a-…`, KÖLN `a6ee8177-…`, DÜSSELDORF `8f7e5f92-…`, DUISBURG-RUHRORT `c0f51e35-…` and EMMERICH `9598e4cb-…`.
- There is none for Maxau, Speyer, Mannheim, Worms, Mainz, the Mosel, Main, Neckar, Saar, Lahn or Ems. Mainz returns `404 {"message":"Timeseries does not exist."}`.
```json
{"shortname":"WV","longname":"WASSERSTANDVORHERSAGE","unit":"cm","equidistance":120,
 "start":"2026-09-23T07:00:00+02:00","end":"2026-09-27T07:00:00+02:00",
 "comment":{"shortDescription":"nwv-bfg","longDescription":"Vorhersagen und Abschätzungen vom: 23.09.2026 um 07:00 Uhr, Quelle: Bundesanstalt für Gewässerkunde. …"}}
GET …/stations/1d26e504-7f9e-480a-b52c-5932be6549ab/WV/measurements.json → 49 points
{"initialized":"2026-09-23T07:00:00+02:00","timestamp":"2026-09-23T07:00:00+02:00","value":13.0,"type":"forecast"}
{"initialized":"2026-09-23T07:00:00+02:00","timestamp":"2026-09-27T07:00:00+02:00","value":6.0,"type":"estimate"}
```
- Each run has 25 `forecast` points (0–48 h) and 24 `estimate` points (48–96 h). `initialized` is the run ID. **Only the latest run is served.**
- The CSV has `percentile10…percentile90` columns, which were empty for Kaub.
- Schedule [D] (BfG "Vorhersagen" page, re-read 2026-09-23): *"Die Vorhersage erfolgt werktäglich für die sieben Rheinpegel …"*; *"Fällt der Wasserstand am Pegel Ruhrort unter die Marke von 4 Metern, wird die Vorhersage auch an Wochenenden und Feiertagen berechnet."* So at normal and high water there is no weekend run.
- (P8a, 2026-10-03, [V] from the owner's D2 export of the production archive:) **one run a day**, `initialized` 07:00 local (`+02:00` in summer time), first archived by the 07:12 UTC fetch, **also on Saturday 2026-10-03, a public holiday**: consistent with the rule above, because Ruhrort stood far below 4 m (137 cm on 2026-09-23, the table of §3.1). The 49 points are 25 `forecast` (0–48 h) and 24 `estimate` (beyond 48 h, up to 96 h), 2-hourly, with offsets `+02:00`, no null and no `99999`; `type` is `estimate` exactly when the point is later than `initialized` + 48 h, on every point seen; all points of a payload state one `initialized`.
- Flood behaviour: BfG hides its **14-day** forecast above HSW (Marke II), *"ab der die Schifffahrt eingestellt wird"*, because *"die Zuständigkeit für die Hochwasservorhersage liegt, auch an den Bundeswasserstraßen, bei den Bundesländern"*. Whether `WV` is also capped or stopped above HSW is **UNVERIFIED**; ask vorhersage@bafg.de (§0.4).
- Official flood forecasts come from the state flood centres, not BfG. BfG: *"Bei Hochwasser stellen die … Hochwasservorhersage- und -meldezentralen der Bundesländer bereitgestellten Vorhersagen die aktuelle, amtliche Information"*.

**BfG CSVs (DE-3)**
- 14-day files, for example `Kaub_Quantile_25700100.csv`, `Oestrich_Quantile_25100300.csv`, `Koblenz_Quantile_25900700.csv`, `Koeln_Quantile_2730010.csv`, `Duesseldorf_Quantile_2750010.csv`, `Duisburg-Ruhrort_Quantile_2770010.csv` and `Emmerich_Quantile_2790020.csv`:
```
# Probabilistische Wasserstandsvorhersage vom 2026-09-23 GMT+1
# Quelle: Bundesanstalt fuer Gewaesserkunde <vorhersage@bafg.de>
# Keine Veroeffentlichung von Werten > 640 cm (Wert '---')
# !!!! Zeitstempel Beginn des Zeitschritts !!!!
Datum;5%;10%;20%;25%;30%;40%;50%;60%;70%;75%;80%;90%;95%
23.09.2026 00:00;9;10;10;10;10;10;10;10;11;11;11;11;11
```
- 6-week files cover Maxau and Worms (W) and Kaub, Köln and Duisburg-Ruhrort (W and Q), for example `Rhein-Kaub_6Wochen_Abfluss_QuansBox.csv` (issued 2026-09-21).

**HyDAS beta (DE-4):** `https://pegelonline.wsv.de/api/v1/stations?ids=…`, `/stations/{id}/parameters`, `/stations/{id}/parameters/{W|Q}/values?from=&to=`. The bare `/api/v1` returns 400 "Required header 'X-API-SECRET' is not present"; the sub-paths work without a key. History is about 31 days (`"start":"2026-08-23T01:00:00+02:00"`). Extras: `riverLocation.stationingOrigin` (`source`/`mouth`), `state` (e.g. `DE-NW`) and `operatorUrl`. Stations without coordinates in REST v2 also lack them here (e.g. Trier OP). Responses carry `meta` with `"licenseName":"DL-DE->Zero-2.0","licenseUrl":"https://www.govdata.de/dl-de/zero-2-0"`.

**History form (DE-5):**
```
1) GET  https://pegelonline.wsv.de/gast/stammdaten?pegelnr=2790020        (sets the cookie)
2) POST https://pegelonline.wsv.de/gast/historische-zeitreihen/prepare-download
        uuid=9598e4cb-…&parameter=WASSERSTAND ROHDATEN&start=2020-01-01T00:00:00+01&end=2020-01-01T02:00:00+01&format=json|csv
   → 303 Location: /gast/historische-zeitreihen/download?filename=pegelonline-emmerich-W-20200101-20200101.zip-<token>
3) GET  that Location with the same cookie → 200 application/zip
   (data file + nutzungsbedingungen.txt + zeitreiheninformation.txt: station_number=2790020 … timeseries_unit=cm timeseries_equidistance=15 quality=unchecked)
```
- The Q download uses `parameter=ABFLUSS ROHDATEN` (not tested).
- Daily files at `https://pegelonline.wsv.de/webservices/files/<Parameter>/<WATER>/<uuid>/<date>/down.txt` cover 31 days in **CET all year** (UNVERIFIED, not fetched).
- WMS, WFS and SOS exist but were not called (UNVERIFIED).
- Validated yearbooks exist as PDFs at dgj.de (UNVERIFIED).

**Units and datum**
- W is in cm above the gauge zero (PNP). de-pegelonline counted 683 such series; datum-arch counted 668.
- Some series are absolute in **`m+NN`**: 54 per de-pegelonline, 67 per datum-arch. They include all DEK/RHK/WDK/DHK canals, Ruhrwehr OW, Schlossbrücke Mülheim, MLK and ESK. 2 series are in `m+PNP`. **Always branch on `unit`.**
- Q is in m³/s. The longname is `ABFLUSS_ROHDATEN`, or `ABFLUSS` on the Main.
- Other series: WT, LT, O2, PH, LF, DFH, VA, WG and WR.
- Absolute height: `H [m NHN] = gaugeZero.value + W/100`, applied **only** when `gaugeZero.unit` is "m. ü. NHN" and the W unit is `cm`. Examples: Köln 35.038 + 0.53 = 35.57 m NHN; Emmerich 7.998 − 0.07 = 7.93 m NHN.
- Gauge-zero datums: "m. ü. NHN" 593; no `gaugeZero` 95 (including all 10 RWS mirrors, Konstanz-Rhein, Mehring AMS, Stadtbredimus UP, Herbrum Hafendamm, Rhede and Versen Trennspitze); "m. ü. NN" 40 (for example Lingen-Darme 14.98, valid from 2001-10-16); "m ü. A." 8; "mü.M." 1 (**Basel-Rheinhalle 240.0, Swiss LN02**).
- `validFrom` 2019-11-01 on the Rhine was a datum relabelling: there is no jump in W at Emmerich (150 → 150 cm). **Only the current PNP is exposed.**
- The RWS mirrors (Lobith 628, Nijmegen Haven 436, Krimpen −25, Rotterdam −28) look like cm NAP (inferred, UNVERIFIED). They use placeholder numbers (`123456781`…`123456786`, `852369741`) and have a 10-min interval. **Sentinel `99999.0`** appeared 16 times in 30 days at Lobith (for example 2026-09-09T10:10+02:00).
- Tidal Ems: Papenburg and Leerort have PNP −5.06 and −5.04 m NHN. Herbrum Hafendamm (568 cm) and Rhede (580 cm) have no PNP, probably also NHN−5 m (UNVERIFIED).

**River km and direction**
- `km` exists for 784 of 786 stations; VERSEN WEHR OP has `km=None`.
- The **Rhine counts up downstream** (Konstanz 0.5 → Pannerdense Kop 867.3).
- **Mosel, Saar, Main and Neckar count up from the mouth** (Perl 241.8, Koblenz 1.3).
- The Lahn counts up downstream (Marburg −38.7 … Lahnstein 136).
- The Ruhr's federal km count up upstream (Ruhrwehr 2.96, Mülheim 12.18), but HyDAS says `source` for Hattingen, which looks wrong.
- The Ems has two systems: upper Ems/DEK km 96–235 (Wachendorf 96.7 … Versen Wehrdurchstich 234.8), then the tidal lower Ems restarts at Papenburg km 0.39 → Emshörn km 74.3.
- Rhine confluences: Neckar at Mannheim about km 428, Main at Mainz about 497, Lahn at Lahnstein about 585, Mosel at Koblenz about 592, Ruhr at Duisburg about 780, Lippe/WDK at Wesel about 814.
- **35 of the 211 basin stations have no coordinates**: mostly Mosel, Saar and Neckar lock OP/UP gauges, plus Dordrecht, Rotterdam, Krimpen, Zaltbommel, Vuren and IJsselkop.

**Station inventory in the relevant basins**

| Water | Stations | with W | with Q | without coordinates | Note |
|---|---|---|---|---|---|
| RHEIN | 36 | 36 | 17 | 0 | Includes CH Basel (BAFU), Konstanz (RP Freiburg) and 2 RWS stations |
| MOSEL | 30 | 28 | 3 | 4 | Impounded; LU border stretch Perl → Grevenmacher |
| SAAR | 21 | 21 | 3 | 11 | Hanweiler at the FR border |
| MAIN | 16 | 13 | 7 | 0 | |
| NECKAR | 43 | 43 | 6 | 13 | Lock UP gauges |
| LAHN | 26 | 26 | 4 | 1 | |
| RUHR | 3 | 3 | 1 | 0 | |
| EMS | 17 | 17 | **0** | 0 | |
| DEK | 11 | 11 | 0 | 0 | Includes Herbrum Hafendamm and Rhede |
| WAAL / IJSSEL / LEK / ALTE_MAAS / NEUE_MAAS | 4/1/1/1/1 | all | 0 | 6 total | RWS mirrors |
| **Total** | **211** | | | **35** | |

**Pitfalls, in summary:** 31-day retention; `bbox` ignored; mixed units and datums; negative W is normal; Q goes stale or stops; no Q state flags; missing coordinates and km; km direction varies; impounded lock gauges barely move; tidal gauges oscillate; CSV without offset; `fuzzyId` is fuzzy; `WV` latest-only; `currentmeasurement` lags up to about 1 min; gauge-zero history is not exposed; new UUIDs appear when a gauge is rebuilt ("Leun neu", "Kalkofen neu", "Wieblingen Wehr UP neu").

### 2.3 DE-6 to DE-17: German state services

**DE-6 LHP PublicAPI**
- Docs: https://www.hochwasserzentralen.de/developers/ and `/developers/api-docs`. OpenAPI: `https://www.hochwasserzentralen.de/developers/docs/lhp-public-api_v1.20240123.yaml` (the spec version string is `1.0_beta_2025_01-23`; responses report `apiVersion: "1.0 beta, 2025-02-04"`).
- Servers: `https://api.hochwasserzentralen.de/public/v1` (live) and `…/public/v1/test` (fixed test data).
- Endpoints:
  - `GET /data/stations`: parameters `format` (json/geojson), `states` (BB, BE, BW, BY, HE, HB, HH, MV, NI, NW, RP, SH, SL, SN, ST, TH) and `lang`.
  - `GET /data/alerts`.
  - `GET /images/logo` (`Accept: image/svg+xml`).
- *"Nicht bereitgestellt werden Messwerte wie Wasserstand oder Abfluss."*
- Station counts for the seven basin states (research run): BY 243, RP 180, BW 179, HE 163, NW 137, NI 100, SL 24. **All states, gap check (21:20Z):** 1,590 features: BY 243, MV 206, RP 181, BW 179, HE 164, NW 137, SH 105, SN 104, NI 100, TH 55, ST 47, BB 37, SL 24, HB 6, BE 2.
- **Class-less features:** 216 features have **no `lhpClass` key at all** (not `null`): MV 180, HE 26, BW 9, TH 1, all with `stateClassName` "Ohne Hochwasser-Einstufung". 72 features (RP 37, NW 19, MV 9 …) have no `timestamp`. Treat both as `no-ref`.
- **Duplicates across states:** 9 name-and-river duplicates, 4 with conflicting classes (Worms RP 0 / HE −1; Perl SL 0 / RP −1 / a second SL id −1; Kaub and Mainz HE + RP; Kleinheubach and Obernau BY + HE; Havelberg BB + ST). The numeric part of the id is often shared (`RP_25700100` / `HE_25700100`). Rule in §4.9.
- **Alerts schema** (verified on the test server, §0.4): `kind: "AlertArea"`, id `<state>_<n>`, Polygon or LineString geometry, properties `areaDesc`, `areaType` (`Region`/`River`), `alertHeadline`, `lhpClass` (**string**), `lhpClassName`; alert legend 6/5/4/2/1. No per-alert times.
- **Test server** `…/public/v1/test/data/{stations,alerts}`: fixed data from 2024-01-25 (the January 2024 flood); 1,259 stations with classes up to 3; 40 alerts with classes 1, 2, 4, 5.
```
GET https://api.hochwasserzentralen.de/public/v1/data/stations?format=json&states=NW
{"apiVersion":"1.0 beta, 2025-02-04","status":"success","licence":"https://creativecommons.org/licenses/by/4.0/deed.de","licenceName":"CC BY 4.0 - Namensnennung",
 "updated":"2026-09-23T21:07:46+01:00",
 "legend":{"items":[{"lhpClass":4,"lhpClassName":"Sehr großes Hochwasser","color":"#941094"}, …,
   {"lhpClass":0,"lhpClassName":"Kein Hochwasser","color":"#7CBD5C"},{"lhpClass":-1,"lhpClassName":"Derzeit keine Daten","color":"#7b7b7b"}]},
 "features":[{"kind":"Station","id":"NW_2721390000100","type":"Feature","geometry":{"type":"Point","coordinates":[8.0264,50.894]},
   "properties":{"name":"Weidenau","water":"Sieg","timestamp":"2026-09-23 22:00:00","lhpClass":0,"stateClassName":"Kein Hochwasser",
     "stationLink":"https://www.hochwasserportal.nrw/webpublic/#/overview/Wasserstand/station/28754/Weidenau/Wasserstand","stateId":"DE-NW"},
   "style":{"color":"#7CBD5C"}}]}
```
- The feature `id` is `<state>_<state station number>`, which helps link stations across sources.
- Pitfalls:
  - `updated` has a fixed `+01:00`, but feature `timestamp` has **no offset and is local legal time**. Verified: Sannerz shows `16:30:00` in LHP and `15:30:00+01:00` in HLNUG.
  - `format=xml` still returns geo+json.
  - The ETag changes whenever `updated` ticks (about every minute); `If-None-Match` with the current ETag returns 304 [V gap check]. Earlier note "changes every call" was too strong.
  - Saarland features have `stationLink: null`.
  - The frontend endpoints `/webservices/get_lagepegel.php` and `get_lagepegel_archiv.php` returned empty bodies; do not use them.
- (P7a, 2026-10-03, from the recorded payloads and the owner's export:)
  - **Perl is `26100102` in the LHP**, not `26100100` as in PEGELONLINE, so the numeric rule alone does not find it; the duplicate rule needs a curated alias. No recording holds a second Saarland Perl entry with class −1 (the text above says one): the committed Perl case is a synthetic fixture.
  - **Bavaria numbers its Main gauges apart** from the Hessian service (Kleinheubach `BY_24064003`, Obernau `BY_24070006`). The Hessian Kleinheubach is 625 m from the Bavarian one and is not grouped; Obernau is operated by Bavaria. **Kalkofen neu** (Lahn) is listed by HE and RP, a duplicate this section does not name; the class is taken from RP. D18 (2026-10-03) confirmed both.
  - **The alert legend "2" (Vorwarnung) is hatched** (`cssStyle`) and has no single colour. The alert `lhpClass` is a string in "1", "2", "4", "5", "6" (the test server holds 1, 2, 4 and 5); an alert class "3" does not exist and is dropped as unmapped.
  - `stateClassName` can hold HTML entities (`&#60;`); it is stored verbatim and never rendered as HTML. The live stations payload held 1,588 to 1,589 features. The test server's stations (2024-01-25) hold classes 0 (1,199), 1 (32), 2 (14), 3 (1) and −1 (13), and three features have no `timestamp`.

**DE-7 NRW LANUK (Hochwasserportal.NRW, KISTERS WISKI-Web)**
- Official downloads under `https://www.hochwasserportal.nrw/data/downloads/`:
  - `messwerte.zip` (about 909 KB, unpacking to `messwerte.txt`, 12.1 MB, ASCII, CRLF): W at 15 min (some 5 min), last 7 days, 255 station blocks, about 239k rows. Refreshed about every 5 min (Last-Modified 20:04:03, 20:18:46 and 20:23:46 UTC).
  - `pegeldaten.zip` (about 10 MB, daily): 2 months of high-resolution data, 2 years of daily mean and max, plus metadata. **Verified in the gap check** (downloaded 2026-09-23, 10,114,351 bytes, 4 members, 128 MB unpacked): `pegel_messwerte.txt` (108 MB; `station_no;time;value(cm)`; 2,127,026 rows for 253 stations from 2026-07-23T20:40+01:00 to 2026-09-23T20:35+01:00), `pegel_tagesmittelwerte.txt` and `pegel_tagesmaxima.txt` (`station_no;time;mean(cm)` plus a coverage column, from 2024-09-24), `pegel_stationen.txt` (**UTF-8**, with `LANUV_Info_1..3`, `LANUV_MNW/MW/MHW`, catchment size and river km). Member timestamps show a build at about 18:37Z. Size the zip guard for 128 MB unpacked (§6.7). (P5b: the seed of 2026-09-30 has `pegel_messwerte.txt` of 108,136,362 bytes, 2,125,687 lines from 2026-07-30, ASCII with CRLF; none of the 24 `messwerte.zip` payloads of 2026-10-01, whose 252 stations and 238,678 rows are as above, holds an `NA` or a repeated point.)
  - `temperatur.zip`, `temperaturdaten.zip`, `niederschlag.zip` and `niederschlagsdaten.zip`.
```
station_no;time;value(cm)
2847500000100;2026-09-16T21:15:00.000+01:00;42.60
2829100000100;2026-09-23T21:00:00.000+01:00;32.00
2829100000100;                  <- every block ends with "station_no;" and empty fields (253 such lines)
```
- WISKI JSON (internal; `robots.txt` is `Disallow:` empty):
  - `https://www.hochwasserportal.nrw/data/internet/layers/index.json`: layers 10 Wasserstand, 11 WasserstandMax (48h), 20 Wassertemperatur, 30 Niederschlag, 40 Niedrigwasser. **No discharge.**
  - `…/layers/10/index.json` (272 KB): latest W for 302 stations, with thresholds.
  - `…/stations/stations.json` (568 KB): 620 stations.
  - `…/stations/{site_no}/{station_no}/S/week.json`: 7 days at 15 min.
  - `…/S/year.json`: 365 days of daily mean and max.
  - `…/S/alarmlevel.json`: information levels 1–3, N7W, etc.
  - `month.json` and `Q/week.json` return 404.
  - Headers include `last-modified` and `cache-control: max-age=0`; there is no ETag.
```json
{"ts_id":88499010,"timestamp":"2026-09-23T20:45:00.000+01:00","ts_value":"32.00","station_latitude":51.0978936437795,"station_longitude":6.10451262980085,
 "classification":"MN7W","station_id":"28723","station_no":"2829100000100","site_no":"100","station_name":"Stah","ts_unitsymbol":"cm",
 "catchment_name":"Rureinzugsgebiet","WTO_OBJECT":"Rur","WEB_STATYPE":"Infopegel",
 "LANUV_MHW":"211.0","LANUV_MNW":"31.0","LANUV_MW":"65.0","LANUV_Info_1":"200.0","LANUV_Info_2":"245.0","LANUV_Info_3":"265.0"}
```
- Daily mirror at `https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hygon/` (about 05:09): `OpenHygon-Pegel-aktuell_CSV.zip`, `OpenHygon-Pegel-Bestand_CSV.zip` (10 MB), `OpenHygon-Pegel-Stationen_EPSG4326.txt`, shapefiles and `OpenHygon_meta.zip`. The GovData entry is "Hydrologische Rohdaten (Hochwasserportal NRW)", licence `http://dcat-ap.de/def/licenses/dl-zero-de/2.0`.
- Metadata (DE-8): `hydro/Hydrologische-Stationen-NRW_EPSG25832_CSV.zip` (**ISO-8859-1**; column `Nullpunkt` = PNP, e.g. Stah 29.938 m) and `hydro/Wasserstand_MetaDaten_Pegel_EPSG25832_Shape.zip` (`Hoehensystem` = **DHHN2016**, `Folgegewaesser`, river km, purpose). `m NHN = PNP + W/100`.
- (P5b: recorded on 2026-09-29 and 2026-10-02. The **OpenHygon station file** `OpenHygon-Pegel-Stationen_EPSG4326.txt` is **UTF-8** (CRLF, `;`, 254 stations) with WGS84 latitude and longitude, the LANUV warning and statistics columns, and **no `Nullpunkt`**; a spec that declared it Latin-1 was wrong. The **hydro file** is the ISO-8859-1 one: a ZIP with one member, `Hydrologische-Stationen-NRW_EPSG25832.csv` (51,225 bytes, dated 2024-06-12, LF, `;`), 281 data rows of which one is a catchment of `NA` values, with the columns `station_name;station_id;Meldepegel;Datenpfleger;Mittelwert;Zweck;Betreiber;KOORDX;KOORDYY;UTMZone;Errichtung;GewS;EZG;Nullpunkt;Kommune;Kreis;Name`. It has the gauge zero (`Nullpunkt`, `NA` at Lieme and in the catchment row) and the operator (`Betreiber`): `LANUV, NRW` for most, but, among the 251 DE-7 gauges, `2761150000100` is RWE, `2766645000100` Oester-Wasserverband, `2768529000200` WBV Lüdenscheid and `2768784000200` Landschaftsverband Westfalen-Lippe, and 32 DE-7 gauges are not in the file. Its coordinates are EPSG:25832 and are not read. The file carries no validity date for the zero. The `pegel_stationen.txt` member of the `pegeldaten.zip` seed of 2026-09-30 equals the OpenHygon station file.)
- `site_no`: 100 = LANUK, **102 = WSV (duplicates PEGELONLINE; drop them)**, 104 = other operators (WVER, Aggerverband, Ruhrverband), 105 = RLP. **Key on `station_id` + `site_no`**, because of the placeholder `station_no` values `1234567` (St. Heimbach UW), `123456` (St. Obermaubach UW) and `1234512345` (Soestbach, twice).
- Timestamps are a fixed `+01:00` all year. `ts_value` is a string in layer 10 and a number in week.json. Stale stations remain (oldest 2026-06-09).
- History (DE-8):
  - `hydro/w/` has 16 catchment datasets as decade ZIPs, for example `Rureinzugsgebiet-NRW-W_2020-2029_EPSG25832_CSV.zip` (20 MB). `hydro/q/` has the same for Q. `temporal_start` is 1930-01-01.
  - Rows look like `Ahrhütte-Neuhof;2718193000100;2020-01-01T00:07:30+01:00;27.486` with **irregular, change-driven timestamps** and `NA` values.
- ELWAS-WEB (`https://www.elwasweb.nrw.de/elwas-web/index.xhtml`) is a JSF app with no machine interface.

**DE-9 NLWKN**
- Portal https://www.pegelonline.nlwkn.niedersachsen.de/. Manual: https://www.pegelonline.nlwkn.niedersachsen.de/pdf/BenutzerhandbuchWebservicePegelonline.pdf ("Stand: 26.10.2023").
- Endpoints (all with `?key=<NLWKN_PUBLIC_KEY>`):
  - `stammdaten/stationen/All`: 112 stations, 858 KB, about 3 s.
  - `stammdaten/stationen/{id,id,…}`: unknown IDs are silently dropped.
  - `station/{STA_ID}/datenspuren/parameter/{PAT_ID}/tage/{-n}`: `PAT_ID` 1 = Wasserstand; `tage` is **negative**.
  - `chart/station/…`: the same series with chart metadata.
```
GET https://bis.azure-api.net/PegelonlinePublic/REST/station/258/datenspuren/parameter/1/tage/-1?key=<NLWKN_PUBLIC_KEY>
{"getPegelDatenspurenResult":{"Betreiber":"NLWKN Betriebsstelle Meppen","GewaesserName":"Vechte","GewaesserNameNachfolger":"Issel",
 "Hoehe":7.961,"Hoehe_Text":"NN + 7,961 m","Latitude":"6.85700772610435","Longitude":"52.6022309606521","Name":"Emlichheim","STA_ID":258,"STA_Nummer":"9286162",
 "Parameter":[{"Name":"Wasserstand","Einheit":"cm","PAT_ID":1,"Datenspuren":[{"DAS_ID":14681695,"IntervallSek":900,
   "Meldestufen":[{"Stufe":1,"Wert":390,"WertNNM":11.861},{"Stufe":2,"Wert":430},{"Stufe":3,"Wert":510}],
   "Pegelstaende":[{"Datum":"/Date(1790197200000+0000)/","DatumUTC":"/Date(1790193600000)/","Wert":121}]}]}]}}
```
- Pitfalls:
  - Use only **`DatumUTC`** (true UTC epoch ms; 1790193600000 = 2026-09-23T20:00Z). `Datum` is +1 h mislabelled `+0000`.
  - **`Latitude` and `Longitude` are swapped.**
  - `-888` is the no-data sentinel.
  - Results come newest first.
  - The datum is labelled "NN".
  - Do **not** use the frontend API (`/PegelonlineNeu/REST/…?subscription-key=…`).
- Hase gauges also exist: Bokeloh 201, Herzlake 328, Haselünne 310. Older data: www.wasserdaten.niedersachsen.de (UNVERIFIED).

**DE-10 RLP LfU** (later, with permission)
- The SPA's axios base is `/api/v1`:
  - `https://www.hochwasser.rlp.de/api/v1/index` (2.9 MB: 46 alert regions; 292 sites × 48 h of 15-min W).
  - `…/config` (286 KB; EPSG:25832).
  - `…/measurement-site/{number}`.
  - `…/status-report`, `/alert-region/{id}`, `/river-area`.
- Timestamps are ISO **UTC `Z`**.
```json
GET https://www.hochwasser.rlp.de/api/v1/measurement-site/25400750
{"W":{"xLast":"2026-09-23T20:00:00Z","yLast":240,"measurements":[{"y":240,"x":"2026-09-18T20:00:00Z"}],
      "predictions":{"p10":[…46],"p50":[…],"p90":[…],"time":"2026-09-23T18:00:00Z","nextUpdateTime":"2026-09-23T23:15:00Z"}},
 "Q":{"measurements":[]},"extremeevents":{"W":[{"date":"1981-12-31T23:00:00Z","value":780,"dimension":"cm","confirmed":1}]},
 "downloadUrl":"https://geodaten-wasser.rlp-umwelt.de/wasserstand/2540075000/download"}
```
- CSV export: `https://geodaten-wasser.rlp-umwelt.de/api/export/messstellen_wasserstand_messwerte.csv?w=messstellennummer%3D2540075000`. It returns **403 without a `Referer`**. Offerings: 90 days of W; `…_abfluss` (90 days of Q); `…_messwerte_mittel` / `…_abfluss_mittel` (3 years of daily means); `…_hauptwerte`. Times have no zone (MEZ inferred). Future slots are padded with `-`.
- Master data: `…/api/data/messstellen_wasserstand_stammdaten?w=…` → `"nullpunkt":"96,534 (DHHN2016)"`.
- IDs are 8 digits (`25400750`) on the portal and 10 digits (`2540075000`) in geodaten.
- Relevant stations: Nahe (Heimbach Bhf., Oberstein 2, Kallenfels, Martinstein 2, Boos, **Bad Kreuznach**, Dietersheim, Altenbamberg on the Alsenz), Lahn (Diez, Kalkofen, both WSA) and Sieg (Betzdorf, Etzbach). The index also carries DREAL Grand Est, LANUK, WSA, Luxembourg and SPW data; the rights stay with those operators.
- **Forecasts in the index (gap check, 21:35Z) [V]:** 66 of 292 sites carry `predictions` with **p10, p20 … p90** (9 percentiles, not 3), 46–48 steps, `time` (run) and `nextUpdateTime`. Per river: **Rhein 20** (Maxau, Speyer, Mannheim, Worms, Mainz, Oestrich, Bingen, Kaub, Braubach, Koblenz, Andernach, Neuwied Stadt, Oberwinter, Bonn, Köln, Düsseldorf, Duisburg-Ruhrort, Wesel, Rees, Emmerich), **Mosel 9** (Perl, Stadtbredimus, Wasserbillig, Trier, Ruwer, Detzem UP, Wintrich, Zeltingen, Cochem), Nahe 5, Lahn 4 (Marburg, Leun, Diez, Kalkofen_Neu), **Ahr 3** (Müsch 2, Altenahr, Bad Bodendorf), Sauer 2 (Bollendorf 2, Rosport), Our 2 (Gemünd, Dasbourg), Kyll 2, Glan 2, Sieg 2, Wied 2, Schwarzbach 2, and one each on the Prüm, Saar (Fremersdorf), Nims, Lieser, Nette, Hahnenbach, Simmerbach, Selz, Hornbach, Holzbach and Mühlbach. The Rhine run seen was issued 05:00Z with the next due the following morning; tributary runs 18:00Z with the next at 23:15Z.
- **Regional alerts:** `alertregions` (46) with `alertClassId`, `preAlert`, `importedAt`, `until`. `config.alertclasses`: 1 Keine Informationen, 2 Geringe, 3 Mäßige (HW2), 4 Mittlere (HW10), 5 Hohe (HW20), 6 Sehr hohe (HW50), 7 Extreme Hochwassergefahr (HW100). The station legend adds "< Mittelwasser" and "< mittleres Niedrigwasser". `statusReport` carries the daily situation text.
- **Contact for permission:** poststelle@lfu.rlp.de (Impressum of hochwasser.rlp.de). The Hochwassermeldeplan 2026 (April 2026) describes the forecast products (Teil B).

**DE-11 HLNUG** (phase 2)
- Portal `https://www.hlnug.de/static/pegel/wiskiweb3/webpublic/`. The data root is `…/wiskiweb3/data/`, with `site_no` `0`.
- Files:
  - `…/data/internet/layers/10/index.json` (151 KB, 188 stations). Layer 20 = Q, layer 16 = Vorhersage.
  - `…/stations/stations.json` (532 KB, 336 stations, `GAUGE_DATUM`, e.g. Leun "134.99").
  - `…/stations/0/{station_no}/W/week.json` (15-min `15.P` plus forecasts `vhs.60`, `abs.60`, `nor.60`).
  - `…/Q/week.json`.
  - `…/W/year.json`: daily mean, min and max for the whole record (Leun from 1995-01-01, 1.3 MB).
```json
GET https://www.hlnug.de/static/pegel/wiskiweb3/data/internet/layers/10/index.json
{"ts_id":9605010,"timestamp":"2026-09-23T21:00:00.000+01:00","ts_value":41,"station_latitude":49.638812,"station_longitude":8.766926,
 "station_no":"23940359","station_name":"Fahrenbach","stationparameter_name":"W","ts_shortname":"15m.Cmd.RelAbs.P","ts_unitsymbol":"cm",
 "ts_path":"0/23940359/W/15m.Cmd.RelAbs.P","WTO_OBJECT":"Weschnitz","BODY_RESPONSIBLE":"RPU Darmstadt","Vorhersagepegel":"no"}
GET …/stations/0/25800200/Q/week.json -> "15.P" m³/s 757 rows [["2026-09-16T00:00:00.000+01:00",7.37] … ["2026-09-23T21:00:00.000+01:00",6.16]]
```
- Timestamps are a fixed `+01:00` (`"Zeitbezug":"MEZ"`). Refresh is about every 15 min (Last-Modified moved from 20:08:50 to 20:23:44 UTC); an ETag is present.
- Stations: Lahn (Feudingen, Biedenkopf, Sarnau, Marburg, Gießen, Leun (WSV), Limburg, Diez, Kalkofen) and Kinzig (Sannerz (stale), Steinau, Ahl, Gelnhausen, Hanau, Hanau-Mündung). WSV gauges are excluded from HLNUG downloads.

**DE-12 LUBW HVZ** (later, with permission)
- Files: `…/js/jf-data-def-peg.js` (column positions), `…/js/jf-data-stm-peg.js` (139 KB, 333 stations with NP/PNP, HW/MQ statistics and lon/lat) and `…/js/jf-data-db-peg.js` (40 KB, latest W and Q, regenerated about every 5 min).
- Sample rows: `['00111','23.09.2026 22:15 MESZ','14','','cm','23.09.2026 22:15 MESZ','2.14','+0.02','m³/s',…]` and `['09056',…,'382.23','+2','müM',…]` (Neuhausen CH, in m ü.M.).
- Pitfalls: time strings say "MESZ" while the header says "MEZ"; the HTTP `Last-Modified` is 2 h behind; units are mixed; one gauge had a future timestamp.
- Stations: Kinzig (Schenkenzell 00200, Wolfach, Hausach, Biberach, Schwaibach 00002), Murg (Baiersbronn, Schwarzenberg, Forbach, Bad Rotenfels 00111, Rastatt) and upper Neckar (Rottweil 00146, Oberndorf, Horb, Kirchentellinsfurt, Wendlingen, Plochingen).

**DE-13 Bayern**
- GKD, e.g. `https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/schwuerbitz-24006007/messwerte?beginn=22.09.2026&ende=23.09.2026`, serves HTML tables (`Datum | Wasserstand [cm]`, e.g. `23.09.2026 22:15 Uhr | 145`; local legal time, inferred). The download page says "Datenbestand vom 01.11.1963…" (ISO 8859-1, CC BY 4.0). Downloads go through `POST /de/downloadcenter/enqueue_download`, which robots.txt disallows.
- HND has about 820 gauges, PNG charts (`/webservices/graphik.php?statnr=…`) and 18-hour forecasts.
- LfU WMS: `https://www.lfu.bayern.de/gdi/wms/wasser/pegel?`.

**DE-14 Saarland:** unreachable (see §1a). The legacy `Daten.js` is frozen, e.g. `Pegel(408,411,'1062220','1','Reinheim','Blies',' 144','23.02.2023  6:00','  +1');`.

**DE-15 WVER**
- Table: `https://wver.de/karten_messwerte/Messdatenportal/aktuelle_Werte_Pegel.html` (about 70 Rur-basin gauges, including "Wurm Rimburg NL" and "Amstelbach Eygelshoven WL").
- Per-station JSON: `…/Messdaten/<Name>WasserstandBasis.P.json` and `…AbflussBasis.P.json`, e.g. `Kall%20ZerkallWasserstandBasis.P.json` (1.44 MB, about 1 year at 15 min). Timestamps carry the **correct local offset `+02:00`**. The `rows` field is wrong.
- `https://server.wver.de/pegeldaten/` is UNVERIFIED (connection reset).

**Normalisation across German states:** see §4.4 for time zones. Keep one canonical source per physical gauge; PEGELONLINE takes precedence for WSV gauges.

### 2.4 BE-1 / BE-2 / BE-3: Belgian KISTERS KiWIS servers (shared conventions)

All three Belgian sources run KISTERS KiWIS QueryServices: HIC and VMM on version 1.11.4, SPW on 1.11.9.

**Requests they share:** `getrequestinfo`, `getGroupList`, `getSiteList`, `getStationList`, `getParameterList`, `getTimeseriesList`, `getTimeseriesValues` and `getTimeseriesValueLayer` (the map call). SPW also offers `getQualityCodes`, `getRatingCurveList` and `getRasterTimeseriesValues`. HIC offers `getTimeseriesEnsembleValues` (JSON only), and `getGraph` exists.

**Formats and parameters**
- Formats: `json` (dajson), `csv`, `html`, `geojson` (list and layer requests), `esrijson`, `wml2`, `xlsx`, `ascii`.
- Common parameters: `returnfields`, `metadata=true` with `md_returnfields`, `timezone` (a Java time-zone string; **always pass `timezone=UTC`**), `dateformat=UNIX`, `csvdiv`, `downloadaszip`, `ts_id` (comma list), `ts_path` (wildcards allowed), `timeseriesgroup_id`, `from`, `to`, `period` (e.g. `PT6H`, `P3D`), `date` (for a time-travel value layer), `valuecolumn=default|absolute|runoff`, and `invalidPeriod`/`invalidValue`.
- Input times accept ISO with offset, `yyyy-MM-dd`, `yyyy`, UNIX ms or ISO periods. How offset-less inputs are read is UNVERIFIED, so always send an explicit `Z`.

**Limits and costs**
- A call returns at most **250,000 values**; beyond that you get `{"code":"TooManyResults","message":"Maximum number of timeseries values surpassed. Please narrow your request. Limit is: 250000"}`.
- There is no pagination.
- An unknown `returnfields` value gives HTTP 500 `InvalidParameterValue` rather than a partial result.

**Type quirks:** `ts_id` is a JSON *number* in value layers and a *string* in `getTimeseriesValues`.

**Metadata calls are slow.** Measured: HIC group values 44 s; HIC historic value layer 38 s; VMM `getTimeseriesList` for a group 23 s; a wildcard `getTimeseriesList&ts_name=Drempel*` over 60 s; `station_name=Maaseik*` 16 s. Use timeouts of at least 60 s, cache metadata daily, and never run wildcard listings on the hot path.

#### BE-1 HIC (`hicws.vlaanderen.be`, `datasource=4`)
- Manual: "Manual on the use of HIC webservices", version 24/07/2026, 26 pages: https://hicws.vlaanderen.be/Manual_for_the_use_of_webservices_HIC.pdf.
- The legacy URL `https://www.waterinfo.be/tsmhic/KiWIS/KiWIS?...datasource=4` redirects (302) to `waterinfo.vlaanderen.be/tsmhic/...`.
- Headers: `access-control-allow-origin: *`; `cache-control: max-age=30` (value layer), `max-age=60` (values) or `max-age=300` (lists). `If-Modified-Since` still returns 200.
- Datum: *"The reference plane used for water level data is 0 m TAW"*. H, W and Q are absolute (m TAW; m³/s).

**Public groups**

| Group | ID | Type | Note |
|---|---|---|---|
| Waterstand hoge resolutie (H and tidal W) | **156163** | Cmd | 225 series: 191 H (`H/Cmd.Abs.Pv`) and 34 W (`Pv.10`, `W/10m.Cmd.Abs.Pv`); 206 active |
| Waterstand uur / dag | 156164 / 156162 | Cmd | |
| Afvoer hoge resolutie | **156170** | Cmd | About 50 Q series (`Q/Cmd.RunOff.Pv`) |
| Afvoer uur / dag | 156171 / 156169 | Cmd | |
| HW/LW Scheldt tidal area | **156165** | Cmd | 35 series `Pv.HWLW`, with `returnfields=…,Tide%20Number` |
| High waters only / low waters only | 510205 / 510207 | Cmd | |
| Calculated discharges at key waterway locations | 260592 | Cmd | 11 daily series |
| Astronomical tide mTAW (10-min / HW-LW) | 354718 / 350099 | Cmd | Antwerpen `Astro.10` ts 112650010, to **2028-01-03** |
| Astronomical tide in LAT | 512458 / 515316 | Cmd | |
| Water-level forecast 48 h / 10 days | **506056** / 506058 | Ensemble | Antwerpen `W_voorspeld` ts 89202010: run at 18:00Z, horizon to +60 h, 5-min steps, 721 rows |
| Discharge forecast 48 h / 10 days | 506057 / 506059 | Ensemble | |
| Tidal previsions HW/LW | 432821 | Ensemble | |

- Parameter types: H 560, W 563, Q 558, W_voorspeld 12307, H_voorspeld 12271, Q_voorspeld 12295.
- Station numbering: `zes21a-1066` is Zeeschelde, with a location code that increases **upstream**. The suffixes `-1066`/`-1115`/`-1073`/`-1060` probably mean HIC, lock gauges, De Vlaamse Waterweg and external/RWS (inferred). `HIS_` marks a closed station. ts_ids end in `…010`.

**Calls**
```
# series list with river names (7.9 s, 51 KB)
GET …datasource=4&request=getTimeseriesList&format=json&timeseriesgroup_id=156163
    &returnfields=ts_id,ts_name,ts_path,station_no,station_name,stationparameter_name,parametertype_name,station_latitude,station_longitude,ts_unitsymbol,coverage,ca_sta
    &ca_sta_returnfields=river_name
# latest non-tidal values (0.6–1.0 s, 66 KB)
GET …datasource=4&request=getTimeseriesValueLayer&timeseriesgroup_id=156163&format=json&metadata=true
    &md_returnfields=ts_id,station_no,station_name,parametertype_name,ts_unitsymbol&timezone=UTC
→ [{"ts_id":114978010,"timestamp":"2026-09-23T20:10:00.000Z","req_timestamp":null,"ts_value":6.57,
    "station_latitude":50.969276505467,"station_longitude":4.69217891181747,"station_no":"dij13a-1066","station_name":"Werchter/Dijle","parametertype_name":"H","ts_unitsymbol":"m"}]
# tidal stations: MUST use getTimeseriesValues (the layer returns null for all 34 W Pv.10 series)
GET …datasource=4&request=getTimeseriesValues&ts_id=53989010,55493010,…&period=PT2H&format=json&metadata=true&timezone=UTC
    &returnfields=Timestamp,Value,Quality%20Code&md_returnfields=ts_id,ts_name,station_no,station_name,parametertype_name,ts_unitsymbol,timezone,ts_spacing
→ [{"ts_id":"53989010","ts_name":"Pv.10","station_no":"zes21a-1066","station_name":"Antwerpen tij/Zeeschelde","parametertype_name":"W",
    "ts_unitsymbol":"m","timezone":"Europe/Berlin","ts_spacing":"PT10M","rows":"12","columns":"Timestamp,Value,Quality Code",
    "data":[["2026-09-23T20:20:00.000+02:00",0.50,111], … ,["2026-09-23T22:10:00.000+02:00",0.62,111]]}]
# HW/LW with tide number
GET …&request=getTimeseriesValues&ts_id=53995010&period=P1D&format=json&timezone=UTC&returnfields=Timestamp,Value,Quality%20Code,Tide%20Number
→ "data":[["2026-09-23T00:36:00.000Z",4.74,111,20261025],["2026-09-23T07:01:00.000Z",0.34,111,20261026], …]
```
- Always include `ts_id` in `md_returnfields`, otherwise multi-series rows are unlabelled.
- `ts_path=*/zes21a-1066/W/10m.Cmd.Abs.Pv` works.
- **A call without `from`/`period` returned 0 rows. Always send `period`.**
- A time-travel layer (`&date=2026-09-20T12:00:00Z`) does return tidal values (206 of 225 series) but took 38 s.
- **Ensembles:** `getTimeseriesEnsembleValues` returns all runs (not called; UNVERIFIED). A plain `getTimeseriesValues` on an ensemble returns only the latest run, and treating an ensemble like a Cmd series mixes runs (per the manual).

**Freshness:** tidal series had 20:10Z at 20:22Z. Menen is 15-min, Maaseik 5-min and Sint-Pieter Noord H 1-min. Q series sometimes end with a placeholder `[..., null, -1]` (Melle, Maaseik). Coverage `to` can run about 5 min ahead of the real last value.

**Quality codes (HIC table):** 6–8 externally validated (6 good, 7 estimated, 8 suspect); 10–19 good measurements; 20–29 good calculations; 30–39 estimated measurements; 40–49 estimated calculations; 60–69 suspect measurements; 70–79 suspect calculations; **110–179 unchecked** (live data arrives as 111 or 121); 221–223 unknown (import); 255 / −1 missing.

**Auth (TYPE 1/2/3)**
- TYPE 1: sporadic manual use; no authentication; may be blocked under load.
- TYPE 2: sporadic large downloads; authentication needed.
- **TYPE 3: automatic or scheduled use in a viewer. This project is TYPE 3.** It needs authentication plus a User Agreement.
- Token flow: `POST https://hicwsauth.vlaanderen.be/auth` with `Authorization: Basic <base64 clientId:clientSecret>` and body `grant_type=client_credentials` → `{"access_token":"…","token_type":"Bearer","expires_in":86400}`. Then send `Authorization: Bearer …`. Without credentials the endpoint answers 400 "Invalid auth data."
- Credits: roughly 1 credit per 10,000 theoretical values; requests over 250,000 credits are never allowed.
- HIC's own advice: request a token once per 24 h; fetch one big metadata list; use value layers per group; use `period=P7D`-style URLs so caches can be reused.
- Coordinates: `station_carteasting`/`station_cartnorthing` switched from Lambert72 to **Lambert2008 on 2026-02-03**. Use `station_latitude`/`station_longitude`.

#### BE-2 VMM (`download.waterinfo.be`, `datasource=1`)
- **Use `datasource=1`.** `datasource=0` prefixes every ID with `01` (`ts_id 0128764042`, group `01192780`) and fails with `"Could not find a datasource of splitted request id 192780"`. Values 2, 3 and 4 return "Datasource parameter not found in config."
- Headers: `cache-control: public,max-age=0,no-cache` and a `tsmtest=` cookie. There are no rate-limit headers; about 40 anonymous calls in 15 min were never throttled.
- **Groups** (from the VMM manual "Open Data waterinfo.be", v02/2022):

  | Group | ID | Note |
  |---|---|---|
  | Waterstand_15m | **192780** | 1,085 series; 868 had a value in the current hour |
  | Waterstand_uur / dag / maand / jaar | 192785 / 192782 / 192783 / 192784 | |
  | Afvoer_15m | **192786** | 136 series (`…/15m.Cmd.Pv.RunOff`); 102 active |
  | Afvoer_uur / dag / maand / jaar | 192892 / 192893 / 192894 / 192895 | |
  | Watersnelheid 15m | 192901 | |
  | Others | `WEBLayer_Stage_15m.Cmd` 118730, `WEBLayer_Tidal` 172085 | HIC-named groups return `["No matches."]` here |

- Parameter types: H 559 (m), Q 557, v 561, H_voorspeld 93277, Q_voorspeld 93283.
- ts naming: `Pv.15` (`AOW_LIMNIGRAFEN/L08_098/H/15m.Cmd.Pv.RelAbs`) is the public 15-min series. Also `P.15`, `O.15` (raw), `P.60`, `DagGem`/`DagMax`/`DagMin`, `KalJaarP90`, `MeetPeriodeMax`, and thresholds `DrempelAlarm`/`DrempelWaak`/`DrempelPrewaak`. At structures, `Hopw01`/`Hafw01` are the levels upstream and downstream (e.g. `AOW_KUNSTWERK/K09_032/Hopw01/15m.Cmd.Abs`).
- Station numbering: `L08_098` (river gauge), `K09_032` (structure), `S..` (partner), `HIS_...` (closed). ts_ids end in `…042`.
- **Datum pitfall:** on `…RelAbs` series, `Value` can be relative to the local gauge zero while `Absolute Value` is m TAW, and this is inconsistent between stations. **Always request `Absolute Value`, or `valuecolumn=absolute` in the layer.**
```
GET …datasource=1&request=getTimeseriesValues&ts_id=3880042&period=PT1H&format=json&metadata=true
    &returnfields=Timestamp,Value,Absolute%20Value,Quality%20Code
→ [{"ts_id":"3880042","ts_name":"Pv.15","ts_path":"AOW_LIMNIGRAFEN/L08_098/H/15m.Cmd.Pv.RelAbs","station_no":"L08_098","station_name":"Sint-Joris-Weert/Dijle",
    "ts_unitsymbol":"m","timezone":"Europe/Berlin","ts_spacing":"PT15M","columns":"Timestamp,Value,Absolute Value,Quality Code",
    "data":[["2026-09-23T21:30:00.000+02:00",0.174,27.396,110]]}]
GET …datasource=1&request=getTimeseriesValueLayer&timeseriesgroup_id=192780&format=json&valuecolumn=absolute
    &metadata=true&md_returnfields=ts_id,station_no,station_name,ts_path&timezone=UTC      (330 KB, 1.3 s; format=geojson works)
→ [{"ts_id":4342042,"timestamp":"2026-09-23T20:00:00.000Z","req_timestamp":null,"ts_value":30.212,"station_no":"L09_136","station_name":"Hasselt/Demer",…}]
```
- Hasselt/Demer shows the same pattern: `Value` −0.258, `Absolute Value` 30.212.
- A comma list of 100 ts_ids with `period=PT1H` took 2.0 s (22 KB). `timeseriesgroup_id=192786&period=PT1H` works (2.3 s), but **group 192780 fails** with HTTP 500 `{"code":"DatasourceError","message":"Error getting tsinfolist from cache."}`. Batch the ts_ids instead.
- Time-travel layer: `&date=2026-09-20T12:00:00Z` took 12 s. Dead series return values years old, so compare `timestamp` with `req_timestamp`.
- `invalidPeriod=PT2H&invalidValue=-9999` replaced stale values with **−10000**, not the value requested.
- Quality codes seen: 110 and 130 (recent), 220 (1995). The table is UNVERIFIED (DOV wiki returned 503).
- Auth: `POST https://download.waterinfo.be/kiwis-auth/token` (`grant_type=client_credentials`, Basic auth; 24 h tokens; credits). Without credentials it answers `{"type":"error","status":400,"errorCode":40007,"message":"Invalid auth data."}`.
- The VMM manual warns that `getTimeseriesValues` is not pre-cached and costs more credits. VMM disclaims responsibility for changes to IDs and group contents, so store `ts_path`.
- History: anonymous access returned 1995 data (`["1995-01-26T00:00:00.000Z",1.120,28.342,220]`). A 400-day 15-min pull (about 38k values, 1.5 MB) worked anonymously.

#### BE-3 SPW Wallonia (`hydrometrie.wallonie.be`, `datasource=0`)
- The portal went live 2022-06-30 and replaces the legacy sites: `voies-hydrauliques.wallonie.be` redirects (301) elsewhere, `appli.voies-hydrauliques.wallonie.be` returns reset or 503, and `aqualim.environnement.wallonie.be` does not resolve.
- Headers: `X-spw-user: public`, `Access-Control-Allow-Origin: *`, `Cache-Control: max-age=300`, `Vary: X-User-Group`. The frontend uses `usergroups="web_s0_public"`. There is no robots.txt (404).
- **Groups:** `getGroupList` returns 162.
  - **1962373** `WEBPortal_ESurf-Hauteur`: 320 level series (DCENN 193 × `H`, DGH 107 × `H`, 12 × `H_sonde`, 4 × `Habs_sonde`, 2 × `Habs`, plus reservoirs). (P5c, owner export of 2026-10-02: still 320. The "reservoirs" are the Eupen (operator code `EUP`) and Gileppe (`GIL`) dam lakes, one absolute `Habs` series each, so `Habs` is 4 series in the registry (two at river gauges, two lakes); both lakes are on the 5-minute grid in the layers.)
  - **1962340** `WEBPortal_ESurf-Debit`: 286 discharge series (`Q` and `QADM`, the latter at 11 ultrasonic stations). (P5c: **288 on 2026-10-02**, not 286: 276 distinct `Q` keys and 11 `QADM`, and DCENN L5860 Theux has **two** `Q` series in the group, `Cmd.RunOff.Comp` and `Cmd.RunOff.Comp-Alarmes`, with identical values. Two `ts_id`s under one `<station_no>/<stationparameter_no>` key are therefore possible: the BE-3 adapter keeps one value per instant and withholds a disagreement. The registry holds 607 series at 332 stations: operators DCENN 386, DGH 219, EUP 1, GIL 1.)
  - 1962392 / 1962354: tendency groups.
  - 3617241: `WEBPortal_ESurf-StationsActives`.
- **Recommended poll:** two layer calls, about 140 KB in total, under 2 s.
```
GET https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json
    &request=getTimeseriesValueLayer&timeseriesgroup_id=1962373&timezone=UTC
    &metadata=true&md_returnfields=station_no,station_name,ts_id,stationparameter_no,ts_unitsymbol      (320 objects, 87.9 KB, 0.9 s)
→ [{"ts_id":246052010,"timestamp":"2026-09-23T19:55:00.000Z","req_timestamp":null,"ts_value":1.276,
    "station_latitude":50.5164135163075,"station_longitude":5.23421331783582,"station_no":"7141","station_name":"HUY","stationparameter_no":"H","ts_unitsymbol":"m"}]
# discharge: timeseriesgroup_id=1962340 (286 objects, 50 KB, 0.5 s)
GET …&request=getTimeseriesValues&ts_id=240759010,250652010,245267010&period=PT20M&timezone=UTC&returnfields=Timestamp,Value,Absolute%20Value,Quality%20Code
→ [{"ts_id":"240759010","data":[["2026-09-23T20:00:00.000Z",0.188,110.088,200]]},{"ts_id":"250652010","data":[["2026-09-23T20:05:00.000Z",1.053,91.055,200]]},
   {"ts_id":"245267010","data":[["2026-09-23T20:05:00.000Z",59.981,null,200]]}]
```
- Time windows: `from`/`to` (a bare date covers the day), `period=PT3H|P1D|complete`, `futureperiod`, or no `from` for the last value only.
- Wildcards: `ts_path=DCENN/L6660/*/Cmd.*Comp-Alarmes` returns H and Q for Sippenaeken.
- The whole group over a window (`timeseriesgroup_id=1962373&period=PT1H`, 2,135 rows) took 9.9 s.
- The `date=` time-travel layer works for backfill at chosen instants.
- Station metadata: `getStationList&station_no=5921,8001,5451,L8470&returnfields=station_no,station_name,station_carteasting,station_cartnorthing,station_georefsystem,station_timezone,station_utcoffset,river_name,ca_sta`. The full list has 501 stations (DGH 237, DCENN 193, "Bassins" 59, EUP 6, IDEA 4, GIL 1, VES 1; 0.7 s). `ca_sta` expands to about 50 attributes, including `station_gauge_datum`, `station_gauge_datum_unit`, `CATCHMENT_SIZE`, `BASSIN_INFOCRUE`, `NIVCRU`, `ADRESSE` and `ObjectDescription`. (P5c, measured on the owner's export of 2026-10-02: **`river_name` is a reach name, not a river**: `Basse Meuse`, `Meuse moyenne`, `Haute Meuse (amont Dinant)`, `Haute Sambre`, `Basse Sambre`; the 25 stations so named were all DGH gauges on the Meuse and the Sambre themselves, none on a tributary, which is how the registry flags the weir-controlled stages `impounded`. **`ObjectDescription` is a free-text cell of up to 2,204 characters** (the shared KiWIS parser allows table cells of 20,000).) For Tabreux: `"station_gauge_datum":"109.9","station_gauge_datum_unit":"DNG","station_timezone":"(UTC+01:00) Generic time zone","station_utcoffset":"-60","CATCHMENT_SIZE":"1607,00 km²"`.
- `getTimeseriesList&timeseriesgroup_id=1962373&returnfields=station_no,station_name,station_id,ts_id,ts_name,ts_shortname,ts_path,stationparameter_no,ts_unitsymbol,station_latitude,station_longitude,site_no,coverage` returned 92 KB in 2.9 s, for example `["L7550","Ecaussinnes","15720","188700010","05a-Hauteur.Complet.Alarmes","Cmd.Rel.Abs.Comp-Alarmes","DCENN/L7550/H/Cmd.Rel.Abs.Comp-Alarmes","H","m",…,"DCENN","2019-01-01T00:00:00.000+01:00","2026-09-23T22:00:00.000+02:00"]`. **`river_name` is not a valid returnfield here (HTTP 500).**

**Quantities**
- `H` is metres relative to the gauge zero. `station_gauge_datum` is in m DNG (DNG = TAW). `valuecolumn=absolute` or `Absolute Value` gives m DNG, e.g. Tabreux 110.096 and Dinant 91.058. It is `null` for series that are already absolute. The datum can be `9999.0` (unknown; seen at L8470).
- `Habs` / `Habs_sonde` are absolute m DNG (Namur 78.5, Liège 59.98). `H_sonde` is a relative pressure-probe level.
- `Q` is m³/s from a rating curve. `QADM` is ultrasonic m³/s, hourly; its coverage always ends one step in the future with `null`/`-1`. `QEtimeuse` (Liège 5491) is a half-hourly estimate and not in the public group.
- **Navigable Meuse and Sambre stages are weir-controlled; use Q or QADM for the flow signal.**

**Latency:** DGH series are 5-min, DCENN 10-min and QADM hourly. At 20:17 UTC: 277 series were under 30 min old, 32 between 30 and 120 min, 8 between 2 and 24 h, and 3 over 1 day (L5800 about 4.7 days, L7370 about 58 days, 5804 ANGLEUR GR BAT. Av since 2024-11-30).

**Quality codes (`getQualityCodes`):** 0 Excellent, 40 Good, 80 Fair, 120 Suspect, 160 Poor, 161–165 manual or limnimetry, **200 Unknown (raw)**, 205 "Douteux (publié)", 210 "Douteux (non publié)", 253 "Valeurs fantômes". Validated data is below 200; live data is 200.

**Time:** the default is local time with offset. Daily aggregates are stamped `T01:00+02:00` / `T23:00Z`, because the station time zone is a fixed UTC+1.

**History:** full-resolution series `Cmd.Rel.Abs.Comp` / `Cmd.RunOff.Comp` / `Cmd.Abs.Comp` go back to 1969–2007 depending on the station; the `…Comp-Alarmes` public series start 2019-01-01. Also `h.Mean`, `Day.Mean`, `Month.Mean`, LTV and percentiles. Examples: Visé daily Q July 2021 `["2021-07-14T23:00:00.000Z",2428.024],["2021-07-15T23:00:00.000Z",2742.985]`; Tabreux hourly Q 1980 `["1980-01-01T00:00:00.000Z",46.089,40]`; Tabreux 2021-07-15 level 3.953 m / 113.853 m DNG. The download UI caps requests at 250,000 values ("un peu plus de 2 ans… pour une station") and 365 days of high-resolution data.

**References and classes (P7a, 2026-10-03: a live recon of 5 requests, owner decision; owner payloads stay in `.smoke/`)**
- The long-term statistics are time series, not metadata: `ts_shortname` **`Cmd.POR.P05`, `P10`, `P15`, `Med`, `Mean`, `P85`, `P90`, `P95`** (POR = period of record) in a **Rel** form (m above the gauge zero) and an **Abs** form (m DNG), and **`Cmd.ReferenceFlood.Top3`**. A POR series holds one value, stamped at the start of its period (1999-01-01 local). POR exists only for `H` (301 series) and `H_sonde` (14); Top3 for `H`, `Q`, `H_sonde`, `QADM` and `Habs_sonde`. `LTV.Day` and `LTV.Month` are day-of-year and monthly climatologies (not read before P14). The recon list held only P05 and Top3 (921 series at 331 stations); the full count is checked after the first run of `be-3-refs`.
- The percentiles are **non-exceedance**: Huy P95 1.548 m is above the mean 1.305 m.
- **Do not use wildcards across stations:** `ts_shortname=Cmd.POR.*` over all stations timed out after 60 s, and a `ts_path` wildcard in a `getTimeseriesValues` call answers `TooManyResults` (limit 250,000 values). The list is asked with exact shortnames, then the values for at most 100 `ts_id`s per call.
- **`NIVCRU`** (the `ca_sta` field of `getStationList`) is a text class of the form `t<n>/<state>` on 177 of 501 stations, and all of them read "Normal" today. Its meaning (a flood-warning stage per station?) is unknown, so it is stored raw with no level.

**Frontend internals (do not use):** `/services/kiwcp/configs/config.json` (1.4 MB), `/services/kiwcp/data/hDayOffsetPub.json` (327 KB, about every 10 min) and `catchments.json`.

**Same name, different place:** "HASTIERE" (8622) is on the Hermeton; DCENN "Dinant" (L8470) is on the Fonds de Leffe; "Stavelot", "Malmedy" and "Daverdisse" exist in both DGH and DCENN. **Key on `site_no`/`station_no`.**

**BE-4:** `EF.EnvironmentalMonitoringFacilities_surfacewaterbody_gauging_wfd` holds 33 sites (e.g. `BERW_L5170` BAISIEUX). It is catalogued as "Stations de mesure de la hauteur d'eau des cours d'eau non-navigables" (uuid a06b1f40-…).

### 2.5 FR-1 to FR-6: Hub'Eau and Vigicrues

**FR-1 Hub'Eau Hydrométrie v2**
- `"api_version":"2.0.1"`. OpenAPI (Swagger 2.0): `GET https://hubeau.eaufrance.fr/api/v2/hydrometrie/api-docs` (117 KB).
- v1 (`/api/v1/hydrometrie/...`) returns **403**; it was shut down on 05/05/2025.
- Status page: `https://hubeau.eaufrance.fr/status` (not called).
- Upstream is PHyC, updated into the API every 5 minutes, with one month of history.
- The only capacity figure is historical: "10 appels/s en moyenne" (2020-03-05). There is no SLA.

| Endpoint | Formats | Page size default / max | Paging | Default sort |
|---|---|---|---|---|
| `GET /referentiel/sites` (`.csv`, `.xml`) | json, geojson | 1000 / 10000; depth 20000 | `page` + `size` | code_site asc |
| `GET /referentiel/stations` | json, geojson | 1000 / 10000; depth 20000 | `page` + `size` | code_station asc |
| `GET /observations_tr` | json, geojson, csv, xml | 1000 / **20000** (20001 → 400) | **cursor only**, no depth limit | **date_obs desc** |
| `GET /obs_elab` | json, geojson, csv | 1000 / 20000; depth 20000 | cursor | code_station, date_obs_elab asc |

- `observations_tr` filters:
  - `code_entite`: station or site codes, comma list, **wildcard prefixes** such as `A*,B*,D*,E1*`.
  - `grandeur_hydro=H|Q|H,Q`.
  - `date_debut_obs` / `date_fin_obs` (UTC; **no earlier than 1 month ago**).
  - `bbox=minLon,minLat,maxLon,maxLat`, or `latitude`/`longitude`/`distance`.
  - `code_statut` (0 no validation, 4 raw, 8 corrected, 12 pre-validated, 16 validated).
  - `fields=` ("experimental" but works), `sort`, `size`, `cursor`.
  - `timestep` (10–60 min, single `code_entite`; it **samples** rather than averages, aligns to `date_debut_obs`, returns unsorted results and pages by page number).
  - There is **no river filter**. Filter by river in `referentiel/stations` (`code_cours_eau=B---0000` or `libelle_cours_eau=`) and pass the codes.
- `referentiel/stations` filters: bbox, `code_cours_eau`, `libelle_cours_eau`, `code_departement`, `code_region`, `code_site`, `code_station` (wildcard), `en_service`, `date_ouverture_station`, `date_fermeture_station`, `code_sandre_reseau_station`, `libelle_station`, `fields`, `format`.
- **Units: H in mm, Q in l/s.** Verified: Chooz H = 491 mm matches Vigicrues 0.49 m; Uckange Q = 11200 l/s matches 11.2 m³/s.
- **Time is UTC with `Z`.** A station comment such as "A partir du 23/03/2007, les données sont en TU" means older archives may be in local time.

**Recommended poll** (every 10–15 min):
```
GET https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite=A*,B*,D*,E1*,E2*,E3*&date_debut_obs=<now-3h>&size=20000&fields=code_site,code_station,grandeur_hydro,date_obs,resultat_obs,code_qualification_obs,code_statut
```
- Measured: `A*,B*,D*,E*` over 3 h → 200, 19,099 rows, 3.66 MB uncompressed, 9.3 s, one page. `A*,B*,D*,E1*,E2*,E3*` over 20 min → 155 rows in 0.8 s. The planned poll is about 5–7k rows per call and about 100–150 calls per day.
- Follow `next`, send `Accept-Encoding: gzip`, upsert on (code_station, grandeur, date_obs), drop rows where `code_station` is null, and convert mm → m and l/s → m³/s.
- **Use a 2–3 h overlapping window**, because hourly-transmitting stations deliver late.
- (P5a: `next` is the field of the JSON body, and the recorder follows it; the `Link` header is not read. A page with a `next` is HTTP 206. `count` is the total of the whole walk, not the length of the page (6,592 in the example below, for 5 rows), so a parser never compares the two. A day with few values leaves series out of the payload, so a registry derived from one day of runs does not know a series that delivers only on other days: KG-123.)
```json
GET …/observations_tr?code_entite=B720000001&grandeur_hydro=H&size=5      → HTTP 206 Partial Content + Link: first/prev/next
{"count":6592,"next":"https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite=B720000001&grandeur_hydro=H&cursor=AoJw9Jfr...&size=5",
 "api_version":"2.0.1","data":[{"code_site":"B7200000","code_station":"B720000001","grandeur_hydro":"H",
 "date_debut_serie":"2026-09-23T00:05:00Z","date_fin_serie":"2026-09-23T19:30:00Z","code_systeme_alti_serie":31,
 "date_obs":"2026-09-23T19:30:00Z","resultat_obs":491.0,"code_methode_obs":0,"libelle_methode_obs":"Mesurée",
 "code_qualification_obs":16,"libelle_qualification_obs":"Non qualifiée","longitude":4.782579717,"latitude":50.089049099,
 "code_statut":4,"libelle_statut":"Brute","code_continuite":0,"libelle_continuite":"Continue"}]}
```
- CSV (`observations_tr.csv?...`) is `;`-separated and fully quoted, e.g. `"B5400010";"B540001001";"H";"2026-09-23T16:15:00Z";"2026-09-23T20:00:00Z";"31";"2026-09-23T20:00:00Z";"2608.0";"0";"Mesurée";"16";"Non qualifiée";...`.
- GeoJSON is CRS84. **The GeoJSON has a property typo `"code_slibelle_statuttatut"`, so use JSON for ingestion.**
- bbox `4.6,49.6,5.0,50.2` works (count 75818 for H over the month).
- Codes seen: H is `code_methode_obs=0 "Mesurée"`; Q is mostly `8 "Calculée"`. Qualification is `16 "Non qualifiée"` or `12 "Douteuse"`. Every real-time row had `code_statut=4 "Brute"`.
- Native steps: 5 min at 186 stations, 10 min at 118, 15 min at 20, 6 min at 10; Belgian partners 60 min. Many stations send hourly, so latency is 15–75 min. Basel `A021005050` was about 1.5 h behind.

**Station referential (vertical reference)**
```json
GET …/referentiel/stations?code_station=B540001001&format=json
{"code_site":"B5400010","code_station":"B540001001","libelle_station":"La Meuse à Charleville-Mézières","type_station":"STD",
 "coordonnee_x_station":823706.0,"coordonnee_y_station":6963646.0,"code_projection":26,"longitude_station":4.715855889,"latitude_station":49.75966562,
 "commentaire_station":"A partir du 23/03/2007, les données sont en TU.","altitude_ref_alti_station":140.43,"code_systeme_alti_site":3,
 "code_cours_eau":"B---0000","libelle_cours_eau":"La Meuse","commentaire_influence_locale_station":"Sous influence barrage et court-cicuité par 2 dérivations",
 "date_debut_ref_alti_station":"1993-09-01T00:00:00Z","date_activation_ref_alti_station":"2013-11-18T00:00:00Z","en_service":true}
```
- `code_projection` 26 is Lambert-93 (EPSG:2154).
- Every real-time H series has `code_systeme_alti_serie = 31` ("Système local – hauteur relative", Sandre nomenclature 76, `https://api.sandre.eaufrance.fr/referentiels/v1/nsa/76.json`). **H is relative to the gauge zero, and negative values are normal**: Épinal −255 mm, Toul −415, Stenay −44.
- The gauge-zero altitude is `altitude_ref_alti_station`, with `code_systeme_alti_site`: 3 = IGN 1969, 2 = NGF 1884 (Lallemand), 1 = Bourdeloue 1857, 0 = unknown. Example: Charleville 140.43 + 2.608 = **143.04 m NGF-IGN69**. That this field *is* the gauge zero is presumed (datum-arch: UNVERIFIED).
- Quality of the gauge-zero values across 294 real-time H stations: 206 plausible IGN69; 28 in NGF-1884 (offset about 0.3–0.4 m, varying by region, UNVERIFIED); 40 null; 14 implausible (`0.17361` A220000101, `13318.0` E364121002, `0.20627` A920107050, `24.694` B134001002, `-0.509` A060005051 sys 0). **A curated per-station table is required.**
- Belgian partner E381126601 (Lys at Menen) reports H = 10020 mm "relative", apparently on TAW.

**Pitfalls:**
1. HTTP 206 on any page that has a `next`.
2. Site-level Q (`code_station: null`) duplicates station-level Q (284 vs 287 series in 3 h).
3. Late data needs an overlap window.
4. Hard 1-month limit.
5. Negative Q (E172751201 Q = −1200 l/s).
6. The GeoJSON typo.
7. `timestep` output is unsorted.
8. `en_service` does not mean the station is delivering. Silent for 6 h: B720000003 Chooz Petit, D021000101 Solre/Erquelinnes, A694102001 Malzéville débitmètre, E131000201 Iwuy, E240041201 Tournai.
9. Foreign mirrors: Basel A021005050, Breisach A040000101, Kehl A060005050, Plittersdorf A355005050, Maxau A375005050, plus 21 Belgian partner stations (commune code `99131`). **18 NL-bound Belgian stations deliver** (Chiers, Ton, Semois, Viroin, Houille, Thure, Hante, Trouille, Lys at Menen; §0.6); **Escaut at Tournai E240041201 and Sambre at Solre-Erquelinnes D021000101 have no data at all** in `observations_tr` or `obs_elab`. Deduplicate the German and Swiss mirrors; the Belgian ones are the only ungated Belgian source.
10. `libelle_cours_eau` is sometimes null.

**FR-2 `obs_elab`**
```json
GET …/obs_elab?code_entite=B720000001,B7200000&grandeur_hydro_elab=QmnJ&size=2
{"count":62060,"data":[{"code_site":"B7200000","code_station":"B720000001","date_obs_elab":"2004-04-22","resultat_obs_elab":70642.0,
 "date_prod":"2026-08-18T08:26:11Z","code_statut":16,"libelle_statut":"Donnée validée","code_methode":10,"code_qualification":20,"grandeur_hydro_elab":"QmnJ"}]}
```
- Quantities: QmnJ, QmM, HIXnJ, HIXM, QIXnJ, QINnJ, QIXM, QINM. The case is inconsistent in the spec ("QixM" vs "QIXM"). **There is no daily-mean H.**
- History: Chooz Île Graviat B720000002 QmnJ from 1953-01-01; Chooz Trou du Diable from 2004-04-22; Uckange from 1981-10-02. Charleville, Metz, Maulde, Hanweiler and Strasbourg have nothing before 2000.
- Recent days appear 1–4 days late as raw data (`"date_obs_elab":"2026-09-14","date_prod":"2026-09-18T21:45:14Z","code_statut":4`).
- Filters: `date_debut_obs_elab`/`date_fin_obs_elab` and **`date_debut_prod`/`date_fin_prod` for incremental sync**. At most 100 codes per call. A **site** code also returns every station under it.

**FR-3 Vigicrues observations**
```
GET https://www.vigicrues.gouv.fr/services/observations.json/index.php?CdStationHydro=B720000001&GrdSerie=H&FormatSortie=simple
{"Serie":{"CdStationHydro":"B720000001","LbStationHydro":"Chooz [Trou du Diable]","GrdSerie":"H","ObssHydro":[[1784415600000,0.6], … ,[1790191800000,0.49]]}}
```
- H is in **m** and Q in m³/s (`GrdSerie=Q`). Timestamps are epoch **ms UTC**; `FormatDate=iso` gives `"DtObsHydro":"2026-09-23T20:00:00+00:00"`.
- It holds about 2 months (Chooz H from 2026-07-18T23:00Z, 13,934 points; Uckange Q from 2026-07-27). There is **no time-range parameter**.
- The station codes are the same Sandre codes as Hub'Eau.
- (P5a: the first name in `registry/seed/fr-3.csv` (Chooz) holds inner quotes, escaped as `""` since review CR-9 (they were unescaped before). Only the `code` column is used; the station names come from the Hub'Eau referentiel.)
- `GET https://www.vigicrues.gouv.fr/services/observations.json` without parameters returns only the latest timestamp per station (2,352 stations, 140 KB, 9 s), useful as a freshness index.
- `observations.xml` exists (not called).
- **Several `/services/v1.1/...` and `/services/x.json/?` URLs return 302** (to `/services/...` or `index.php`). Follow same-host redirects.
- Payloads report versions like `"VersionFlux":"Beta 0.4f"` and `"Version":"1beta"`. Documentation is at https://www.vigicrues.gouv.fr/services/v1.1 (some sections marked "TODO"). `cache-control: max-age=120`.

**FR-4 Vigicrues forecasts**
- National list: `GET https://www.vigicrues.gouv.fr/services/v1.1/prevision.json?FormatDate=iso` (18 simulations at the time; `GrdSimul=Q` for discharge).
- Per station, v1.1 route (**local `+02:00` offsets**): `…/v1.1/prevision.json?CdEntVigiCru=K490003010&TypEntVigiCru=7&FormatDate=iso`
```json
{"Simul":{"CdEntVigiCru":"K490003010","GrdSimul":"H","DtProdSimul":"2026-09-23T08:26:26+02:00",
 "CommentSimul":"… la tendance basse a 9 chances sur 10 d'être dépassée …",
 "Prevs":[{"DtPrev":"2026-09-23T23:00:00+02:00","ResMinPrev":0.42,"ResMoyPrev":0.43,"ResMaxPrev":0.44}]}}
```
- Per station, legacy route (**UTC offsets**): `…/services/previsions.json/index.php?CdStationHydro=K490003010&GrdSerie=H&FormatDate=iso` → `"DtPrev":"2026-09-23T20:00:00+00:00"`.
- The horizon was about 21 h, hourly, with P10/P50/P90.
- A non-forecast station returns `{"error_msg":"Cette station n'est pas une station de prévisions","code":400}` **with HTTP 200**.
- Territory 2 had no active forecasts: `{"message":"Problème dans l'exécution de la requête : toutes prévisions","code":204}` with HTTP 200. Charleville, Metz and Uckange returned empty `Prevs`. **Forecasts are published only during events.**
- **Correction (2026-10-01, #39):** this holds per station, not for the national list. The list is never empty: it held 27 stations on 2026-09-29 (the recorded fixture `fr-4.raw`: Sandre prefixes K, L, M, O, P, Q, R and S, the Loire, Garonne and Adour among them) and 31 in a live GET on 2026-10-01 05:51Z, and **none was in an NL-bound basin** (A, B, D, E1–E3). Fetching every listed station (about 53 requests a run, back to back) drew HTTP 429 from `www.vigicrues.gouv.fr` on every run from 2026-09-30 12:20Z, about 3 a run, with no `Retry-After`. FR-4 now fetches only the stations in the basins FR-1 captures, 2 s apart; outside an NL-bound event a run is the two list requests (R-059).

**FR-5 vigilance and reference data**
- `GET https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson` (the `/services/1/InfoVigiCru.geojson` path redirects here): 2.2 MB, 337 MultiLineString features (WGS84). Properties include `CdEntCru` (e.g. `LO18` "Meuse frontalière - Semoy", `SA15` "Rhin canalisé aval", `AP1` "Sambre", `AP13` "Lys amont - Laquette"), `cdensup_1` and **`NivInfViCr` (1 green, 2 yellow, 3 orange, 4 red)**. Top level: `DtHrInfoVigiCru` (e.g. `2026-09-23T13:57:13+00:00`) and `RefInfoVigiCru`. Everything was at level 1.
- Territories: `GET …/services/TerEntVigiCru.json`. Relevant: **2 Meuse-Moselle, 3 Rhin-Sarre, 29 Bassins du Nord**.
- Stations: `GET …/services/StaEntVigiCru.json` (2,376 stations, 1.7 MB); detail at `…/v1.1/StaEntVigiCru.json?CdEntVigiCru=B540001001&TypEntVigiCru=7`. Many fields hold the placeholder "A renseigner obligatoirement".
- Station page data: `GET …/services/station.json/index.php?CdStationHydro=B540001001` gives `StationPrevision`, `CruesHistoriques` (e.g. `{"LbUsuel":"Crue de janvier 1991","ValHauteur":5.47}`), neighbours and Lambert-93 coordinates.
- Bulletin: `GET …/services/bulletin.json?CdEntVigiCru=2` redirects to `index.php`.
- **No machine-readable per-station vigilance thresholds were found (UNVERIFIED that none exist).**
- **Station → section link (gap check) [V].** In `StaEntVigiCru` the upward link is a placeholder (`aNPlusUn.CdEntVigiCruSuperieur: "A renseigner"`), but the **downward link is populated**: `GET https://www.vigicrues.gouv.fr/services/v1.1/TronEntVigiCru.json?CdEntVigiCru=LO18&TypEntVigiCru=8` (302 → `/services/TronEntVigiCru.json?…`) returns `aNMoinsUn` with the section's stations (LO18 "Meuse frontalière - Semoy": 15 stations, including the Belgian Semois gauges Bouillon, Tintigny, Membre and Chiny, and Chooz). `TerEntVigiCru.json?CdEntVigiCru=2&TypEntVigiCru=5` lists a territory's sections. For territories 2, 3 and 29: **56 sections, 331 station links, each station in exactly one section.** Build the station → section table from these calls daily (about 60 small requests); keep a spatial join to the `InfoVigiCru` MultiLineStrings only as a cross-check and a manual override table for exceptions.
- **No vigilance section covers the French Escaut, Scarpe or Deûle.** Territory 29 has only the Sambre, Helpe, Solre, Aa, Liane, Somme, Hem, Lys amont, Lys plaine, Lawe-Clarence, Canche and the Oise/Aisne sections. French Scheldt-basin stations stay `no-ref` unless another class exists.
- **Schema drift:** a 2023-12-11 archive of `InfoVigiCru.geojson` uses `LbEntCru`, `AcroEntCru`, `DhCEntCru`, `TypEnSup_1`; today's file uses `lbentcru`, `acroentcru`, `dhcentcru`, `typensup_1`. Parse keys case-insensitively and alarm on drift.
- Coverage: Vigicrues has 263 stations in the relevant basins (A, B, D, E1–E3). All are in the Hub'Eau catalogue and 259 appeared in Hub'Eau real time. **Hub'Eau is a superset for observations.**
- Vigicrues Chooz event text: *"Les débits inférieurs à 40 m3/s sont calculés à la station Chooz Trou du Diable"*.
- (P7a, 2026-10-03, from the recorded payloads and the owner's export:)
  - `CruesHistoriques` sit under **`VigilanceCrues.CruesHistoriques`** of `station.json` as `[{LbUsuel, ValHauteur (m), ValDebit}]` (`ValDebit` 0 means none), for example Charleville, Stenay and Chooz.
  - `InfoVigiCru` property keys are lowercase today (`lbentcru`, `acroentcru`, `typensup_1`, …) and mixed case in 2023 (`LbEntCru`, `AcroEntCru`, `TypEnSup_1`, …); the **`id` is a string now and a number in 2023**, and `cdint` is null on 8 of 233 features. A parser must read one case-insensitive map of the known keys and treat any other key as drift.
  - The Wayback copy of 2023-12-11 is cut at 1 MiB: 37 complete features survive and **the top-level `DtHrInfoVigiCru` is missing** (it came after the cut), so a fixture from it carries no issue time.
  - The `TronEntVigiCru` documents of territories 2, 3 and 29 give 56 sections and 331 stations (393 section-station links), 233 of them with an FR-1 station id; the French Escaut, Scarpe and Deûle stay without a section.

**FR-6 HydroPortail:** https://www.hydro.eaufrance.fr/ (v3.5, installed 19/05/2026). Pages `/stationhydro/B720000001/fiche` and `/sitehydro/B7200000/fiche`; export UIs `/export/donnees-hydro/station/selection` and `/export/series-hydro/selection`. Whether exports need an account is UNVERIFIED.

**French station counts, NL-bound basins**

| Basin (Sandre zone) | Catalogue | en_service | Real-time H | Real-time Q (station) |
|---|---|---|---|---|
| Rhin + Ill + Alsace (A0–A3) | 222 | 93 | 79 | 67 |
| Moselle (A4, A5, A7, A8) | 101 | 60 | 49 | 43 |
| Meurthe (A6) | 44 | 28 | 21 | 19 |
| Sarre + Nied (A9) | 42 | 32 | 27 | 25 |
| Meuse (B, excluding B4 and B6) | 43 | 33 | 30 | 22 |
| Chiers (B4) | 18 | 14 | 14 | 11 |
| Semoy (B6) | 7 | 7 | 5 | 7 |
| Sambre (D) | 25 | 21 | 18 | 15 |
| Escaut (E1) | 21 | 13 | 12 | 11 |
| Scarpe (E2) | 16 | 9 | 8 | 7 |
| Lys / Deûle / Marque (E3) | 46 | 36 | 31 | 18 |
| **Total** | **585** | **346** | **294** | **245** |

E4 (Aa/Yser), E5 and E6 (Canche, Somme) do not drain to the Netherlands. About 298 stations deliver any real-time series.

### 2.6 LU-1 to LU-7: Luxembourg (AGE, inondations.public.lu)

- `inondations.lu` redirects (302) to `https://inondations.public.lu/`. The site was **relaunched on Adobe AEM in February 2026**. Every old export URL (e.g. `https://www.inondations.lu/water-level-export/all`) now redirects to the home page, although the INSPIRE metadata still points to them.
- AGE runs WISKI 7 and SODA 5 internally, but there is **no public KiWIS, SOS or SensorThings**. There are 42 water-level stations and 18 rain gauges.

**LU-1 CSV (CC0)**
- `GET https://inondations.public.lu/dam-assets/ctie/datas/Water-Levels-LocalTime.csv`: about 154 KB, `text/csv`, `cache-control: public, max-age=14400`. `last-modified` is about the request time.
- Wide format: the header is `"Name","Number","Unit","18.09.2026 22:30",…` with 480 time columns (5 days); one row per station, 42 rows, plus a **trailing empty column**. (P5b: **AGE changed the file on 2026-09-30** (measured on the owner's export of the production archive). The recording of 2026-09-29 is the old format. Since then the file holds 7 days (672 labels), and its rows are exactly as wide as the header, with no trailing field. In the old format the Esch-Sure row carried one value more than there were labels, in the field after the last label; in the new one Esch-Sure fills all 672 cells. The loader reads both widths, and a value after the last label withholds the row as `row_width`.)
```
"Name","Number","Unit","18.09.2026 22:30","18.09.2026 22:45",…
SN_Remich,,cm,… last "23.09.2026 22:15" = 347.0
Esch-Sure,,m,… 314.35        (reservoir, absolute m NN)
```
- **The `Number` column is empty**, so match rows by name (`SN_Remich`, `Gemünd_Our`, …).
- **Labels are 15 minutes late.** The value under label T is the JSON and PEGELONLINE value for T−15 min (479/480 matches at Diekirch and Stadtbredimus; 94/94 at Perl; 95/95 at Stadtbredimus). **Measure the offset daily** (compare shifts of −15, 0 and +15 against the JSON); do not hard-code it. (P5b: this holds for the old 5-day format only. Against the DE-1 Perl series the recording of 2026-09-28 matches at −15 minutes (96 of 96 instants), and the 7-day format since 2026-09-30 (2026-09-29, from the seed) at 0 (96 of 96): the labels are on time. The loader's default offset is therefore 0, the daily detector measures it, and a return to the old behaviour would be an alert; C14.)
- Timestamps are **local time without offset** (`dd.mm.yyyy HH:MM`). Since 09/2026 they are local time with DST; before that they were UTC+1 (the INSPIRE metadata's "UTC+1 all year" is out of date). The hour that repeats on 25 Oct 2026 (02:00–03:00) is ambiguous.
- The companion `…/Water-Levels-Localstation.csv` listed on data.public.lu returns **404**.

**LU-2 per-station JSON**
- URL pattern: `https://inondations.public.lu/content/dam/inondations/ctie/datas/<File>.json` (also served under `/dam-assets/ctie/datas/`). The file name comes from the station page's `jsonFile`.
- Names must be URL-encoded, e.g. `Ettelbr%C3%BCck-Alzette.json`, `Pétange.json`, `Müllerthal.json`, `Gemünd_Our.json`. Moselle files: `SN_Grevenmacher.json`, `SN_Stadtbredimus.json`, `SN_Wasserbillig.json`. `SN_Remich.json` returns **404**. Irregular spellings: `Hunnebuer.json` (station "Hunnebour"), `Roodt-sur-Syre.json`, `Esch-Sure.json`.
```json
[{"ts_path":"0/11/W_out/15m.Cmd.RelAbs.P","ts_unitsymbol":"cm","station_name":"Diekirch","parametertype_name":"W","rows":"671","columns":"Timestamp,Value",
  "data":[["2026-09-16T22:15:00.000+02:00",122.0], … ,["2026-09-23T21:45:00.000+02:00",121.0]]}]
```
- **Use the `ts_path` code as the ID**: AGE numbers (`0/11/…` = Diekirch); Service de la navigation numbers for the Moselle (`0/02610012/W1/…`); the WSV number for Perl (`0/26100100/W/…`); the LfU RLP suffix `W_out_LFU` (Gemünd `0/26260303/…`). (P5c: the forms measured on the 39 files of the owner's export of 2026-10-02, all distinct, so `ts_path` is a usable key: the AGE stations `0/<n>/W_out/15m.Cmd.RelAbs.P` with n from 1 to 109 (`0/11` Diekirch); the Esch-Sûre dam `0/40/W_out_LAC/15m.Cmd.RelAbs.P` (m, the only `_LAC`); Perl `0/26100100/W/15m.Cmd.RelAbs.P`; Stadtbredimus `0/02610012/W1/15m.Cmd.RelAbs.P`; Grevenmacher **`0/02610015/W4/15m.Cmd.O`**, whose last segment differs (`Cmd.O`, not `Cmd.RelAbs.P`); Wasserbillig `0/00229151/W/15m.Cmd.RelAbs.P`. The two LfU RLP files are not fetched, so no `W_out_LFU` path is among them. The registry keeps each file's `ts_path` and unit in `registry/seed/lu-2.csv`.)
- Values are cm above the gauge zero. The exception is Esch-Sûre dam (`W_out_LAC`, m, e.g. 314.35 m NN).
- Local time with offset. About 671 values, a rolling 7 days (the site chart shows 72 h). Missing values are omitted rather than set to null (30-min gaps seen at Livange and Schoenfels).
- Latency is usually 11–19 min; the 22:00 CEST value appeared between 20:10:55 and 20:18:56 UTC. Perl, Eischen and Ubersyren lag 30–60 min; Eischen sends hourly, and every 15 min once the level is above 100 cm.
- **No CORS. Cloudflare `max-age=14400`. `last-modified` is always the request time and there is no ETag. `robots.txt` has `Disallow: /*?*`, so never add cache-busting query parameters.** Also, never let an intermediate cache sit between our collector and AGE.
- Load: 42 files × about 27 KB every 15 min is about 105 MB per day (0.05 requests/s). One 154 KB CSV every 15 min is the lighter alternative. Send a User-Agent with a contact e-mail.

**LU-3 forecasts**
- URL: `https://inondations.public.lu/percentile/<slug>-p50.json` (also `-p10`, `-p30`, `-p70`, `-p90`).
- Slug: take `forecastsFileName` if the page has one, else the station `id`. Trim, lowercase, strip accents, turn `/` (with any surrounding spaces) into `-`, turn spaces into `-`, and collapse repeated `-`. `Ettelbrück-/-Alzette` → `ettelbruck-alzette`; Gemünd → `gemund-our`.
```json
{"rows":null,"columns":null,"data":[["2026-09-23T20:00:00.000+02:00",121.0],…],"ts_path":null,"ts_unitsymbol":null,"station_name":"DIEKIRCH","parametertype_name":null}
```
- Values are cm. **There is no issue time**: use the first step (one hour before the latest full hour) plus a content hash as the run ID.
- Stations returning 200: ettelbruck-alzette, ettelbruck-wark, hesperange, mersch, bissen, bigonville, diekirch, rosport, kautenbach, dasbourg, gemund-our, perl, stadtbredimus, wasserbillig. Configured but 404: bollendorf (48 h window) and grevenmacher.
- Horizon: 46 hourly steps from AGE (LARSIM model) and 45 from LfU RLP (Perl, Stadtbredimus, Wasserbillig). The site shows only h24/h48 per station (`forecastsLimit`); **respect that display limit.**
- Cadence: AGE hourly (the site says "toutes les heures"; the government page says "at least every three hours, hourly during floods"). LfU jumped from 17:00 to 20:00 CEST, suggesting 3-hourly runs (partly verified). How the percentiles are produced is UNVERIFIED.
- (P8a, 2026-10-03, [V] from the owner's D2 export of the production archive; counts and instants only:) **every hourly file is a new run**: the window moves by one hour and the values differ from the previous hour's, so successive captures never share a run (no head is dropped, unlike NL-1). 827 of the 830 station-hours with archived files hold all five percentile files within about 5 seconds, and 198 further station-hours are all `dup_of` (no new run that hour); no hour had some files `dup_of` and others not. The first step lies about 105 minutes before the fetch (which agrees with "one hour before the latest full hour" above), runs have 45 or 46 hourly steps, and no value is null. The LU-4 pages' `forecastsLimit` (display metadata, no water value) is `h24` for nine of the eleven stations (bigonville, bissen, dasbourg, diekirch, both Ettelbruck stations, hesperange, kautenbach, mersch) and `h48` for rosport; gemund-our has no LU-4 page (LfU RLP, not fetched).
- **Moselle floor:** below a set level the forecast is a flat line. Floors: Perl 250 cm, Stadtbredimus 260 cm, Wasserbillig 220 cm ("with uncertainties"), Mondorf 250 cm. Perl's p10 = p50 = p90 = 250.0 while the observed level was about 212 cm. **Mark such values "below forecastable range".**
- **There is no archive; each run overwrites the last.**

**LU-4 station metadata and thresholds**
- Each page `https://inondations.public.lu/{fr|de|en}/<basin>/<river>/<station>.html` contains `<cmp-dashboard-station data-to-json="{…}">`. There is no Luxembourgish or Dutch version (404).
- Fields: `id`, `jsonFile`, `levelsMax` (yellow/orange/red vigilance; **0 = not defined**), `newVigilanceList` (HQ2…HQ100 as **water level in cm**), `zeroScale` (m NN), `pk` (river km), `basinVersion` (km²), `coordinates` (LUREF E/N), `serviceDate`, `operator`, `forecastsCalcul`, `forecastsLimit` and `bannerInfoText` (FR/DE/EN notes, e.g. dam influence or datum changes).
- Data errors: Hesperange easting `786023` is invalid (take geometry from LU-6); Heiderscheidergrund's date is `01.111996`; the yellow level is 0 everywhere except Stadtbredimus (530 cm).
- Official alert gauges ("Station d'alerte officielle"): Ettelbrück/Alzette, Hesperange, Mersch, Pfaffenthal, Steinsel, Bissen, Reichlange, Hunnebour, Ettelbrück/Wark, Perl, Stadtbredimus, Bigonville, Bollendorf, Diekirch.
- The home page status class per station is computed by AGE: `lowerboundexceeded` (< MNQ), `mnq` (< MQ), `mq` (< HQ2), `hq2`, `hq10`, `hq20`, `hq50`, `hq100`, `notavailable`. The underlying MNQ and MQ levels are **not** published.

**LU-5 LU-Alert CAP-LU**
- Dataset "Alertes du système LU-ALERT": https://data.public.lu/fr/datasets/alertes-du-systeme-lu-alert/ (id `67aca67bcaea3ae62308114f`).
- Poll `https://data.public.lu/api/2/datasets/67aca67bcaea3ae62308114f/resources/?page_size=20` (newest first, about 4 KB). Each alert is one XML file `dump-alert.<epoch>.xml`. There are 836 files since 2025-06, from **all** senders. Delay: sent 11:46:21Z, published 11:50:07Z.
- **Filter on `<sender>[AGE]` and `eventCode FLOOD`.** Discard tests (`cb-eu-level=TEST`, headline starting "TEST").
- Content: `msgType` Alert/Update/Cancel with `references`; `info` blocks in fr-FR, de and en-US; area polygons (lat,lon) for **"AGE Zone Nord du Luxembourg" / "Sud" / "Moselle"**; parameters `…:cap-lu:1.0:name` (e.g. "Vigilance jaune inondations Moselle") and `…:cb-eu-level`. **ALERT_LVL_1 = red, 2 = orange, 3 = yellow, 4 = information.**
- Level meanings: Information (no risk), Yellow ("Soyez attentifs"), Orange (bulletins at least daily), Red (bulletins at least twice a day).
- **Archive contents (gap check, all 833 dumps downloaded, 30 MB) [V]:** senders `[ALVA]` 565, `[Meteolux]` 157, `[CGDIS]` 72, **`[AGE]` 25**, `[Police]` 8, `LU-Alert` 5, `[Crise]` 2. The AGE messages are real flood fixtures: 2025-09-08 yellow → orange → **red** (Sud) and yellow → orange (Nord); 2025-09-09 red update, then information; 2025-09-23..25 yellow → orange → information (Sud); 2026-02-13/14 yellow → information (**Moselle**). Pitfalls: **`Cancel` messages carry no `<info>`** (only `<references>[AGE],<identifier>,<sent></references>`), and the **2026-02-02 TEST message has `<status>Actual</status>`**, `cb-eu-level` `TEST` and a headline starting "TEST". Each alert carries fr-FR, de and en-US `info` blocks and an `expires`.
- Undocumented alternative (not recommended): `https://inondations.public.lu/ctie/lualert?sender=AGE[&status=INPROGRESS]` (`x-totalresult: 710`, history since Jan 2025; its query strings are disallowed by robots.txt).
- (P7a, 2026-10-03, from 24 real `[AGE]` files:) the `eventCode` `valueName` is **`LU-Alert` in the 2025 files and `LU_Alert` in 2026**. A Cancel has no `<info>` and names its target in `<references>` (`[AGE],<identifier>,<sent>`); an Update references the message it replaces the same way. The real 2026-02-02 TEST carries `<status>Actual</status>`, so a TEST is told only by `cb-eu-level` `TEST` or its headline. The area descriptions are "Sud du Luxembourg", "Nord du Luxembourg" and "Moselle".

**LU-6 geometry**
- pygeoapi 0.23.4: `https://features.geoportail.lu/collections/655/items?f=json&limit=100`. 51 features with `Nom`, `Etat_de_se`, `Hyperlinks` (station fiche PDF), `Hyperlin_1` (photo) and `Hyperlinks_graph` (always null). bbox filtering works; CORS `*`. No values.
- WMS layer `655` exists; there is no WFS (GetCapabilities returns 400).
- The INSPIRE EF GML (EPSG:3035) is stale.
- data.public.lu "Niveau d'eau" (id `59c220a4111e9b1de61d8864`, last updated 2026-09-11) also offers `…/20260911-010313/wasserstand.geojson` (51 features) and Geocatalogue record `124abb10-1d87-4449-912b-06fbf307a95f`.
- Station fiche PDFs: `http://geoportail.eau.etat.lu/pdf/hydrometrie/FichesStations/<code>-<Name>.pdf` (e.g. `11-Diekirch`, `00229150-Remich`, `02610015-Grevenmacher`). Contact: `hydrometrie@eau.etat.lu`.
- (P5b, from the recorded collection: the `Nom` spellings differ from the LU-1 names (`Uebersyren`, `Hunnebour`, `Roodt-Syre`, `Mersch ( Beringen )`, `Esch/Sûre`, `Gemünd`, `Stadtbrediums`), `Kautenbach` occurs twice (fiche 14 and 104, both in service) and `Niederfeulen` twice (27 in service, 77 out of service), and Perl has no point. The registry therefore joins an LU-1 name to its LU-6 point by the **fiche number**, the number in the link's file name, kept as text: Wasserbillig `0029151` (the file name is `0029151- Wasserbillig.pdf`, with a space; sic), Remich `00229150`, Stadtbredimus `02610012` (the file name spells it Stadtbredimus), Grevenmacher `02610015`, Gemünd `2626030300`.)
- geoportail has 9 more entries than inondations: Bavigne, Grondmillen, Rommelerkräiz, Schéimelzerbesch, Drosbech, Reisdorf, Sassel, Kautenbach (104) and 2 out of service. Rain gauges are collection 609 (18).
- Flood-zone collections: 3036, 3037, 3065, 3261–3263.
- **Datum:** gauge zeros are in "m NN" (NG95, tied to NAP). They agree with NHN within 1 cm at shared gauges (Perl 138.50 vs 138.491). **Zeros change**: Diekirch 185.41 since 2012-01-02 (186.61 before); Steinsel went from 223.26 to 222.26. Store them with validity periods.
- Coordinates: WGS84 from LU-6; LUREF (EPSG:2169) on the pages.

**Duplicates with PEGELONLINE**
- Perl and Stadtbredimus are **byte-identical** to PEGELONLINE 26100100 and 26100130 (669/669 and 671/671 values over 7 days).
- Grevenmacher is a near-duplicate of 26100200 (303/670 identical, differences up to 3 cm).
- Remich, Wasserbillig and all Sûre, Our and Alzette stations are **not** in PEGELONLINE.
- Rule: take Perl and Stadtbredimus from PEGELONLINE only, but keep AGE's Stadtbredimus thresholds on that station. For Grevenmacher, pick one source (AGE's thresholds refer to the AGE value). Take everything else from AGE.
- Bollendorf and Gemünd are LfU RLP gauges passed through by AGE. RLP's code for Bollendorf is UNVERIFIED.

### 2.7 CH-1 to CH-11: Switzerland (BAFU)

**CH-1 LINDAS (the official live feed)**
- BAFU statement (https://www.hydrodaten.admin.ch/de/aktuelle-hydrologische-daten-beziehen): the data "are also published on LINDAS and are updated every 10 minutes". Contact: abfragezentrale@bafu.admin.ch.
- The query below returned 201 rows for 199 stations in about 2 s. POST it to `https://ld.admin.ch/query` with `Accept: text/csv`:
```sparql
PREFIX h: <https://environment.ld.admin.ch/foen/hydro/dimension/>
PREFIX schema: <http://schema.org/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX cube: <https://cube.link/>
SELECT ?id ?name ?water ?time ?q ?w ?t ?dl ?wkt WHERE {
  <https://environment.ld.admin.ch/foen/hydro/river> cube:observationSet ?set .
  ?set cube:observation ?obs .
  ?obs h:station ?st ; h:measurementTime ?time .
  ?st schema:identifier ?id ; schema:name ?name .
  OPTIONAL { ?st schema:containedInPlace ?water }
  OPTIONAL { ?st geo:hasGeometry/geo:asWKT ?wkt }
  OPTIONAL { ?obs h:discharge ?q } OPTIONAL { ?obs h:waterLevel ?w }
  OPTIONAL { ?obs h:waterTemperature ?t } OPTIONAL { ?obs h:dangerLevel ?dl }
}
```
- For lakes, replace `river` with `lake`. A single observation is at e.g. `https://environment.ld.admin.ch/foen/hydro/river/observation/2091` (`Accept: text/turtle`).
- Units come from the shape `https://environment.ld.admin.ch/foen/hydro/river/shape`: `unit:M3-PER-SEC`, `unit:M`, `unit:DEG_C`; the danger level is an integer.
- The cube `dateModified` moved from 19:54:10Z to 20:04:03Z (a 10-min cycle).
- `measurementTime` is always a **fixed `+01:00`** (`2026-09-23T20:40:00+01:00` = 19:40Z).
- Most stations are on a 10-min clock; some report every 20 or 60 min.
- Stale stations: 2269 Blatten (destroyed by the 2025-05-28 rockslide); 2283 since 2026-09-17; 2356 since 2026-09-22. The shape's `sh:minInclusive` reveals the oldest stale timestamp. **Check freshness per value.**
- Duplicates: stations 520 and 2283 return two observations each; keep the latest. (P5a: the river payload of 2026-09-29 also had duplicates at 2303, 2288, 2417 and 2252.)
- 36 stations have `dangerLevel` = `https://cube.link/Undefined` (no thresholds).
- Some small stations report relative levels (0.074 m, −0.137 m).
- 2289 Basel and 2205 Stilli have no temperature. 2288's temperature is flagged as distorted (the flag is visible on hydrodaten only).
- Anchor every query on the cube; broad unanchored queries timed out at 90 s. The endpoint's own terms are UNVERIFIED.

**CH-2 `hydro_sensor_pq.geojson`** (about 250 KB, EPSG:2056; also `hydro_sensor_warn_level.geojson` and `hydro_sensor_pq_forecast.geojson`)
```json
{"key":"2091","label":"Rhein - Rheinfelden, Messstation","kind":"river","hydro_body":"Rhein von Mündung Aare bis Mündung Ergolz",
 "last_value":"475","metric":"discharge_ms","unit":"m³/s","last_measured_at":"2026-09-23T22:00:00.000+02:00",
 "min_24h":"292","max_24h":"475","mean_24h":"358","sensor_waterlevel_last_value":"261.35 m ü.M.",
 "wl_1":"2500 m³/s","wl_2":"3000 m³/s","wl_3":"3600 m³/s","wl_4":"4500 m³/s","threshold_customer":"1760 m³/s","failure_text":null,"failure_valid_from":null}
```
- `wl_1`–`wl_4` are the **lower bounds of danger levels 2, 3, 4 and 5**; 180 of 207 stations have them. For lakes they are in m ü. M. (Ägerisee `724.10 m ü.M.`).
- `threshold_customer` exists for 16 stations; its meaning is UNVERIFIED.
- **Values are strings with units attached; strip the units.** `failure_text` is in the station's own language. (P5a: `metric` is `masl` for 34 of the 207 stations, which publish a level in m ü.M. as their main value, and some of them have a discharge sensor as well (2446 and 2447: `sensor_discharge_last_value`); the six stations on `discharge_ls` publish l/s; three stations (2384, 2283, 2282) state a relative level in plain `m`. `sensor_waterlevel_last_value` and `sensor_discharge_last_value` are what the adapter reads.)
- `produced_at` was 22:08:06 local; the latest value 20:00Z was seen at 20:08Z.
- There is no robots.txt (404).

**CH-3 plot JSON**
- `https://www.hydrodaten.admin.ch/plots/p_q_7days/{id}_p_q_7days_{de,en,fr,it}.json`, `…/plots/p_q_40days/{id}_p_q_40days_{lang}.json`, `…/plots/temperature_7days/…` and `…/plots/pq_group/{id}_pq_group_5_{lang}.json`.
- Plotly traces "Wasserstand" (m ü. M.) and "Abfluss" (m³/s) at 5 min; 40 days is 11,480 points and about 900 KB per station.
- Local timestamps with offset (`2026-09-17T00:05:00.000+02:00`).
- Threshold bands sit in `layout.shapes` (yellow #FFFF00, orange #FF9900, red #F7001D, dark red #800000).
- `pq_group` for 2091 returns Rheinfelden, Aare-Brugg, Reuss-Mellingen, Limmat-Baden and Thur-Andelfingen.
- Station HTML: `https://www.hydrodaten.admin.ch/de/seen-und-fluesse/stationen-und-daten/{id}` (the old `/de/{id}.html` redirects with 301).

**CH-4 forecasts:** `https://www.hydrodaten.admin.ch/plots/q_forecast/{id}_q_forecast_{lang}.json`.
- Hourly median, 25–75 % band, min/max, the last 24 h of measurements, and threshold bands.
- The run seen started 19:00 local and ran **115 h** (to 14:00 on 28 Sept).
- Model: WaSiM, hourly. The ensemble has "21 model results"; the link to ICON-CH2-EPS (21 members, 5 days) is UNVERIFIED.
- Published "once a day (several times a day during floods)". 55 forecast stations; every key station in §3.1 has one.
- **There is no run ID: a change in run start plus `Last-Modified` defines a new run.**
- **Flood-state fixture (gap check):** the Wayback Machine holds `2020_q_forecast_it.json` from 2023-11-02 10:33Z (storm Ciarán): median up to 476 m³/s, max 800 m³/s, threshold bands at 700/1100/1450/1800 m³/s. Same structure as today, but trace names are localised ("Mediana", "Misurato") and even inconsistent within one file ("Min. / Max." and "Min / Max"). Always fetch `_de` and check trace order as well as names.

**CH-5 / CH-6 warnings and classes**
- CH-5 `hydro_warn_levels_{lang}.geojson`: 93 sections (river, lake, region) with `level`, `valid_from` and `valid_until`; one was issued 07:24 local and valid until 25.09 11:00.
  - (P7a, 2026-10-03, from the P1a recording and the export of 2026-10-03:) `level` is an **integer 0 to 5**; **level 0 is "Keine Gefahrenstufe"** (no hazard stated), not a danger level. The payload's `meta` holds the legend in de, fr, it and en, the `en` file translates labels and `hydro_body`, and the geometries are **LV95 (EPSG:2056)**; the public map needs WGS84. No real flood payload has been recorded.
- CH-6 layers:
  - `…_zustand`: 200 features, percentile class 1–5, 0 = no data.
  - `…_gefahren`: 182 features, danger level (178 at level 1, 3 at 0).
  - `…_vorhersage`: 55 stations (Abfluss 40, Pegel 15).
  - `ch.bafu.hydroweb-warnkarte_national`: 93 features (42 river MultiLineStrings, 13 lakes, 38 region MultiPolygons), `ws-class` such as `River.1`/`Region.0`. `ID` is not unique across types; issued 05:24Z.
  - The `api3.geo.admin.ch` feature lookup returns 400 "No Vector Table"; use the GeoJSON directly.
  - `…_gefahren/data.zip` is stale (Last-Modified 2024-08-27).
- The opendata.swiss datasets are `vergleich-von-abfluss-und-pegeldaten-mit-den-gefahrenstufen`, `allgemeine-lage-der-fliessgewasser-und-seen`, `hochwasserwarnkarte` and `hydrologische-stationen-mit-vorhersagen`.
- There are 5 national danger levels; BAFU alerts the cantons through the NAZ from level 2 upward. The "Hochwasser-Ausblick" (5 days, three probability classes >70 %, 40–70 %, <40 %, updated daily at 12:00) is HTML only (machine-readable form UNVERIFIED). The authoritative wording is the Naturgefahrenbulletin on naturgefahren.ch; the old aggregated naturgefahren.ch API was reportedly discontinued (UNVERIFIED).

**CH-8 history order:** Datenservice Hydrologie (hydrologie@bafu.admin.ch), free since 2020-01-01. 5-min, 10-min or hourly means from 1974; daily, monthly and yearly values back to the 19th century (Basel-Rheinhalle Q from 1868). Quality: raw, checked (about 1 month later) or validated (the following year).
- Sample CSV `https://www.bafu.admin.ch/dam/de/sd-web/6BXSUZsNMYvz/beispiel-abfluss-stundenmittel.csv`: Latin-1, `;`, 8-line header. Columns: `Stationsname;Stationsnummer;Parameter;Zeitreihe;Parametereinheit;Gewässer;Zeitstempel;Zeitpunkt_des_Auftretens;Wert;Freigabestatus`.
- **Time-zone conflict:** the sample writes `2017-12-01 00:00:00+00:00`, while the FAQ says UTC+1 with timestamps at the start of the interval. Clarify with BAFU.
- Yearly tables are available as PDF from 1993.

**CH-9 data.bs.ch:** 657,503 records for 2289 (from 2020-06-22) and 410,279 for 2106 (from 2022-10-29), at 5 min, in UTC. `pegel` is the water level in m ü. M.; `pegelhoehe` is the gauge reading in cm, equal to water level minus 240 m ü. M.

**CH-10 existenz.ch:** `https://api.existenz.ch/apiv1/hydro/latest?locations=…&parameters=flow,height` and `/daterange`. About 30 days only (2026-08-24 present, 2026-08-10 absent).

**Swiss units, datum and time**
- Q in m³/s (`discharge_ms`); 6 small stations use l/s (`discharge_ls`).
- H in **m ü. M. on LN02** (BAFU FAQ: "…beziehen sich auf das Schweizerische Landesnivellementsnetz LN02"; BAFU does not use LHN95).
- Live data is in local time with an explicit offset (`+02:00` in summer in hydrodaten, fixed `+01:00` in LINDAS). The FAQ mislabels summer time as "UTC+2 (MEZ)". Historical exports are in UTC+1 (but see the conflict above); data.bs.ch is UTC.
- Loggers record 5- or 10-min means, rarely 2-min.
- Coordinates: EPSG:2056 (LV95) in the GeoJSON files, WGS84 WKT in LINDAS.
- opendata.swiss CKAN rejects the default curl User-Agent, so always send a descriptive UA with a contact address.
- The "Meine Pegel" app (hochwasserzentralen.info) is another distribution channel but not an API.

---

## 3. Station shortlist per basin (upstream → downstream toward the Dutch border)

**How to read these lists**
- Stations are listed upstream first. Tributaries are shown as indented blocks at the point where they join, where a report gives that point.
- Where a confluence position or order comes from general geography rather than a report, it is marked *(geo; verify in river-graph build)*. The final order must come from the curated river graph and official river-km (§5.3).
- **Bold** marks a key station. Values are snapshots from 2026-09-23, a period of extreme low water.
- Canonical-source rule: take each physical gauge from its **operating agency**. Mirrors in other feeds are listed only so they can be deduplicated.

### 3.1 Rhine (Switzerland → Upper Rhine → Lobith → Dutch branches)

**Swiss upper Rhine and Aare** (CH-1 LINDAS id = CH-2 `key`; WGS84 lon, lat; snapshot from LINDAS at 19:40Z; thresholds are the lower bounds of danger levels 2/3/4/5 in m³/s; every station below has a BAFU forecast, CH-4)

| # | Station | Provider / code | Lon, lat | Q m³/s | W m ü. M. (LN02) | Thresholds L2/L3/L4/L5 | Catchment | Record since | Note |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Rhein – Diepoldsau, Rietbrücke | BAFU **2473** | 9.64091, 47.38307 | 83.9 | 407.035 | 1300/1950/2450/3050 | 6,299 km² | Q 1919, W 1984 | Alpine Rhine above Bodensee; also O₂ and turbidity |
| 2 | Bodensee – Romanshorn / Berlingen | BAFU **2032** / **2043** (lake cube) | – | – | lake level | – | – | – | Lakes damp and delay flood waves |
| (2a) | Konstanz-Rhein | PEGELONLINE (operated by RP Freiburg), km 0.5 | – | – | – | – | – | – | Mirror with no gauge zero; optional |
| 3 | Rhein – Neuhausen, Flurlingerbrücke | BAFU **2288** | 8.62630, 47.68147 | 123.9 | 382.222 | 670/890/1000/1150 | 11,930 | Q 1904, W 1964 | Temperature flagged as distorted since 27.07.2026 |
| ↳ | Thur – Andelfingen (tributary) | BAFU **2044** | 8.68197, 47.59652 | 3.9 | 354.553 | 500/700/1150/1400 | 1,702 | Q 1904, W 1964 | Flashy river; WMO centennial station |
| 4 | Rhein – Rekingen | BAFU **2143** | 8.32983, 47.57035 | 155.4 | 321.923 | 1150/1500/1700/1900 | 14,767 | Q 1904, W 1964 | Upstream of the Aare confluence |
| ↳ | Aare – Bern-Schönau → Brügg-Aegerten → Murgenthal | BAFU 2135 → 2029 → 2063 | – | – | – | – | – | – | Regulated Jura lakes damp floods |
| ↳ | **Aare – Brugg** | BAFU **2016** | 8.19488, 47.48253 | 124.7 | 331.062 | 820/1100/1250/1350 | 11,681 | Q 1916, W 1964 | Above the Reuss and Limmat confluences |
| ↳ | Reuss – Mellingen | BAFU **2018** | 8.27127, 47.42103 | 47.3 | 343.743 | 480/640/720/830 | 3,386 | Q 1904, W 1964 | |
| ↳ | Limmat – Baden, Limmatpromenade | BAFU **2243** | 8.30941, 47.47570 | 33.7 | 349.999 | 350/480/550/630 | 2,394 | Q 1951, W 1964 | |
| ↳ | **Aare – Untersiggenthal, Stilli** | BAFU **2205** | 8.23472, 47.51591 | 207.4 | 325.415 | 1550/2050/2300/2550 | 17,553 | Q 1904, W 1975 | Below Reuss + Limmat; temperature is computed |
| 5 | **Rhein – Rheinfelden** | BAFU **2091** | 7.79991, 47.56071 | 445.4 | 261.311 | 2500/3000/3600/4500 | 34,524 | Q 1933, W 1964 | Record 4,550 m³/s on 12.05.1999. `pq_group` groups it with Aare-Brugg, Reuss-Mellingen, Limmat-Baden and Thur-Andelfingen |
| ↳ | Birs – Münchenstein, Hofmatt | BAFU **2106** (also data.bs.ch 100236) | 7.61879, 47.51832 | 1.6 | 267.128 | 140/220/280/350 | 887 | Q 1908, W 1964 | |
| 6 | **Rhein – Basel, Rheinhalle** | BAFU **2289**. Mirrors: PEGELONLINE BASEL-RHEINHALLE 2310010 (`94f6eff1-4f3f-4850-82e0-a086198e9ffd`, km 164.3, PNP 240.0 "mü.M." since 2010-02-01, W 494, HSW 820), Hub'Eau A021005050, data.bs.ch 100089 | 7.61668, 47.55943 | 456.5 | 244.938 | 2550/3050/3700/4700 | 35,878 | Q **1868**, W 1974 | Last Swiss station; no temperature. Canonical source: BAFU |
| 7 | Rhein – Basel-Klingentalfähre | BAFU 2615 | – | – | – | – | – | – | Optional |

**Upper Rhine (FR/DE)**, with PEGELONLINE km counting up downstream. Columns: PEGELONLINE number and UUID; PNP in m (datum, valid from); W now (cm); MNW/MW/MHW/HSW (cm); Q; WV (BfG forecast).

| # | Station | Provider / code | km | PNP | W | MNW/MW/MHW/HSW | Q | WV | Note |
|---|---|---|---|---|---|---|---|---|---|
| 8 | Rheinweiler | DE-1 23300130 `06b978dd-8c4d-48ac-a0c8-2c16681ed281` | 186.2 | 217.291 NHN (2018-11-01) | 197 | 192/220/564/– | Q* | – | Restrhein (old bed). Q comment: "Abflusswerte im niedrigen Bereich nicht plausibel". Most water flows through the Grand Canal d'Alsace |
| – | Breisach | Hub'Eau mirror A040000101 | – | – | – | – | – | – | Deduplicate |
| 9 | Strasbourg sémaphore nord | FR-1 **A061005051** | – | 134.21 (IGN69) | H 1203 mm | – | – | – | 10 min |
| ↳ | Ill – Strasbourg Chasseur-Froid | FR-1 **A228003001** (Montagne Verte A226032002 débitmètre) | – | 131.0 | H 1612 mm | – | 38.7 | – | 10 min |
| 10 | **Kehl-Kronenhof** | DE-1 23300900 `23af9b02-5c82-4f6e-acb8-f92a06e5e4da` (Hub'Eau mirror A060005050, zero 133.6) | 292.2 | 133.02 NHN (2018-11-01) | 185 | 180/236/426/– | Q | – | Raw Q is not mass-balanced: Kehl 406 vs Iffezheim 293 m³/s |
| 11 | **Lauterbourg** | FR-1 **A302009050** | – | 103.24 | H 2656 mm | – | 363 | – | Last French Rhine station |
| 12 | Iffezheim | DE-1 23500600 `b02be240-1364-4c97-8bb6-675d7d842332` | 336.2 | 110.019 NHN | 36 | 104/240/518/– | Q | – | |
| – | Plittersdorf | Hub'Eau mirror A355005050 | – | – | – | – | – | – | Deduplicate |
| ↳ | BW Murg: Baiersbronn, Schwarzenberg, Forbach, **Bad Rotenfels 00111**, Rastatt; BW Kinzig: Schenkenzell 00200, Wolfach, Hausach, Biberach, **Schwaibach 00002** | DE-12 LUBW | – | – | – | – | – | – | Later, with permission |
| 13 | **Maxau** | DE-1 23700200 `b6c6d5c8-e2d5-4469-8dd8-fa972ef7eaea` (Hub'Eau mirror A375005050) | 362.327 | 97.721 NHN (2017-07-18) | 285 | 353/496/785/750 | Q | – | BfG 6-week W |
| 14 | **Speyer** | DE-1 23700600 `2cb8ae5b-c5c9-4fa8-bac0-bb724f2754f4` | 400.61 | 88.467 NHN | 147 | 214/361/699/730 | Q | – | |
| 15 | **Mannheim** | DE-1 23700700 `57090802-c51a-4d09-8340-b4453cd0e1f5` | 424.733 | 85.117 NHN | 58 | 132/293/644/760 | – | – | Neckar joins at about km 428 |
| 16 | **Worms** | DE-1 23900200 `844a620f-f3b8-4b6b-8e3c-783ae2aa232a` | 443.37 | 84.112 NHN | **−22** | 46/195/529/650 | Q | – | BfG 6-week W. Main joins at Mainz, about km 497 |
| 17 | **Mainz** | DE-1 25100100 `a37a9aa3-45e9-4d90-9df6-109f3a28a5af` | 498.27 | 78.373 NHN (2019-11-01) | 105 | 159/288/547/630 | Q | – | |
| 18 | Oestrich | DE-1 25100300 `665be0fe-5e38-43f6-8b04-02a93bdbeeb4` | 518.08 | 77.562 NHN | 35 | 79/186/412/– | – | **WV** | |
| 19 | Bingen | DE-1 25300200 `0309cd61-90c9-470e-99d4-2ee4fb2c5f84` | 528.36 | 76.185 NHN | 33 | 84/195/436/490 | – | – | Nahe joins (geo; verify) |
| ↳ | Nahe: Heimbach Bhf., Oberstein 2, Kallenfels, Martinstein 2, Boos, **Bad Kreuznach 25400750**, Dietersheim; Altenbamberg (Alsenz) | DE-10 RLP | – | Bad Kreuznach 96,534 (DHHN2016) | 240 | – | – | p10–p90 | Later, with permission |
| 20 | **Kaub** | DE-1 25700100 `1d26e504-7f9e-480a-b52c-5932be6549ab` | 546.23 | 67.669 NHN | 9 | 65/208/544/640 | Q | **WV** | BfG 14-day and 6-week (W+Q). Lahn joins at Lahnstein (about km 585), the Mosel at Koblenz (about km 592) |
| 21 | **Koblenz** | DE-1 25900700 `4c7d796a-39f2-4f26-97a9-3aad01713e29` | 591.49 | 57.692 NHN | 9 | 60/214/588/650 | – | **WV** | No Q |
| 22 | **Andernach** | DE-1 27100400 `5735892a-ec65-4b29-97c5-50939aa9584e` | 613.78 | 51.504 NHN | 12 | 71/258/672/760 | Q | – | Flood travel-time anchor |
| 23 | **Bonn** | DE-1 2710080 `593647aa-9fea-43ec-a7d6-6476a76ae868` | 654.8 | 42.713 NHN | 69 | 121/290/680/– | Q | – | Sieg joins (geo): 7 NRW gauges (DE-7); RLP Betzdorf, Etzbach |
| 24 | **Köln** | DE-1 2730010 `a6ee8177-107b-47dd-bcfd-30960ccc6e9c` | 688.0 | 35.038 NHN | 53 | 114/297/725/830 | Q (586) | **WV** | BfG 6-week W+Q; HHW 1069 (1926) |
| 25 | **Düsseldorf** | DE-1 2750010 `8f7e5f92-1153-4f93-acba-ca48670c8ca9` | 744.2 | 24.529 NHN | 8 | 70/257/684/880 | Q | **WV** | Erft (4 NRW gauges) joins (geo) |
| ↳ | Ruhr: Hattingen (Ruhrverband) 2769510000100 `c0594fb5-77ff-4287-9b8d-7ff326afe9ff` km 56.9, PNP 60.384 NHN (2011-11-01), W 103, Q → Mülheim Schlossbrücke (stale since 2026-09-05) → Ruhrwehr OW 27600090 `12a3037f-cbf3-49d3-8da5-77fb38730bba` km 2.961 (unit **m+NN**, 25.00 m) | DE-1; NRW has 8 Ruhr gauges; Ruhrverband HTML about 37 gauges | – | – | – | – | – | – | Joins at Duisburg, about km 780 |
| 26 | **Duisburg-Ruhrort** | DE-1 2770010 `c0f51e35-d0e8-4318-afaf-c5fcbc29f4c1` | 780.8 | 16.106 NHN | 137 | 201/394/835/1130 | Q | **WV** | BfG 6-week W+Q. WV runs at weekends and on holidays only when Ruhrort is below 400 cm [D] (BfG) |
| ↳ | Lippe (11 NRW gauges, DE-7); WDK canal | – | – | – | – | – | – | – | Joins at Wesel, about km 814 |
| 27 | **Wesel** | DE-1 2770040 `f33c3cc9-dc4b-4b77-baa9-5a5f10704398` | 814.0 | 11.206 NHN | 74 | 144/348/804/1060 | Q | – | |
| 28 | **Rees** | DE-1 2790010 `2f025389-fac8-4557-94d3-7d0428878c86` | 837.4 | 8.743 NHN | 22 | 91/293/747/– | Q | – | |
| 29 | **Emmerich** | DE-1 2790020 `9598e4cb-0849-401e-bba0-689234b27644` | 851.9 | 7.998 NHN (2019-11-01) | **−7** | 51/239/669/870; NNW −1 (2022-08-18); HHW 986 (1926-01-03) | Q (stale, stopped below W = −1 cm) | **WV** | Last German gauge |
| 30 | **Lobith** | **NL-1 `lobith.bovenrijn.tolkamer`** (51.8495, 6.1024). Also `lobith.bovenrijn.haven` (a separate level gauge). PEGELONLINE mirror LOBITH 2790050 `efe13a3d-f239-4655-9c13-4ac56dfa4478` | 862.0 | NAP | 628 cm NAP | NL-4 classes | Q F230 ≈ 608–617 | RWS H+Q fc | **Main Rhine entry gauge** |

**Rhine tributaries upstream of Lobith**

*Neckar* (km counted from the mouth; joins at Mannheim):
- BW upper Neckar (DE-12, later): Rottweil 00146 → Oberndorf → Horb → Kirchentellinsfurt → Wendlingen → Plochingen.
- **Plochingen** DE-1 23800100 `be7ce40e-5fff-42df-8386-b42694ca86da`: km 202.56; PNP 245.86 NHN; W 152; MNW/MW/MHW 148/164/373; Q.
- **Lauffen** 23800500 `8559d1a0-4a03-410a-8910-44a089a07df8`: km 125.43; 159.37; W 217; 219/259/532; Q.
- Rockenau SKA 23800690 `4c00a166-7d6d-48d7-b4dc-673b96b4041e`: km 60.7; 119.71; W 210; 208/237/623; Q (fault).
- Heidelberg UP 23800760 `827b2685-47ec-44df-a90f-980f5e0c1591`: km 26.1; 103.22; W 205; 207/220/401/260; Q stale 26 days (*"Abflussermittlung unter W=221cm nicht möglich"*).
- Mannheim Neckar 23800900 `25582d3f-dc5f-4c70-bd08-e84fd13201ca`: km 3.1; 84.787; W 53; no characteristic values.
- Most other Neckar gauges are lock "Schleuse UP" gauges, and 13 of them have no coordinates.

*Main* (km from the mouth; joins at Mainz):
- Bavarian upper Main (DE-13, later): Schwürbitz 24006007, Mainleus, Kemmern, Unterlangenstadt; Fränkische Saale at Wolfsmünster; Mittelsinn.
- **Würzburg** DE-1 24300600 `915d76e1-3bf9-4e37-9a9a-4d144cd771cc`: km 251.97; 164.511 NHN; W 152; 140/174/515/340; Q.
- Kinzig (Hessen; DE-11, later): Sannerz (stale), Steinau, Ahl, Gelnhausen, Hanau, Hanau-Mündung (joins at Hanau; geo).
- **Frankfurt Osthafen** 24700404 `66ff3eb4-513b-478b-abd2-2f5126ea66fd`: km 37.591; 90.626; W 147; 154/177/361/370; Q (2.6 h stale).
- **Raunheim** 24900108 `db1684c1-7ffc-4e8a-b8cf-8240a0d03519`: km 12.213; 82.879; W 114; 118/145/374/400; Q. Nearest to the mouth.

*Lahn* (km counts up downstream; joins at Lahnstein):
- HLNUG (DE-11, later): Feudingen → Biedenkopf → Sarnau → Marburg → Gießen.
- **Leun neu** DE-1 25800200 `32807065-b887-49f0-935a-80033e5f3cb0`: km 25.1; 134.993 NHN; W 131; 130/207/557/360; Q. HLNUG `GAUGE_DATUM` "134.99".
- Limburg (HLNUG) → Diez (Diez Hafen Q stale 8 days).
- **Kalkofen neu** 25800600 `64f735fd-88b6-42ea-9cdd-dc18d3806c34`: km 106.4; 86.4 NHN; W 174; 174/226/558/360; Q.

*Moselle, Saar and Sauer → Koblenz* (see §3.2).

**Downstream of Lobith: the Dutch Rhine branches** (NL-1; ETRS89 lat, lon; the value is H cm NAP unless noted; "fc" = RWS forecast)

| Branch | Stations in order | Notes |
|---|---|---|
| Split | `millingenaanderijn` (51.87296, 6.03484), Q F230 539 → **`millingenaanderijn.pannerdensekop`** (51.872, 6.0417), H 600. PEGELONLINE mirror Pannerdense Kop 2790060 `3046493f-971f-4d22-9f29-7ef8e3b645a4`, km 867.3 | The Pannerdensche Kop splits flow about 2/3 Waal and 1/3 Pannerdensch Kanaal |
| Waal | **`nijmegen.waal`** (51.853, 5.854) 417 fc → `dodewaard` (51.90051, 5.63052) 258–260 fc → **`tiel.waal`** (51.88238, 5.44069) 161; **Q F006 543**; fc H+Q (`tiel.sluis.waal` has a Q fc) → `zaltbommel` (51.81515, 5.24465) 45 fc; no Q | `nijmegen` = historic daily only |
| Pannerdensch Kanaal | **`pannerden.pannerdenschkanaal`** (51.87475, 6.03778), **Q F230 108** | Level here is historic only (F029, last 2017). **Exclude `pannerden.regelwerk.*`** (implausible) |
| Nederrijn–Lek | `arnhem.nederrijn` (51.97541, 5.91202): H **stale** (q=25), Q F230 stale since Aug; Q fc exists → **`driel.boven`/`driel.beneden`** (51.96584, 5.81064) 583 fc; Q F103 **gap (code 99)**; Q fc → `amerongen.boven`/`.beneden` (51.9753, 5.4125) 583/163 → `culemborg` (51.961, 5.214) → **`hagestein.boven`/`.beneden`** (51.9895, 5.1352), Q F103 −9 | Several stale series: add freshness checks and fallbacks |
| IJssel | **`westervoort.ijsselkop`** (51.9507, 5.953) 583 fc; Q F230 stale since 2025-11-27 → **`westervoort.1`** (51.9705, 5.962) **Q F006 103.5** (use it for IJssel Q); `westervoort.2` H 547 fc → `doesburg.ijssel` (52.01953, 6.13049) 338 fc → `zutphen.ijssel` (52.154, 6.182) 136 fc → `deventer` (52.25119, 6.15325) 38 fc → **`olst`** (52.34201, 6.10448) 11; **Q F006 129**; fc H+Q → `zwolle.ijssel` −10 fc → `kampen.ijssel` (52.552, 5.9264) −18 fc (also `kampen.keteldiep`) | `zutphen` and `kampen` Q are historic only |

**German tributaries feeding the IJssel directly** (DE-7 NRW; `station_no`; * = Infopegel/flood-report gauge; the NL side is WRIJ, with no open API):
- **Berkel:** Gescher → Lutum* → Stadtlohn* → **Ammeloe* 9284730000100**.
- **Issel / Oude IJssel:** Dämmerwald* 9281330000100 → **Isselburg* 9281700000200**.
- **Bocholter Aa:** Rhedebrügge* 9282570000100.

### 3.2 Moselle, Saar and Sauer/Sûre → Koblenz

Moselle km (PEGELONLINE, LU `pk`) count **up from the mouth**. The river is impounded with lock OP/UP pairs, which is why Trier→Cochem correlation is only r = 0.22.

| # | Station | Provider / code | km | Gauge zero | W / H now | Thresholds / characteristic values | Q | Forecast | Note |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Épinal** | FR-1 **A443064001** | – | 324.27 (IGN69) | −255 mm | – | 2.06 | Vigicrues F | |
| 2 | **Toul** | FR-1 **A573061001** | – | 200.74 | −415 mm | – | 3.44 | F | |
| ↳ | Meurthe: Laneuveville-devant-Nancy **A692101001** (200.41; 206 mm; Q 6.03) → Malzéville limni A694102004 (188.08; 1242 mm). Débitmètre A694102001 sent no data | FR-1 | – | – | – | – | – | – | |
| 3 | Custines (upstream of Pont-à-Mousson) | FR-1 **A701061001** | – | 183.6 | 546 mm | – | 7.82 | F | No Pont-à-Mousson station (Blénod A703062001 closed). Corny A740000102 is H only |
| 4 | **Metz Pont des Morts** | FR-1 **A743061001** | – | 159.01 | 2079 mm | – | – | – | H only |
| 5 | Hagondange | FR-1 **A793061002** | – | 153.91 | 237 mm | – | 9.09 | – | |
| 6 | **Uckange** | FR-1 **A850061001** | – | 150.28 | 250 mm | – | 11.2 | F | **Most downstream French Moselle station.** No Thionville Moselle station (Vigicrues "Thionville" = Veymerange A860304001), and no Apach, Sierck or Perl station |
| 7 | **Perl** (FR/LU/DE border, opposite Schengen) | **DE-1 26100100** `c263ea53-ca4d-41f5-b3f5-6178fec302aa`. LU-2 `Perl.json` is byte-identical | 241.8 | 138.491 NHN (2019-01-01); LU 138.50 m NN | 216 cm | MNW/MW/MHW 210/246/521; HW 651, HHW 851 | Q | LU-3 (LfU RLP), floor 250 cm | Canonical source: PEGELONLINE |
| 8 | **Remich** | LU SN **00229150** (CSV only; JSON 404) | 233.43 | 137.17 m NN | 347 cm | HQ5 634, HQ10 680, HQ50 818, HQ100 872 | – | – | 11,555 km² |
| 9 | **Stadtbredimus** (LU official Moselle alert gauge) | LU SN **02610012** = **DE-1 26100130** "Stadtbredimus UP" (OP 26100110); byte-identical | 229.48 | 134.50 m NN (no PNP in PEGELONLINE) | – | **Yellow 530 / orange 620 / red 780**; HQ5 774, HQ10 822, HQ20 872, HQ50 975, HQ100 1050 | – | LU-3 (LfU RLP), floor 260 cm | Take values from PEGELONLINE and attach the AGE thresholds |
| 10 | Wincheringen | DE-1 26100140 | – | – | – | – | – | – | Optional |
| 11 | **Grevenmacher** | LU SN **02610015** (`W4/15m.Cmd.O`) ≈ DE-1 26100200 "Grevenmacher UP" (OP 2610180); near-duplicate, differences up to 3 cm | 212.5 | 128.25 m NN | – | HQ5 759, HQ10 808, HQ50 939, HQ100 990 | – | Configured, but 404 | Pick one source |
| 12 | **Wasserbillig (Moselle)** | LU SN **00229151** | 205.92 | 128.25 m NN | – | HQ5 597, HQ10 653, HQ50 738, HQ100 778 | – | LU-3 (LfU RLP), floor 220 cm | The 12,044 km² catchment suggests the gauge is **above** the Sauer confluence (inference) |
| ↳ | **Sauer/Sûre** (block below) | | | | | | | | Joins at Wasserbillig; the lowest Sauer gauge is Rosport |
| ↳ | Syre: Roodt-Syre 52, Uebersyren 109, Mertert 32. Gander: Mondorf 108 (forecast floor 250 cm) | LU AGE | – | – | – | – | – | – | Moselle tributaries (geo; verify) |
| ↳ | **Saar** (block below) | | | | | | | | Joins upstream of Trier (geo; verify) |
| 13 | **Trier UP** | DE-1 26500100 `3bec53ca-444e-4014-a7b0-07b3591e954b` | 195.3 | 121.013 NHN | 223 | 219/304/730/695 | – | – | Weir pair; Trier OP has no coordinates |
| 14 | Mehring AMS | DE-1 | – | none | "Techn. Störung" | – | – | – | Faulty on 2026-09-23 |
| 15 | **Cochem** | DE-1 26900400 `768df4e9-ed5a-4141-901b-e25ac404d559` | 51.6 | 77.032 NHN | 216 | 210/273/648/600 | Q | – | |
| 16 | Alken | DE-1 26900510 `16578824-88de-4700-ab09-f61dbb1182bd` | 24.1 | – | – | – | Q only | – | |
| 17 | → Rhine at **Koblenz** (Mosel km 1.3) | | | | | | | | |

**Saar** (joins the Moselle; PEGELONLINE km count up from the mouth):
- Sarralbe centre FR-1 **A920107050**: H 1048 mm, Q 1.88, 10 min. Its zero value **0.20627 is bad**.
- Wittring **A930108040**: 558 mm, Q 1.96, zero 200.0.
- Sarreguemines A931108060 and A931109050 are **closed**.
- **Hanweiler** FR-1 **A940000101** (H 2347 mm; zero 191.3; Vigicrues F) = DE-1 26400100 `eeaba884-d4c5-4a83-88fb-adcd79adbc50`: km 104.6; 189.731 NHN; W 234; MW 246.
- Blies: Saarland gauges (Alsfassen, Ottweiler, Neunkirchen, Blieskastel, Reinheim) have **LHP classes only**. FR DREAL gauges exist at Bliesbruck/Frauenberg (codes not researched).
- Sankt Arnual DE-1 26400220 `a9ca43e9-ef92-4f1c-ac02-a6c8ccad7b9f`: km 90.906; 183.228 NHN (2024-11-13); W 201; 189/205/342/230; Q.
- **Fremersdorf** 26400550 `fe72ee98-88e9-4d19-aba1-f97f61b7d4de`: km 48.514; 165.491 NHN; W 205; 196/217/432/390; Q.
- The Saar is impounded, and 11 of its 21 gauges have no coordinates.

**Sauer/Sûre** (LU AGE codes from `ts_path`; gauge zero in m NN; `pk` river km; HQ = water level in cm equivalent to that flood; vigilance levels from `levelsMax`). Tributary positions are marked (geo; verify).
- BE upstream: Sûre – Martelange, DCENN **L5610** (BE-3).
- **Bigonville 17**: where the Sûre enters from Belgium; forecast; official alert gauge.
- Esch-Sûre dam 40: reservoir, absolute m NN (314.35).
- Heiderscheidergrund 19 → Michelau 34.
- Wiltz (geo): **Wiltz 38** (zero 305.28; pk 17.46; 114.5 km²; HQ2 148, HQ5 178, HQ10 198, HQ20 218, HQ50 243, HQ100 261) → Kautenbach 14 (forecast).
- Clerve (geo): Troisvierges 37 → **Clervaux 35** (347.02; pk 25.76; 147.2 km²; HQ2 160, HQ5 177, HQ10 203, HQ20 218, HQ50 238, HQ100 255).
- **Alzette:**
  - Livange 1 → Hesperange 2 → Pfaffenthal 3 → Steinsel 4 (zero changed 223.26 → 222.26) → Walferdange 30 → **Mersch 7** (212.35; pk 16.48; 707 km²; orange 350 / red 400; HQ2 400, HQ5 458, HQ10 498, HQ20 537, HQ50 574, HQ100 600; forecast 24 h) → **Ettelbrück/Alzette 42** (194.06; pk 1.14; 1,091.9 km²; orange 180 / red 230; HQ2 232, HQ5 281, HQ10 317, HQ20 348, HQ50 384, HQ100 411; forecast 24 h).
  - Tributaries: Mamer at Schoenfels 5; Eisch at Hunnebour 6 and Eischen 107; Attert at Reichlange 9 → Bissen 10; Wark at Niederfeulen 27, Welscheid 28, Welscheid-Village 29 → Ettelbrück/Wark 41.
- **Diekirch 11**: zero 185.41 since 2012-01-02 (186.61 before); pk 55.62; 2,149 km²; orange 420 / red 470; HQ2 459, HQ5 497, HQ10 522, HQ20 544, HQ50 575, HQ100 597; forecast 24 h.
- Our (geo):
  - BE: Schoenberg DGH 9926, Reuland DGH 9914, Ouren DCENN L6330.
  - LU: Dasbourg 13 (forecast) → Gemünd 26260303 (LfU RLP; forecast `gemund-our`) → **Vianden 12** (202.00; pk 12.09; 641.3 km²; HQ2 225, HQ5 259, HQ10 285, HQ20 310, HQ50 344, HQ100 372).
- **Bollendorf 15**: operated by LfU RLP (`W_out_LFU`); 162.34; pk 34.06; 3,227 km²; orange 350 / red 425; HQ2 377, HQ5 448, HQ10 500, HQ20 552, HQ50 620, HQ100 671; forecast configured (48 h) but 404.
- Ernz (geo): Larochette 43, Müllerthal 39.
- **Rosport 16**: 139.95; pk 12.83; 4,231.8 km²; HQ2 548, HQ5 631, HQ10 687, HQ20 739, HQ50 806, HQ100 854; forecast 48 h. **The lowest Sauer gauge.**
- → Moselle at Wasserbillig.

### 3.3 Meuse (France → Wallonia → Eijsden → Dutch Meuse)

RWS Meuse river-km: Eijsden-grens 2.56, St. Pieter 10.80, Borgharen-dorp 16.00, Venlo 107.47, Megen 190.75. HIC Grensmaas "rkm" values use the same system (Sint-Pieter Noord 10.8).

**France** (FR-1; zero in m IGN69 unless noted; H in mm; Q in m³/s):
1. Saint-Mihiel **B222001001**: H 296, Q 1.17, zero 218.95.
2. Stenay **B315002001**: H −44, Q 3.36, zero 162.17, F.
   - Chiers (joins upstream of Sedan; geo): Longwy **B402101001** (249.98) → Montigny **B403101001** (219.66) → Belgian Torgny **B422431101** (60-min partner) → Chauvency **B460101001** (173.73) → Carignan **B463101001** (158.59) → **Brévilly B466010101** (157.07; H only; F). LU **Pétange 33** is on the upper Chiers and is the only Luxembourg station in the Meuse basin.
3. Sedan **B502001001**: H 2650, Q 13.3, zero 146.26, F.
4. **Charleville-Mézières B540001001**: H 2608, no real-time Q, zero 140.43 (143.04 m NGF-IGN69 absolute), F. Comment: "Sous influence barrage…".
   - Semoy: BE Membre Pont DGH 9434 (H 254647010, Q 302441010) and Bouillon DGH 9461 (H 254963010, Q 302585010) → FR **Haulmé B611101001** (H 301, Q 1.19, zero 143.0 NGF-1884, F). Belgian partner stations B6100002xx–08xx run at 60 min.
5. Monthermé **B700001002**: H 3550, H only, zero 133.03.
6. **Chooz Trou du Diable B720000001** (DREAL): H 491, Q 17.3, zero 101.34. **Last French station.** Chooz Île Graviat B720000002 (H 60; zero 99.0 **NGF-1884**; QmnJ since 1953); EDF series B720000004; Chooz Petit B720000003 silent. SPW also runs **Chooz DGH 8702** (H 253255010, Q 301649010; since 1977/1983).
   - **Givet has no station** (Chooz is the border proxy). Heer-Agimont is not in the SPW public data. "HASTIERE" 8622 is on the Hermeton.

**Wallonia** (BE-3; site/`station_no`; public ts_ids):
7. Waulsort DGH **8078**: QADM 251086010 (hourly; since 1983).
   - Lesse (geo): Gendron DGH **8221**, H 251929010, Q 301217010.
8. Anseremme Monia DGH **8067**: H 250781010.
9. **Dinant DGH 8059**: H 250652010 (not DCENN L8470).
10. Tailfer DGH 8016: QADM 367460010 (null for 5 days, so unreliable).
    - **Sambre** (joins at Namur):
      - FR: Berlaimont **D016221001** (H 274; zero 126.876) → Maubeuge aval écluse **D019801101** (H 207; 122.237; F) → **Marpent D019223001** (H 178, Q 2.15; 122.24; last FR station). Solre/Erquelinnes D021000101 sent no data.
      - BE: Solre DGH 7487 (QADM 248506010) → Landelies US 7408 (QADM 387498010) → Monceau Aval Barrage-Écluse (Charleroi) 7394 (H 247998010) → Châtelet 7371 (QADM 247526010) → **Salzinnes-Ronet 7319** (QADM 247033010; full resolution 247062010 since 2006).
11. **Namur DGH 8001**: Habs_sonde 354633010 (m DNG, e.g. 78.5).
12. Grands-Malades Bief Amont DGH 7197: H 246276010. Andenne is not in the public set (LANDENNE 7168 is a rain gauge).
13. **Huy DGH 7141**: H 246052010.
14. Ampsin Bief Amont 7137 (H 245773010) / Neuville Bief Aval 7133 (H 245678010).
15. Amay DGH 7132: QADM 245521010.
16. Ivoz-Ramet Bief Amont 7117: H 245399010.
    - **Ourthe:** Tabreux **5921** (H 240759010, Q 297989010; gauge datum 109.9 m DNG; 1,607 km²). Amblève Martinrive **6621** (H 243172010, Q 298925010) joins it. Vesdre: Chaudfontaine Piscine **6228** (H 242295010, Q 298637010) and Chaudfontaine Pont 6229 (H_sonde 370054010, Q 370213010). Angleur 2 BIS **5808** (Q 346891010) is at the Ourthe mouth. 5804 ANGLEUR GR BAT. Av has been dead since 2024-11-30.
17. **Liège DGH 7102** (50.6126 N, 5.5772 E): Habs_sonde 245267010 (m DNG, 59.98). QEtimeuse DGH 5491 (382389010) is not in the public group. Monsin and Pont des Arches are not in the public set.
18. Haccourt (Albert Canal) DGH 5771: QADM 239603010 (canal withdrawal).
19. **Visé DGH 5451**: QADM 239015010, hourly, full resolution since 1995. 13.9 m³/s at low flow, after the Albert Canal withdrawal at Monsin; 2742.985 m³/s daily mean on 2021-07-15.
    - Berwinne: Dalhem DCENN L6390.
20. **Lixhe Bief Amont 5447** (H 238955010) / **Lixhe Aval 5436** (H 238765010; Q 297557010): the last weir before NL. Also in RWS as `lixhebiefaval` (50.75964, 5.68089), H 4406.

**Netherlands and the Flemish Grensmaas** (NL-1 codes; BE-1 HIC ts_ids):
21. **`eijsden.grens`** (50.758, 5.682; rkm 2.56): H 4406 cm NAP (**plus a TAW duplicate, 4639**); **Q F216 47.6 (about 75 min late)**; fc H+Q. **The Meuse entry gauge.**
22. **`maastricht.sintpieter`** (50.83029, 5.69732; rkm 10.80): H 4406 (+TAW); **Q F103 11.5**; fc. `maastricht.sintpieter.zuid` has Q F128 (ADCP). HIC **Sint-Pieter Noord SINT-WL1-1060**, rkm 10.8: H 76330010 (1-min), Q 76339010 (since 1996; noisy: 43.4 → 11.5 → 3.2 → 5.3 → 46.5 m³/s in 40 min).
    - Jeker/Geer: Bergilers DGH 5572 → Eben-Emael DCENN L6340 (joins at Maastricht; geo).
23. **`maastricht.borgharen.maas.beneden`** "Borgharen Dorp" (50.8724, 5.691; rkm 16.00): H 3754; **Q F006 11.6–19.3**; fc. `borgharen.boven`/`.beneden` are historic manual readings only; `maastricht.borgharen.julianakanaal` is the canal; HIC `BORD-1060` is not public.
24. `lanaken` (50.8895, 5.6831): H 3615, fc. HIC Lanaken-Smeermaas `maa08a`, rkm 18.4: 70680010.
    - Canal transfers, ungated (RWS CC0, live in the gap check): **`smeermaas.zuidwillemsvaart`** (50.8747, 5.6784; Zuid-Willemsvaart intake, H 4035 cm NAP and Q 11 m³/s, `LBXXREG_*`) and `kanne` (50.8147, 5.6716; Q 13.96 m³/s, `LBXXREG_AFVOER`; whether this is the Jeker/Geer or a canal is UNVERIFIED). The Albert Canal withdrawal at Monsin is only in SPW (Haccourt QADM, gated).
    - Geul/Gueule (geo): Kelmis DGH **5291** (H 238670010, Q 297485010) → Sippenaeken DCENN **L6660** (at the NL border; H+Q) → RWS **`epen.geul.cottessen`** (50.75815, 5.9343), H 11967 cm NAP, Q F007 0.42.
25. HIC Grensmaas: Uikhoven `maa06x` rkm 25.3 (110665010) → Eisden-Mazenhoven `maa06a` rkm 34.7 (66304010) → Meeswijk Veer rkm 39.0 (72498010) → Negenoord rkm 42.5 (74032010) → Rotem rkm 44.9 (104065010) → **Maaseik `maa02a` rkm 52.8** (H 72032010, Q 72039010, Q since 1974; thresholds prewaak 29.30 / waak 30.99 / alarm 32.00 m TAW). RWS `maaseik` has a Q forecast. Kessenich is not public.
26. `stevensweert` (51.1311, 5.8417): H 2098 (+TAW), fc.
    - **Roer/Rur** (DE-7; * = Infopegel): Monschau* 2821530000200 → Zerkall* → Altenburg_1* → Selhausen 2823900000100 → Jülich-Stadion* 2825190000200 → Linnich 2825330000100 → **Stah* 2829100000100** (last before NL; PNP 29.938; 2,135.15 km²; LANUV MNW 31 / MW 65 / MHW 211; Info 1/2/3 = 200/245/265 cm).
      - Inde: Eschweiler*, Kirchberg1*, Kornelimünster*, Lamersdorf.
      - Wurm: Kalkofen 2828100000100 → Herzogenrath_1* 2828300000200 → Randerath* 2828900000200. WVER also has "Wurm Rimburg NL" and "Amstelbach Eygelshoven WL".
      - The NL Roer (e.g. Vlodrop) belongs to Waterschap Limburg; no API.
27. **`roermond.boven`** (51.2005, 5.9815): H 1695, fc. `roermond.beneden` is historic; `roermond.hambeek` Q is a small stream.
    - **Schwalm** (DE-7; joins between Roermond and Venlo; geo): Molzmühle 2843000000100 → Pannenmühle 2847500000100 → **Landesgrenze 2849900000100**.
28. **`venlo`** (51.36739, 6.15941; rkm 107.47): H 1113; **Q F103 33.7**; fc H+Q. `steyl`, `belfeld.boven` and `well` are also live.
    - **Niers** (DE-7; joins near Gennep; geo): Oedt* 2861700000100 → Geldern Burgstraße* → Weeze* 2867900000100 → **Goch* 2869500000200**. Bettrather_Dyck has been stale since 2026-06-09. The NL Niers (`ONIER06_H`) belongs to Waterschap Limburg; no API.
29. `sambeek.boven`/`.beneden` (51.632, 6.004) → `gennep` (51.697, 5.957): H, fc.
30. `grave.boven` / `grave.beneden` (51.761, 5.743 / 51.775, 5.72): H 798 / 493, fc.
31. **`megen.maas`** (51.82783, 5.56309; rkm 190.75): H 490; **Q F103 88.9**; fc.
32. `lith.boven` / `lith.beneden` "Lith dorp" (51.81, 5.455 / 51.8104, 5.4329): H 491 / 41, fc. `lith` Q is historic only.

HIC calculated daily Q "Liège Afwaarts Onverdeeld calc" 92926010 runs back to 1911 and was updated to 2026-09-22.

### 3.4 Scheldt / Escaut (France → Wallonia → Flanders → Western Scheldt)

**France** (FR-1; H in mm; Q in m³/s):
- Iwuy **E131000202** (H 292, Q 2.47, 15 min; no station named Cambrai; E131000201 silent) → Neuville-sur-Escaut **E171551101** (126, Q 8.19) → Trith-Saint-Léger (Valenciennes) **E172751201** (24, **Q −1.2**). Condé E183041001 is closed.
- Scarpe: Anzin-Saint-Aubin **E201000501** (zero 57.473), Courchelettes **E223000101** (27.39), Brebières (VNF) **E207111003** (null), **Mortagne-du-Nord E237110501** (13.29; VC).
- **Maulde E240041101** (the BE border near Mortagne): H 154, Q 23.4, zero 14.5, VC. Tournai E240041201 sent no data.

**Wallonia** (BE-3): Haine – Boussoit DGH 3561 (H 237384010, Q 297197010) and Obourg DCENN L7570 → **Escaut – Tournai DGH 3282** (QADM 236825010) → Kain Amont / Aval Barrage-Écluse 3276 / 3274 (H 236731010 / 236636010) → **Pecq 3270** (Habs_sonde 398877010).

**Flanders Bovenschelde** (BE-1 HIC): **Helkijn `bos05m-1066`** (H 4779010, Q 68658010) → Kerkhove 69983010 → Oudenaarde 74965010 → Asper 62853010 → **Gavere** (H 67105010, Q 67056010) → Zwijnaarde 79534010 → Gent.

**Leie / Lys** (joins at Gent):
- FR: Merville DREAL **E364121002** (zero **13318.0, bad**) / VNF **E364121001** (13.27) → Armentières VNF **E367125002** (H 200, Q 7.54; zero **0.01267, bad**) → **Bousbecque E381126501** (H 83, Q 1.68; zero 9.913; at the border). There is no Halluin or Comines station in France.
- BE-3: Lys – Comines DGH 3886 / 3884.
- BE-1 (**no Wervik gauge is public**): **Menen Opwaarts `lei12e-1066`** (H 72768010, since 1996) and **Menen Ropswalle `lei11m-1066`** (H 116853010, Q 116893010). Hub'Eau mirrors Menen as E381126601 with H = 10020 mm on a different datum.
- Downstream: Lauwe 70813010 → Kortrijk 5063010 → Harelbeke 68244010 → Sint-Baafs-Vijve 76375010 / 76412010 → **Machelen** (H 4800010, Q 5128010) → **Deinze** (H 65341010, Q 65350010) → Sint-Martens-Latem 76519010.
- DVW stations such as `WW065-OPW-1073` are not in the public groups.

**Zeeschelde** (BE-1 HIC tidal W in m TAW, 10 min; station codes count **up upstream**; HW/LW ts in brackets):
- Gentbrugge tij `zes58a` 54411010 → **Melle tij `zes57a`** W 116528010 (HW/LW 116529010), **Q 72594010 (since 1971)** → Wetteren Brug tij `zes55c` 101631010 → Uitbergen tij `zes52a` 102435010 → Schoonaarde Brug tij `zes48y` 129633010 (HIS_zes49a closed 2025-06).
- **Dender** (joins at Dendermonde): Wallonia Ath DGH 2971 → Lessines US DGH 2708 (QADM) → HIC Overboelare `den12a` (H 4821010, Q 75053010) → Geraardsbergen 67577010 → Idegem (temporary gauges 130149010 / 130171010) → Erembodegem `den06a` (H 16602010, Q 66529010) → Aalst (several, 120041010 …) → Denderbelle 65436010 → **Dendermonde `den02a`** (H 65608010, Q 65562010; Q oscillates between −1.13 and 2.95).
- **Dendermonde tij `zes47a`** W 54186010 (54192010) → Sint-Amands tij `zes42a` 55419010 (55425010).
- Durme: Tielrode tij 55565010, Hamme tij 117472010.
- Driegoten tij `zes39a` 102376010 → **Temse tij `zes36a`** 55493010 (55499010).
- **Rupel basin** (tidal tributaries; the order within each river is to be set by chainage):
  - Dijle:
    - Wallonia: Bierges DGH 1046.
    - VMM: Korbeek-Dijle `L08_097` (H 3858042), **Sint-Joris-Weert `L08_098`** (H 3880042, Q 68498042, since 1973), Wilsele `L08_093` (H 3792042, Q 68427042).
    - HIC: Werchter `dij13a` 114978010 → Rijmenam `dij10a` 79593010.
    - Tidal: Mechelen Stuw Opwaarts tij `dij08a` 94318010, Mechelen Benedensluis tij 54980010, Hombeek tij 54580010.
  - Demer:
    - VMM: Bilzen `L09_138` (H 4364042, Q 68922042), Hasselt `L09_136` (H 4342042, Q 68898042), Molenstede `L09_126` (H 4254042, Q 68828042), Linkhout `L09_132` (H 4298042).
    - HIC: Zichem `dem04a` (H 5084010, Q 5754010), Testelt 77401010, **Aarschot Afwaarts `dem02a`** (H 62410010, Q 62310010, since 1968), Betekom 114956010, Langdorp 114934010.
  - Nete:
    - VMM: Meerhout `L10_078` (H 5178042, Q 69717042), Geel/Grote Nete `L10_077` (H 5156042, Q 69694042), Herentals/Kleine Nete `L10_055` (H 5024042, Q 69530042).
    - HIC: Geel-Zammel `gnt07a` (H 67324010, Q 67302010), Hulshout `gnt05a` (H 69227010, Q 69196010), Itegem 69503010, Grobbendonk Troon `knt03a` (H 67854010, Q 67863010).
    - Tidal: Emblem 54366010, Kessel 54693010, Lier Molbrug 54823010, Duffel Sluis 54283010, Rumst 114021010.
  - Zenne (Brussels outflow): Wallonia Tubize DGH 1951 → HIC Eppegem `zen03a` (H 66503010, Q 66513010) and Vilvoorde (H 78079010, Q 78096010); VMM Lot/Zenne Q 68734042; Zemst tij 56227010.
  - Rupel: Boom tij `HIS_rup02a` closed in 2015.
- Schelle tij `HIS_zes29a` 55311010 **closed 2013-06-30**; use Hemiksem or Temse. "Schelle calc" daily Q 83735010 has been stale since 2026-01-03.
- Hemiksem tij `zes28a` 54493010 (54499010) → **Antwerpen tij `zes21a`** W **53989010** (51.2275, 4.3999; probably the Loodsgebouw gauge, UNVERIFIED; 10-min since 1996; HW/LW **53995010** since **1888**; forecast 89202010; astronomical 112650010). RWS mirror `antwerpen` (51.228, 4.397): H −218 (`ZLXXREG_ZEGE`).
- Kallosluis tij `zes14a` 54606010 → Liefkenshoek tij `zes10a` 54936010 → **Prosperpolder tij `zes01a`** W 56088010 (since 1996; HW/LW 56094010). **At the NL border.**
- HIC calculated daily Q: Zelzate border B-NL 119039010 and "Gent IN" 119040010 are current. The Zeeschelde, Rupel, Durme and Dijle calculations stopped on 2026-01-03.

**Western Scheldt** (NL-1; tidal; each has astronomical and GETET* series and a forecast): **`rilland.bath`** (51.39878, 4.21014), H −161 (`bath.*` codes are sampling points without WATHTE) → `hansweert` (51.44567, 3.99744) −125 → `terneuzen` (51.33621, 3.81981) −97 → **`vlissingen`** (51.442, 3.6) −79.

### 3.5 Ems / Eems (Germany → Dollard)

There is **no discharge anywhere on the Ems** in PEGELONLINE. The km systems mix (upper Ems/DEK km 96–235; the tidal Ems restarts at Papenburg km 0.39).
- NRW upper Ems (DE-7): Steinhorst* → Rheda* → Warendorf* → Einen* → Greven* → Espeln → Haskenau.
- **Rheine Unterschleuse** DE-1 3390020 `50a449ba-af4c-42c7-b2c4-9a3eda37e1e3`: km 153.03; PNP 24.188 NHN (valid from **1976-10-15**); W 184; MNW/MW/MHW 188/258/546.
- **Lingen-Darme** 3500015 `200363fc-cdc5-4c22-a271-a25d1ba880ed`: km 196.2; PNP 14.98 **NN** (2001-10-16); W 118; 123/214/504.
  - Hase (NLWKN; joins at Meppen, geo): Bokeloh 201, Herzlake 328, Haselünne 310.
- **Versen Wehrdurchstich** 3730010 `6de43652-2db9-4627-a255-9cb1f8efb820`: km 234.78; 6.71 NHN; W 97; 91/142/350. Versen Wehr OP 3730001 `86f8dbab-6a64-408b-a5d5-69e69f01db2f` has `km=None`.
- **Herbrum Hafendamm** (water body DEK) 3770030 `8177a148-5674-4b8f-8ded-050907f640f3`: km 213.07; **no PNP**; W 568. At the **tidal limit**. Rhede (DEK) has no PNP; W 580.
- Papenburg 3790010 `ec4a598d-773d-44c1-935e-2053b54e45a3`: km 0.39; −5.06 NHN; W 587; tidal.
- Leerort / Terborg / Pogum / Emden / Knock / Dukegat / Emshörn: 3910010 … 9340010; km 14.8–74.3; about −5 NHN; tidal, 1-min estuary gauges.
- NL-1: **`nieuwestatenzijl.dollard`** (53.23156, 7.20742), H 96, astronomical, fc; **`delfzijl`** (53.328, 6.931), H 105, astronomical, fc.
- Westerwoldse Aa (Hunze en Aa's) was not researched.

### 3.6 Overijsselse Vecht (+ Dinkel)

1. NRW (DE-7): Schöppingen* 9286139100100 → Bilk 9286190000100.
2. NLWKN (DE-9; `STA_ID` / number): Ohne 465 / 9286106.
   - Dinkel: NRW Legden 9286410000100 → Heek* → **Gronau* 9286455000200** → NLWKN **Lage I 388 / 9286136**. The Dinkel passes through the Vechtstromen area (no API). It joins the Vechte near Neuenhaus (geo; verify).
3. Wehr Neuenhaus 111 / 9286127.
4. **Emlichheim 258 / 9286162**: the last gauge before NL. Gauge zero "NN + 7,961 m". Meldestufen 1/2/3 = 390/430/510 cm (stage 1 = 11.861 m NN). `GewaesserNameNachfolger` says "Issel", as returned by the API.
5. NL-1: De Haandrik (`dehaandrik.boven`/`.beneden`) is **historic only (last 2004)** → **`holtheme.vecht`** (Hardenberg; 52.62083, 6.69849; F155; 915 cm) → Regge (`archem.benedenregge` historic only) → **`ommen.vecht`** (52.5171, 6.42192; F155 262; **Q F103 2.1**) → `dalfsen.vechterweerd` (52.5181, 6.21165; F007 −21).

### 3.7 Travel times (sourced)

Travel times depend strongly on discharge: they vary 1.5–2× between low water and flood. Floodplain storage slows the wave from about 5,000 m³/s at Lobith; the floodplains start conveying water at about 7,000 m³/s and the wave speeds up again. **Present these values as "typical, indicative" and never as an ETA.**

**Rhine → Lobith.** The flood-peak column comes from RWS note GWIO 85.006, *"Looptijden hoogwatergolven op de Rijn"* (L.P.M. de Vrees, Aug 1985; 24 flood waves 1965–1983 with Q_Lobith > 5000 m³/s; appendix 1): https://open.rijkswaterstaat.nl/@87627/looptijden-hoogwatergolven-rijn/ (PDF `https://open.rijkswaterstaat.nl/publish/pages/61132/gwio_85006.pdf`). Ranges are the observed spread; ≈ values are medians computed by map-rivers.

| From (PEGELONLINE km) | Distance to Lobith | Flood peak → Lobith | Low water, Aug–Sep 2026 (map-rivers cross-correlation) |
|---|---|---|---|
| Basel (164.3) | about 698 km (862.0 − 164.3) | **Basel → Maxau about 23 h** (reduced "from 64 to 23 hours" by the Upper Rhine training works; IKSR, https://www.iksr.org/en/topics/floods/water-retention). The whole Basel → Lobith trip: see §8 C2 | – |
| Maxau (362.3) | 500 km | Not in RWS 1985. In the Feb and May 1999 floods, peaks were Maxau 21.02 / 14.05 → Kaub 24.02 / 17.05 (LfW RLP report 212/99, Tabelle 3, https://www.hochwasser.rlp.de/static/shared/documents/rhein_1999.pdf; daily resolution; confounded by retention and the Neckar/Main). That implies **about 4–5 days to Lobith** (derived) | Maxau → Kaub 11 h, r = 0.29 (**unreliable**) |
| Kaub (546.2) | 316 km | **About 2 days** (derived: Kaub → Andernach about 0.5 day, plus Andernach → Lobith) | **About 64 h** (9 + 16 + 37 + 2) |
| Koblenz (591.5) | 271 km | **About 40–45 h** (derived) | **About 55 h** |
| Andernach (613.8) | 248 km | 28–48 h, ≈ **39 h** (ch-bafu cites 28–49 h; see §8 C1) | – |
| Bonn (654.8) | 207 km | 24–49 h, ≈ 35 h | – |
| Köln (688.0) | 174 km | 22–46 h, ≈ **30 h** (ch-bafu: "about 22–40 h") | About 39 h |
| Düsseldorf (744.2) | 118 km | 11–34 h, ≈ 23 h | – |
| Ruhrort (780.8) | 81 km | 13–27 h, ≈ 19 h | – |
| Wesel (814.0) | 48 km | 6–19 h, ≈ 11 h | – |
| Emmerich (851.9) | 10 km | 1–8 h, ≈ **3 h** | **2 h** (r = 0.78) |

- Low-water legs measured by map-rivers (PEGELONLINE `measurements.json?start=P30D` for 8 stations, 24 Aug–23 Sep 2026; resampled hourly, 6 h rolling mean, cross-correlated first differences): Kaub → Koblenz 9 h (r 0.57); Koblenz → Köln 16 h (r 0.67); Köln → Emmerich 37 h (r 0.57); Emmerich → Lobith 2 h (r 0.78); Cochem → Koblenz 5 h (r 0.45); Trier UP → Cochem not usable (r 0.22, weir-regulated).
- **Lobith onward** (same RWS note, appendix 2; large spread): Nijmegen about 5 h, Tiel about 13 h, Zaltbommel about 19 h, IJsselkop about 5 h, Driel about 12 h, Amerongen about 25 h, Olst about 40 h, Katerveer (IJssel) about 48 h.
- **Moselle:** no published Trier → Koblenz figure. Estimate **about 20–30 h at flood** (UNVERIFIED). A secondary summary says "Moselle water takes about 3 days to reach the Netherlands" and "Upper Rhine water about 5 days to Lobith" (attributed to waterpeilen.nl / RWS pages; UNVERIFIED).
- **Maxau → Andernach:** not sourced; roughly 1–1.5 days (UNVERIFIED).
- A non-authoritative blog (klimaatgek.nl, 2026-08-30) quotes "6 days" Basel → Lobith, probably for mean flow.

**Meuse**

| Reach | Travel time | Source |
|---|---|---|
| Namur (Jambes) and Ourthe (Comblain-au-Pont) → Borgharen | **About 7 h** (the old RWS forecasting relation) | Lodder 1983, TU Delft thesis, https://repository.tudelft.nl/islandora/object/uuid:5f974fa8-3ed6-4d93-8824-fadeaeb3cae2 (via WebFetch summary) |
| Namur → Eijsden | Implied about 4–6 h; **UNVERIFIED** | – |
| Chooz → Borgharen | **About 16 h**; search-engine summary with an unidentified source, **UNVERIFIED** (plausible for about 145 km at 9–10 km/h) | – |
| Eijsden-grens (rkm 2.56) → St. Pieter (10.80) | About 1 h under normal conditions | RWS "Topafvoeren hoogwater Maas juli 2021" v2.0, 16-12-2021, https://edepot.wur.nl/568220 |
| July 2021 peak (MEZT) | Eijsden-grens 15-7 21:50 (3195 m³/s) → St. Pieter 23:10 → Borgharen-dorp 16-7 01:20 (**3.5 h**) → Venlo 17-7 11:50 (**38 h**) → Megen 19-7 07:30 (**82 h**) | Same report |
| French Meuse, Chalaines → Chiers confluence (230 km) | Floods propagate in 4–5 days | Tailliez et al. 2000, Rev. Géogr. Est, https://journals.openedition.org/rge/4185 |

Also cited: RWS "Looptijden hoogwatergolven Maas" 1967 (https://open.rijkswaterstaat.nl/zoeken/@91286/looptijden-hoogwatergolven-maas/) and the CHR Rhine Alarm Model brochure (https://www.chr-khr.org/sites/default/files/chrpublications/brochure_ram_e.pdf).

**Scheldt and Ems:** the border reaches are **tidal**, and the tide runs upstream, so a downstream travel time does not apply to levels. Show these reaches differently. HIC high and low waters with `Tide Number` (group 156165) let you follow one tide wave up the Zeeschelde.

**Recommendation (map-rivers, ch-bafu):** model travel time as a configurable, discharge-dependent lag per river segment. Seed it with the sourced anchors above and calibrate it from our own collected series by cross-correlation per edge and per flow class. That needs weeks to months of data.

---

## 4. Comparability across countries

### 4.1 Vertical datums and offsets (anchored on NAP)

The offsets come from PROJ 9.5.1 `proj.db` (EPSG parameters, queried with pyproj 3.7.2). They were cross-checked against live data wherever a provider publishes two datums at the same gauge.

| Datum (who uses it) | EPSG | Relation to NAP / EVRF2007 | Evidence |
|---|---|---|---|
| **NAP** (RWS, Dutch water boards; NG95 in LU is tied to it) | 5709 | Reference, 0. EVRF2007 is realised on NAP; EPSG:5425 gives NAP → EVRF2000 = −0.005 m | proj.db |
| **TAW (NL name) = DNG (FR name)**: Flanders HIC/VMM, Wallonia SPW, and 8 RWS Meuse-border series | 5710 "Ostend height" | **H_TAW ≈ H_NAP + 2.33 m.** TAW zero lies about 2.33 m below NAP zero. | EPSG:5199 Ostend → EVRF2007 is −2.317 m plus a latitude slope of −0.031″. PROJ gives Givet 2.307, Eijsden 2.318, Antwerp 2.326, Emmerich 2.336, Coevorden 2.349 m. **[V] live pairs:** RWS Eijsden 4637 TAW vs 4404 NAP = 233 cm (nl-rws: 4639 vs 4406); Stevensweert 2331 vs 2098 = 233; HIC Maaseik 23.32 m TAW vs RWS Maaseik 20.99 m NAP = 2.33 m |
| **DHHN2016 / DHHN92 "m ü. NHN"** (PEGELONLINE gauge zeros, Länder, NRW `Hoehensystem`) | 7837 / 5783 | H_EVRF2007 = H_DHHN2016 + 0.014 m + slope (EPSG:7838), so **H_NHN ≈ H_NAP − 0.5…2 cm** in the basin (PROJ: Emmerich +0.010, Eijsden +0.016, Coevorden +0.005 m). Negligible for display. Not yet confirmed at a shared gauge. | proj.db, EPSG:7838 and EPSG:5211 |
| **DHHN12 "m ü. NN"** (old): 40 PEGELONLINE gauge zeros and the `m+NN` W series | 7699 | NHN − NN ranges from −80 to +42 mm across Germany (mean 4 mm); +55 mm near Aachen and −20 mm in eastern NRW | de.wikipedia "Deutsches Haupthöhennetz"; NRW DHHN info |
| **NGF-IGN69** (France, Sandre code 3) | 5720 | H_EVRF2000 = H_IGN69 − 0.486 m (EPSG:5419, **stated accuracy 0.1 m**); H_EVRF2007 = H_IGN69 − 0.47 m (IGNF:TSG1251, constant). So *nominally* H_IGN69 ≈ H_NAP + 0.47–0.49 m. **Contradicted at shared gauges:** Hub'Eau − PEGELONLINE zeros differ by +0.535 m (Breisach), +0.58 m (Kehl) and +1.57 m (Hanweiler); Strasbourg open data says IGN69 = NN + 0.35 m. **Not usable for display at ±2 cm** (see the check below the table) | proj.db; gap check [V] |
| **NGF-Lallemand 1884** (Sandre code 2) | – | Differs from IGN69 by a spatially variable, decimetre-level amount; fr report says about 0.3–0.4 m (**UNVERIFIED**). At Chooz the SPW gauge 8702 (101.428 m DNG) shares a staff with Hub'Eau Île Graviat (99.0 NGF-1884), implying NGF-1884 ≈ NAP − 0.12 m there (indicative) | Live: Chooz Île Graviat B720000002 has 99.0 (code 2) while Trou du Diable B720000001 has 101.34 (code 3); gap check |
| **Swiss LN02 "m ü. M."** (BAFU; Basel-Rheinhalle in PEGELONLINE) | – | **LN02 ≈ NHN + 0.32 m at Basel.** Derived: BfG Undine gives the Basel gauge zero as NHN + 239.68 m, and Basel-Stadt defines it as LN02 240 m. Web search reports about 32 cm at the Rhine border and 36 cm at Schaffhausen (BKG D-A-CH tool; not opened) | ch-bafu (derived); datum-arch lists Swiss offsets as UNVERIFIED |
| **LU "m NN" (NG95)** | – | Tied to NAP (Amsterdam). Within 1 cm of NHN at Perl (138.50 vs 138.491) | lu.md; NG95 doc: https://act.public.lu/content/dam/act/fr/publications/documents-techniques/20210322-DTECH-NG95-height-datum.pdf |
| Austrian "m ü. A." (8 PEGELONLINE series, Danube) | – | Not needed | – |
| RWS `MSL` (offshore), `PLAATSLR` (local datum) | – | Station-specific | Seen in the catalogue |

**Shared-gauge check for the French datum (gap check item 8, 2026-09-23 ~21:30Z) [V].** Three gauges are published by both Hub'Eau (zero in IGN69, `code_systeme_alti_site` 3) and PEGELONLINE (zero in m ü. NHN). The current readings agree within 1–2 cm, so both feeds use the same physical zero, and the difference between the published zero heights should equal the local IGN69 − NHN offset:

| Gauge | Hub'Eau zero (IGN69; valid from) | PEGELONLINE zero (NHN; valid from) | Difference | Readings (Hub'Eau 21:00Z / PEGELONLINE 21:30Z) |
|---|---|---|---|---|
| Breisach (A040000101 / 23300320) | 185.05 (2024-01-05) | 184.515 (2018-11-01) | **+0.535 m** | 1860 mm / 188 cm |
| Kehl-Kronenhof (A060005050 / 23300900) | 133.6 (2024-07-01) | 133.02 (2018-11-01) | **+0.58 m** | 1830 mm / 184 cm |
| Hanweiler, Saar (A940000101 / 26400100) | 191.3 (2021-01-01) | 189.731 (2018-01-04) | **+1.57 m** | 2349 mm / 234 cm |

Other published figures for the same offset:
- PROJ `IGNF:TSG1251` "NGF-IGN 1969 vers EVRF2007": a constant −0.47 m; `EPSG:5419` (IGN69 → EVRF2000) −0.486 m **with a stated accuracy of 0.1 m**. With NHN ≈ EVRF2007 − 0.014 m this predicts IGN69 − NHN ≈ +0.48 m.
- The EVRF2019 grid (`EPSG:9575`, `fr_2019z.asc`, accuracy 0.108 m) is not on the PROJ-data CDN, and the BKG EVRS site reset the connection from the sandbox.
- Strasbourg open data ("Canevas altimétrique"): *"IGN69 = NGF +0,35 et IGN69 = NN + 0,35"*, with NN = the German system "still used for Rhine-related work"; which NN realisation is meant is not stated.

**Conclusion:** the offsets disagree by 5–10 cm at Breisach and Kehl, and Hub'Eau's Hanweiler zero is off by more than a metre (a metadata error, or a different zero after 2021). Several Hub'Eau zeros are rounded to 0.1 m (133.6, 191.3). **Show no converted absolute heights for French stations in the first release**; show the raw relative reading with its unit and "gauge zero: IGN69 (Hub'Eau metadata, unverified)". A hand-curated zero table (with validity dates) must precede any French absolute height.

**TAW ↔ French datum at Chooz.** SPW Chooz DGH 8702 (50.09213 N, 4.80653 E; `station_gauge_datum` **101.428 m DNG**, `GAUGE_DATUM` 101.428) sits about 25 m from Hub'Eau **Chooz Île Graviat B720000002** (zero **99.0, NGF-1884 Lallemand**, code 2), not at Trou du Diable (IGN69). Readings: SPW 0.072–0.076 m, Hub'Eau Île Graviat 60 mm, so they share a staff to within about 1.5 cm. This gives DNG − NGF-Lallemand ≈ +2.43 m at Chooz, and (with TAW ≈ NAP + 2.31 m at Givet) **NGF-Lallemand ≈ NAP − 0.12 m** here, if both zeros are identical. It does **not** test TAW ↔ IGN69 directly, as the gap note proposed. Treat it as indicative only.

### 4.2 What "the value" means, per provider

| Provider | Value meaning | Unit | Datum / gauge-zero metadata |
|---|---|---|---|
| NL-1/NL-2 RWS `WATHTE` | **Absolute** | cm | `Hoedanigheid` = NAP (datum-arch counts 690 locations), TAW (8), MSL (17–18), PLAATSLR (22–23) |
| DE-1 PEGELONLINE `W` | Relative to the gauge zero (PNP) for most series; absolute for `m+NN` / `m+PNP` | cm (or m) | `gaugeZero {unit, value, validFrom}` on 642 of 737 series; 95 have none (including the 10 RWS mirrors) |
| DE-7 NRW | Relative to PNP | cm | `Nullpunkt` (DHHN2016) in DE-8 metadata |
| DE-9 NLWKN | Relative | cm | `Hoehe` "NN + x m" |
| DE-10 RLP | Relative | cm | `nullpunkt "96,534 (DHHN2016)"` |
| DE-11 HLNUG | Relative | cm | `GAUGE_DATUM` (system not stated) |
| DE-12 LUBW | Relative, but some rows are in m or m ü.M. | cm / m / müM | `NP` |
| BE-1 HIC | **Absolute** (m TAW), e.g. Maaseik 23.32 | m | Implicit TAW |
| BE-2 VMM | `Value` is sometimes relative; `Absolute Value` is m TAW | m | Request absolute |
| BE-3 SPW | `H` relative; `Habs` / `Absolute Value` in m DNG | m | `station_gauge_datum` (DNG); `9999.0` = unknown. Mean.Abs − Mean.Rel = 110.849 − 0.908 = 109.941 m but P90.Abs − P90.Rel = 109.928 m, a **13 mm inconsistency** that suggests the zero changed |
| FR-1 Hub'Eau | Relative (`code_systeme_alti_serie: 31`) | **mm** | `altitude_ref_alti_station` + `code_systeme_alti_site` (presumed to be the gauge zero; UNVERIFIED) |
| FR-3 Vigicrues | Relative (0.06 at Chooz where Hub'Eau shows 60 mm) | **m** | None |
| LU AGE | Relative (the Esch-Sûre dam is absolute m NN) | cm | `zeroScale` (m NN), with changes over time |
| CH BAFU | **Absolute** m ü. M. LN02 (a few small stations are relative) | m | – |

- **Cross-provider duplicates of one place can be different gauges.** See §8 C7 on Lobith: PEGELONLINE's LOBITH matches RWS `lobith.bovenrijn.tolkamer`, not `lobith.bovenrijn.haven`.
- Prefer the authoritative agency for each gauge.

### 4.3 Why neither raw readings nor absolute heights compare (live Rhine, 20:00Z)

| Gauge (km) | Raw W (cm) | Gauge zero (m NHN) | Absolute (m NHN) | MNW / MW / MHW (cm) | Index (W−MNW)/(MHW−MNW) | PEGELONLINE state |
|---|---|---|---|---|---|---|
| Maxau (362) | 285 | 97.721 | 100.57 | 353 / 496 / 785 | **−0.16** | low |
| Kaub (546) | 9 | 67.669 | 67.76 | 65 / 208 / 544 | **−0.12** | low |
| Köln (688) | 54 | 35.038 | 35.58 | 114 / 297 / 725 | **−0.10** | low |
| Düsseldorf (744) | 8 | 24.529 | 24.61 | 70 / 257 / 684 | **−0.10** | low |
| Duisburg-Ruhrort (781) | 137 | 16.106 | 17.48 | 201 / 394 / 835 | **−0.10** | low |
| Emmerich (852) | −7 | 7.998 | 7.93 | 51 / 239 / 669 | **−0.09** | low |
| RWS Lobith haven | 615 cm NAP | – | 6.15 (NAP) | – | – | waterinfo: "Verlaagde waterstand" |

Absolute heights mostly reflect bed slope. The normalised index is what a user can "follow downstream".

### 4.4 Timestamp conventions: store UTC `timestamptz`

| Source | Format | Zone / pitfall |
|---|---|---|
| NL-1 RWS REST output | `2026-09-23T20:50:00.000+01:00` | **Fixed `+01:00` all year.** Correct once the offset is parsed; accepts `Z` on input |
| NL-2 RWS WFS `TIJDSTIP_LAATSTE_METING` | `…Z` | **Europe/Amsterdam wall-clock time mislabelled `Z`** |
| NL-3 waterinfo | `…Z` (JSON); chart CSV "Tijd (NL tijd)" has no offset | |
| DE-1 PEGELONLINE JSON | `2026-09-23T21:45:00+02:00` | Local offset. **CSV has no offset.** Daily files are CET all year |
| DE-3 BfG 14-day CSV | `DD.MM.YYYY HH:MM`, "GMT+1" | Daily means stamped at the start of the day |
| DE-6 LHP | `updated` fixed `+01:00`; feature `timestamp` has **no offset (local legal time)** | |
| DE-7 NRW / DE-8 OpenHygon / DE-11 HLNUG | ISO with offset | **Fixed `+01:00`** (MEZ) all year |
| DE-9 NLWKN | `/Date(ms)/` | Only `DatumUTC` is correct; `Datum` is +1 h mislabelled `+0000` |
| DE-10 RLP API / CSV | ISO `Z` / no zone | CSV is MEZ (inferred) |
| DE-12 LUBW | Strings ending "MESZ" | Local; the file header says "MEZ"; future timestamps seen |
| DE-13 GKD HTML | no zone | Local legal time (inferred) |
| DE-15 WVER | ISO `+02:00` | True local offset |
| BE-1/2/3 KiWIS | `+02:00` by default | **Pass `timezone=UTC`** to get `Z`. Daily aggregates are stamped at 00:00 UTC+1 (`T01:00+02:00` / `T23:00Z`) |
| FR-1 Hub'Eau | `…Z` | UTC. Pre-2007 archives may be local ("A partir du 23/03/2007, les données sont en TU") |
| FR-3/4 Vigicrues | epoch ms UTC / `+00:00` (legacy forecast route) | **The v1.1 forecast route uses `+02:00`** |
| LU-1 CSV | `dd.mm.yyyy HH:MM`, no offset | Local with DST since 09/2026 (UTC+1 before); **labels 15 min late** (P5b: on time since the format change of 2026-09-30, §2.6) |
| LU-2/3 JSON | ISO with offset (Europe/Luxembourg) | |
| LU-5 CAP | CAP times with offset | E2 uses epoch ms |
| CH-1 LINDAS | `+01:00` fixed | |
| CH-2/3/4 hydrodaten | `+02:00` in summer | Local with offset |
| CH-8 history CSV | FAQ: UTC+1, start of interval; sample: `+00:00` | **Conflict; clarify** |
| CH-9 data.bs.ch | UTC | |

**Rules**
- Parse the offset every time.
- Never parse local-time strings without a tz database. On **2026-10-25 at 01:00Z** the local hour 02:00–02:59 occurs twice.
- Align rollups on UTC, and document that provider daily means (KiWIS `DagGem` at 00:00 UTC+1) differ from ours.
- Reject timestamps more than 15 min in the future.
- Unit-test every parser against known instants.

### 4.5 Units and canonical factors (H → cm, Q → m³/s)

| Source | H | Q | Factor |
|---|---|---|---|
| PEGELONLINE | cm (some `m+NN`, `m+PNP`) | m³/s | ×1; for `m+NN` ×100 with datum = NN |
| RWS | cm | m3/s (ignore the `m3/d` Sommatie series) | ×1 |
| Hub'Eau | **mm** | **l/s** | ×0.1; ×0.001 |
| Vigicrues | **m** | m³/s | ×100; ×1 |
| KiWIS HIC/VMM/SPW | m | m³/s | ×100; ×1 |
| NRW, NLWKN, RLP, HLNUG, LU AGE | cm | m³/s where present | ×1 |
| LUBW | cm / m / müM (mixed) | m³/s | per row unit |
| BAFU | m | m³/s (6 stations in l/s) | ×100; ×1 or ×0.001 |

Unit and scale belong in the series metadata (`native_unit`, `to_canonical`), set during metadata review and never guessed per row.

### 4.6 Reference levels, thresholds and forecasts exposed via API

| Provider | Reference values / thresholds (machine-readable) | Forecasts (machine-readable) |
|---|---|---|
| NL-1 RWS | **None in the API** (catalogue: only WATHTE × {NAP, TAW, MSL, PLAATSLR} and Q). A static xlsx (NL-4) holds the class boundaries. NL-3 has class labels only (undocumented) | H 183 locations, Q 13, about 34 h, 10 min, `RWSM-F232`; astronomical tide to the end of 2027 |
| DE-1 PEGELONLINE | MNW, MW, MHW (with a 2010-11-01 – 2020-10-31 span), NNW, HHW (with dates), HSW, GlW, TuGLW, Marke I/II(/III), tidal values (MThw …); `stateMnwMhw` / `stateNswHsw`. **W only.** About 51 % of W series have MNW/MHW | DE-2 `WV`: 7 Rhine gauges, 96 h; DE-3 BfG 14-day and 6-week CSVs |
| DE-6 LHP | Station flood class −1…4 for 1,590 gauges (all states; 216 without a class), with the official colours; regional alerts on a separate 1/2/4/5/6 scale | – |
| DE-7 NRW | `LANUV_MNW`/`MW`/`MHW`, `LANUV_Info_1..3`; `alarmlevel.json` (information levels 1–3, N7W) | – |
| DE-9 NLWKN | `Meldestufen` 1–3 (cm, and NN for stage 1) | – |
| DE-10 RLP | Extreme events per site; HW2–HW100 station legend; 46 regional alert classes (1–7) | p10…p90 at 66 gauges, about 45–48 h (`time`, `nextUpdateTime`) |
| DE-11 HLNUG | UNVERIFIED | `vhs.60` about +24 h; `abs.60`/`nor.60` about +7 days; layer 16 Vorhersage |
| DE-12 LUBW | HW/MQ statistics in `jf-data-stm-peg.js` | – |
| BE-1 HIC | **`DrempelPrewaak.O` / `DrempelWaak.O` / `DrempelAlarm.O`** (m TAW; Maaseik 29.30 / 30.99 / 32.00, valid from 2022-12-14); day-of-year percentiles `MeetPeriodeDagP10…P99`; `AnalysePeriodeP10…P90`; Q return periods `KalJaarT005…T200`; `AlarmStatusDroogteDag`. **P10 (24.04) > P90 (23.26), so these look like exceedance percentiles** (UNVERIFIED from docs). Call: `getTimeseriesList&station_no=maa02a-1066`, then `getTimeseriesValues&ts_id=123903010,…&from=2022-01-01&to=2026-12-31` | 48 h / 10-day H and Q ensembles (506056–506059); astronomical tide |
| BE-2 VMM | `DrempelPrewaak`, `DrempelWaak`, `DrempelPrealarm`, `DrempelAlarm`, `AlarmStatus` series exist but were **empty** for every sampled station | `H_voorspeld` / `Q_voorspeld` parameters exist |
| BE-3 SPW | Long-term `Moyen`/`Median`/`P05…P95` in `.Abs` and `.Rel` forms (**P90 > mean, so non-exceedance: the opposite of HIC**); `998-…CrueDeReference.Top3` (e.g. 2021-07-15 4.269 m); `NIVCRU` station attribute. **Numeric alert thresholds not found (UNVERIFIED).** Call: `getTimeseriesValues&ts_id=240684010,240676010&from=1970-01-01&to=2028-01-01` | Not found in the public KiWIS (UNVERIFIED) |
| FR-1 Hub'Eau | **None** | – |
| FR-5 Vigicrues | `NivInfViCr` 1–4 per river section (337 sections); per-station `CruesHistoriques`. No per-station numeric thresholds | FR-4 P10/P50/P90, about 21 h, event-only |
| LU-4 AGE | Yellow/orange/red vigilance (cm; 0 = undefined); HQ2–HQ100 equivalent levels; status classes | LU-3 p10–p90, about 45 h, 14 stations |
| LU-5 LU-Alert | Regional vigilance for 3 zones | – |
| CH-2 BAFU | `wl_1..wl_4` = lower bounds of danger levels 2–5 (180 of 207 stations); CH-1 `dangerLevel` 1–5 (36 undefined); CH-5/CH-6 warning sections and classes | CH-4 median, 25–75 %, min/max, about 115 h, 55 stations |

### 4.7 How to present values honestly (datum-arch §A.5, adopted)

1. **Map colour uses one ordinal state scale with explicit provenance:** `no-ref` (grey), `low`, `normal`, `elevated`, `high`, `extreme`. Fill it in this order of priority:
   - operational thresholds: HIC prewaak/waak/alarm, Vigicrues tronçon colour, BAFU danger levels, AGE vigilance, NLWKN Meldestufen, NRW Info levels, LHP class;
   - statistical references: PEGELONLINE MNW/MHW/HHW, NRW MNW/MHW, Wallonia and HIC percentiles, AGE HQ levels;
   - the provider's own class (the waterinfo.rws label, or the RWS xlsx classes).
   
   Store `state_basis` (for example `PEGELONLINE:MNW/MHW 2010–2020`) and show it in the popup. The provider-by-provider mapping is the crosswalk in §4.9 (to be signed off by the product owner). The legend must say that classes follow each agency's own references and are not strictly equivalent across countries.
2. The **continuous index** `I = (W − MNW)/(MHW − MNW)` applies only where MNW and MHW exist (about half of PEGELONLINE). Do not mix it with threshold classes on one colour ramp.
3. **"Follow the water" mode works from day one:** show the change since the start of the window, `Δh = h(t) − h(t0)`, in cm, as an arrow or a size. The datum cancels out, so it works on relative readings in every country.
4. **Discharge (m³/s)** is physically comparable and conserved downstream, which makes it the best quantity for the flow story. Coverage is thinner: PEGELONLINE has 94 Q vs 737 W series, RWS 199 Q locations, NRW and LU none in real time, and the Wallonia Meuse main stem is Q-only. Q also drops out at extremes (Emmerich; Chooz switches station below 40 m³/s).
5. **Absolute height belongs only in the detail view**, e.g. "≈ x.xx m NAP (converted from TAW −2.33 m / NHN +0.01 m; ±2 cm)". Always also show the raw value exactly as published, with unit and datum. Never draw a cross-border absolute profile until the offsets are verified. **French stations get no converted absolute height in the first release** (gap check: the IGN69 offset and Hub'Eau's zero metadata disagree by 5 cm to 1.1 m at the only shared gauges; §4.1). Show "gauge zero: x m IGN69 (Hub'Eau metadata, unverified)" instead.
6. **Weir- and lock-controlled reaches** (Moselle, Saar, Neckar, Main, Lahn, upper Ems, Walloon Meuse and Sambre, Upper Rhine barrages): the stage barely moves, so prefer Q, or the anomaly against MW, and label the reach.
7. **Tidal reaches** (Zeeschelde, Western Scheldt, Ems below Herbrum, the Dollard, the lower Rhine–Meuse delta) oscillate 3–5 m. Use separate styling, a tidal mean, or the surge (measured − astronomical, where RWS and HIC astronomical series exist).
8. Later: our own day-of-year percentiles, once there are 1–3 years of data or a backfill.

### 4.8 Quality flags to map into one `qc` bitmask (datum-arch §C.5)

Bits: 1 = provisional/raw, 2 = validated, 4 = provider-suspect, 8 = estimated, 16 = our range check, 32 = our spike check, 64 = our flatline check.

Provider flags to map:
- PEGELONLINE: everything is `ROHDATEN`; a `comment` signals disruption.
- RWS: `Statuswaarde`; `Kwaliteitswaardecode` (00 normal, 99 gap).
- waterinfo.rws: `possiblyFaulty`.
- Hub'Eau: `code_statut` / `libelle_qualification_obs` ("Non qualifiée", "Douteuse") / `code_methode_obs`.
- KiWIS: `Quality Code`, which differs per instance (HIC 111, VMM 100 "GoodExt", SPW 200). The DOV wiki page "Kwaliteitsvlaggen hydrometrie-data HIC en VMM" documents HIC and VMM (https://www.milieuinfo.be/confluence/display/DDOV/Kwaliteitsvlaggen+hydrometrie-data+HIC+en+VMM).

Our own checks:
- **Stale:** `age = T − ts`. Show a badge when age > `max(3 × expected_step, 45 min)`; drop the station from the map after 25 h (the PEGELONLINE convention). Live, 10 of 737 PEGELONLINE W series were more than 1 h old, 3 more than 25 h and 1 more than 7 days.
- **Frozen:** unchanged for 12 h or more **and** a linked neighbour moved by more than 5 cm. A flat line alone is not enough: Emmerich stayed at −7 cm legitimately, and weir reaches stay flat for days.
- **Spike:** a jump beyond a physical rate (e.g. 50 cm per 15 min on the main rivers) that reverts within 2 steps.
- **Sentinels to drop:** RWS `99`/`0.0`; PEGELONLINE `99999.0`; NLWKN `-888`; VMM `−10000`; KiWIS `null`/`-1`; Hub'Eau null codes; NRW `NA`; RLP `-`.

### 4.9 Class crosswalk to the common scale (proposal; the product owner must sign it off) [synth]

Target scale (§4.7): `no-ref` (grey), `low`, `normal`, `elevated`, `high`, `extreme`. Each row maps one provider class. "Basis" says what the class measures: **stage** at a gauge, **discharge** at a gauge, or an **area** (a river section or region). Area classes are drawn as area or section overlays and may colour a station only with an explicit "section" badge. Where a station has both a gauge class and an area class, the gauge class wins and the area class is shown alongside.

| Provider scale | Provider class | Target | Basis | Rationale / caveat |
|---|---|---|---|---|
| DE-6 LHP station `lhpClass` | −1 "Derzeit keine Daten"; key absent ("Ohne Hochwasser-Einstufung") | no-ref | stage | Absent is not an error: 216 live features have no class |
| | 0 "Kein Hochwasser" | normal | stage | LHP cannot distinguish low water; use PEGELONLINE MNW for `low` where available |
| | 1 "Kleines Hochwasser" | elevated | stage | The Länder's lowest reporting level (Meldestufe 1 or equivalent) |
| | 2 "Mittleres Hochwasser" | high | stage | |
| | 3 "Großes Hochwasser", 4 "Sehr großes Hochwasser" | extreme | stage | Keep the LHP class number in the popup |
| DE-6 LHP alert `lhpClass` (string) | 1 "Entwarnung" | normal | area | All-clear |
| | 2 "Vorwarnung" | elevated | area | |
| | 4 "Hochwasser" | high | area | |
| | 5 "Großes Hochwasser", 6 "Sehr großes Hochwasser" | extreme | area | Different numbering from the station scale; never mix them |
| DE-10 RLP alert region `alertClassId` / station legend | 1 "Keine Informationen" | no-ref | area | |
| | 2 "Geringe Hochwassergefahr" (≈ MW) | normal | area | Station legend adds "< Mittelwasser" and "< mittleres Niedrigwasser"; owner decision of 2026-10-03 (P7b, R-090): only "< mittleres Niedrigwasser" (W ≤ MNW) is `low`, "< Mittelwasser" is `normal` |
| | 3 "Mäßige" (HW2) | elevated | area / stage | Return-period based |
| | 4 "Mittlere" (HW10) | high | area / stage | |
| | 5 "Hohe" (HW20), 6 "Sehr hohe" (HW50), 7 "Extreme" (HW100) | extreme | area / stage | |
| FR-5 Vigicrues `NivInfViCr` | 1 vert | normal | area (section) | Attach to stations through the section's station list (§2.5) |
| | 2 jaune | elevated | area | |
| | 3 orange | high | area | |
| | 4 rouge | extreme | area | |
| CH-1/CH-6 BAFU danger level (CH-2 `wl_1..wl_4` are the lower bounds of 2–5) | 1 "keine oder geringe Gefahr" | normal | discharge (lakes: level) | |
| | 2 "mässige Gefahr" | elevated | discharge | |
| | 3 "erhebliche Gefahr" | high | discharge | |
| | 4 "grosse Gefahr", 5 "sehr grosse Gefahr" | extreme | discharge | |
| | `Undefined` (36 stations) | no-ref | – | |
| CH-5 warning sections | level 1–5 | as the danger level | area | |
| LU-4 AGE vigilance levels (cm) | below yellow | normal | stage | Yellow is 0 (undefined) almost everywhere, so most stations start at orange |
| | ≥ yellow / ≥ orange / ≥ red | elevated / high / extreme | stage | Gated (needs AGE permission) |
| LU-4 AGE status class | `lowerboundexceeded` (< MNQ) | low | stage (discharge-equivalent) | |
| | `mnq`, `mq` | normal | | |
| | `hq2` | elevated | | |
| | `hq10`, `hq20` | high | | |
| | `hq50`, `hq100` | extreme | | |
| LU-5 LU-Alert `cb-eu-level` | ALERT_LVL_4 information | normal | area (3 zones) | |
| | ALERT_LVL_3 yellow / 2 orange / 1 red | elevated / high / extreme | area | Note the inverted numbering; `TEST` is dropped |
| BE-1 HIC thresholds (m TAW) | below `DrempelPrewaak` | normal | stage | |
| | ≥ prewaak / ≥ waak / ≥ alarm | elevated / high / extreme | stage | Gated (HIC agreement) |
| DE-7 NRW `LANUV_Info_1..3` | W ≤ `LANUV_MNW` | low | stage | |
| | below Info 1 | normal | stage | |
| | ≥ Info 1 / ≥ Info 2 / ≥ Info 3 | elevated / high / extreme | stage | Info levels exist only at "Infopegel" |
| | W ≥ `LANUV_MHW` | elevated | stage (statistical) | Owner decision of 2026-10-03 (P7b, R-090): as PEGELONLINE MHW, so a gauge without Info levels is normal between MNW and MHW |
| DE-9 NLWKN `Meldestufen` 1–3 | below 1 / ≥ 1 / ≥ 2 / ≥ 3 | normal / elevated / high / extreme | stage | Gated |
| DE-1 PEGELONLINE | W ≤ MNW | low | stage (statistical) | Statistics, not warnings |
| | MNW < W < MHW | normal | stage | |
| | W ≥ MHW | elevated | stage | |
| | W ≥ HSW (Marke II; navigation stops) | high | stage | PEGELONLINE has no "extreme"; take extreme from LHP for the same gauge |
| NL-4 RWS Waterinfo legend (display classes, **not** alert levels) | "Verlaagd…", "Laagwater", "Verlaagde afvoer" | low | stage or discharge | Match on the label stem and the class order, not on the full text (labels embed the bound, e.g. "Licht verhoogd (>200cm)") |
| | "Normaal…", "Normale…", "Streefpeil…" | normal | | |
| | "Licht verhoogd…", "Verhoogd(e)…" | elevated | | "Licht verhoogd" at Lobith is > 4,450 m³/s, below the WMCN warning start (Lobith 14.00 m NAP, rising above 15.00 m); treat it as elevated but not as a warning (the 14/15 m figures come from an IKSR page seen only in a search summary) |
| | "Hoog(water)…", "Hoge afvoer…", "Stormvloed…" | high | | "Stormvloed" is a coastal label; the workbook ranks it at order 2 with Hoogwater, below Extreem (D18, 2026-10-03) |
| | "Extreem…" | extreme | | |
| BE-3 SPW, FR-1 Hub'Eau | – | no-ref (or low/normal from our own percentiles later) | – | No machine-readable thresholds |

**Rule for LHP duplicates** (gap item 6, re-checked live): 9 name-and-river duplicates exist, 4 of them with conflicting classes. Worms is RP 0 and HE −1; Perl is SL 0, RP −1 and a second SL entry −1; Kaub and Mainz appear under HE and RP; Kleinheubach and Obernau under BY and HE; Havelberg under BB and ST (both 0). Rule: **group features by the numeric part of the id and by position (< 500 m); take the class from the state that operates the gauge** (for WSV gauges: the state whose flood centre issues the Meldestufen for it, e.g. RP for Worms, Mainz, Kaub and Perl); if that state reports −1 or nothing, use the **worst other class** and show its provenance ("class from LHP/HE").

**D18, signed by the owner on 2026-10-03:** this table as proposed, with the rows the P7a build flagged decided as built: NL-4 "Stormvloed" is `high` (RWS ranks it at order 2 with Hoogwater, below Extreem), not extreme; LU-4 HQ5, DE-1 Hochwassermarken I to III and GlW, and BE-3 `NIVCRU` are shown and never classify; CH-5 level 0 ("Keine Gefahrenstufe") is `no_ref`; the LHP operating state of Obernau is BY and of Kalkofen-neu RP; the LHP alert "2" (Vorwarnung, `elevated`) is drawn hatched in P10, with no colour stored. The table in force is `packages/core/src/crosswalk.ts`.

---

## 5. Map stack facts

### 5.1 Basemap options

| Option | Live status | Terms (quoted or summarised) | Verdict |
|---|---|---|---|
| **OSM Standard** `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | 200 with a custom UA (`cache-control: max-age=520469, stale-while-revalidate=604800, stale-if-error=604800`; `x-tilerender: orm.openstreetmap.org`). **With the default curl UA it returned HTTP 200 carrying a 6,987-byte "403 Access blocked" PNG and the header `x-blocked`.** | [Tile policy](https://operations.osmfoundation.org/policies/tiles/): clear attribution; a unique UA ("Do not use a library default User-Agent"); a valid Referer; honour caching or cache for at least 7 days; no bulk download or prefetch; "We may block access, without notice"; "no SLA"; "Commercial services should note: access may be withdrawn at any point." | Prototype or last resort only. It is raster and cannot be restyled |
| **OpenFreeMap** `https://tiles.openfreemap.org/planet` (TileJSON 3.0.0) | 200. Tiles at `https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf` (weekly build ID; **resolve it via the TileJSON**). maxzoom 14, version 3.16.0, CORS `*`, `max-age=315360000`, Cloudflare. Styles: `/styles/liberty` (43 KB), `bright`, `positron`, `dark`, `fiord`. Glyphs: `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf`; sprite `https://tiles.openfreemap.org/sprites/ofm_f384/ofm` | [openfreemap.org/tos](https://openfreemap.org/tos/): "no limits on the number of map views or requests"; no keys or cookies; commercial use allowed; attribution required; "I don't offer SLA guarantees"; "may discontinue it at any time without notice"; no automated collection without permission. Code is MIT and self-hostable | **Fallback, and the development default** (`positron`). Retention of old builds is UNVERIFIED |
| **Protomaps PMTiles** (self-hosted extract) | `https://build-metadata.protomaps.dev/builds.json` lists 62 builds. Latest: `{"key":"20260923.pmtiles","size":138242597731,"uploaded":"2026-09-23T09:09:59.501Z","version":"4.15.2"}`. `build.protomaps.com` answers Range 206 but sends **no CORS**. Spec v3, mvt, z0–15, gzip, planetiler 0.10.2; OSM replication 2026-09-23T04:00:00Z | [docs](https://docs.protomaps.com/basemaps/downloads): builds kept for 1 week plus the latest of each patch version; "hotlinking to these downloads are discouraged… copy the tileset to your own Cloud Storage"; ODbL Produced Work with OSM attribution | **Primary** |
| VersaTiles `https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}` | 200, Shortbread schema, maxzoom 14. **Data dated 2026-06-07 (about 3.5 months old)**; download file `osm.20260608.versatiles`; versatiles-rs 4.15.0 (MIT) | Not reviewed (UNVERIFIED) | Another fallback |
| CARTO `basemaps.cartocdn.com/light_all/…` | 200 | Restricts commercial and high-volume use (UNVERIFIED) | Not recommended |
| OSM-FR / HOT `a.tile.openstreetmap.fr/hot/…` | 200 | Volunteer server | Not recommended |
| PDOK BRT Achtergrondkaart `service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/6/33/21.png` | 200 | NL only | Not suitable |
| BKG basemap.de | Guessed URL returned 404 (UNVERIFIED) | DE only | Not suitable |
| Self-generated (Planetiler, OpenMapTiles or Shortbread profile, over Geofabrik extracts → PMTiles/MBTiles, served via Martin or tileserver-gl) | Geofabrik sizes via WebFetch (data as of 2026-09-22): NL 1.3 GB, BE 662 MB, LU 45 MB, DE 4.5 GB, FR 4.7 GB, CH 521 MB | ODbL | Full control, but a pipeline to own |

**PMTiles extract sizes** (`go-pmtiles extract <planet> out.pmtiles --bbox=… [--maxzoom=N] --dry-run` against the 20260923 build; go-pmtiles 1.31.2):

| Extract | bbox (W,S,E,N) | Zooms | Tiles | Size |
|---|---|---|---|---|
| Study area (NL, BE, LU, western DE, northern/eastern FR) | 1.5,47.3,10.5,54.0 | 0–15 / 0–14 / 0–12 | 1,055,674 / 264,374 / 16,734 | **6.5 GB / 2.9 GB / 698 MB** |
| Whole Rhine basin incl. the CH Alps and the Main | 1.5,45.8,12.5,54.0 | 0–15 / 0–14 | 1,554,724 / 389,398 | 9.2 GB / **4.3 GB** |
| Rhine, Meuse, Scheldt, Ems and Vecht basins (stack-landscape) | 2.0,45.5,11.0,54.0 | ≤ z12 / ≤ z15 | – | **926 MB / 8.2 GB** |
| NL-ish only | 3.2,50.7,7.3,53.6 | 0–15 | 216,115 | 2.0 GB |
| World context | planet | 0–6 | 5,461 | 45 MB |
| Europe mid-zoom | -10,35,30,60 | 0–9 | 4,338 | 339 MB |

**Recommendation (map-rivers):**
- Serve a z0–14 regional extract (2.9 GB study area, or 4.3 GB full Rhine basin) plus planet z0–6 (45 MB) from our own storage or VPS with HTTP Range support.
- Style it with a muted `@protomaps/basemaps` flavour (5.7.2, BSD-3; compatibility with v4 tiles is UNVERIFIED).
- Refresh it monthly or quarterly with `pmtiles extract`.
- Whether a CDN caches range requests on multi-GB files depends on the vendor. The workaround is a serverless PMTiles → z/x/y proxy (UNVERIFIED).
- Basemap labels in NL/EN depend on the style's `name:nl` / `name:en` handling (UNVERIFIED).

### 5.2 Map library (npm versions and jsDelivr gzip sizes, 2026-09-23)

| | MapLibre GL JS | Leaflet | OpenLayers | deck.gl (overlay) |
|---|---|---|---|---|
| Version | **6.11.1** (published 2026-09-23; 6.0 on 2026-07-22; v5 frozen at 5.24.0, 2026-04-23) | 1.9.4 (2023); 2.0.0-alpha.1 | 10.10.0 | 9.4.0 (2026-09-05) |
| Licence | BSD-3-Clause | BSD-2-Clause | BSD-2-Clause | MIT |
| Size (gzip) | main 148.9 KB + shared 146.5 KB + worker 6.1 KB ≈ **300 KB**; CSS 83 KB raw | 42 KB | full `ol.js` 289 KB (tree-shakeable) | `dist.min.js` 575 KB |
| 2–5k markers | Trivial as a `circle`/`symbol` layer with `feature-state` | OK with `preferCanvas` | OK (WebGL points) | Trivial (ScatterplotLayer) |
| Time animation | `setFeatureState` or `setData` per frame (a few fps at 5k); `global-state` expression (≥ 5.6) | Manual | Manual | TripsLayer `currentTime`/`trailLength` |
| Animated lines | `line-dasharray` animation (data-driven since 5.8.0). `line-gradient` needs `lineMetrics:true`, **is not data-driven and has no feature-state** | Plugins | Custom | TripsLayer; PathLayer per-vertex colour |

**MapLibre 6 breaking changes** (stack-landscape):
- **ESM-only**: the UMD and CSP bundles are gone and so is the default export; `dist/maplibre-gl.js` returns 404 on jsDelivr.
- **WebGL2 required**, so provide a no-WebGL2 fallback (a table view, also good for accessibility).
- `map.transform` removed; events became classes; `GeoJSONSource.setData` changed.
- Releases come about weekly (6.0 → 6.11.1 in two months).
- Follow the migration guide: https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/.
- `@deck.gl/mapbox` `MapboxOverlay` with MapLibre v6 is **UNVERIFIED**; prototype it early.
- JS PMTiles decoder: `pmtiles` 4.5.0 (BSD-3, about 8 KB gzipped, used through `addProtocol`).

### 5.3 River geometry datasets

| Dataset | Licence | Topology / direction | Resolution | Access | Verdict |
|---|---|---|---|---|---|
| **OSM** `waterway=river` ways + `type=waterway` relations | ODbL 1.0 (share-alike on derivative databases) | Ways point **downstream** (checked live on the Boven-Rijn: way 74917953 runs east → west; way 662657942 Bijlandsch Kanaal). Connectivity comes from shared nodes; bifurcations are allowed; relation roles include `main_stream`/`side_stream`/`spring`/`mouth` | Best; matches the basemap; multilingual names + Wikidata IDs | Geofabrik PBF (osmium/pyosmium); OSM API (live); Overpass UNVERIFIED (overpass-api.de reset, kumi timed out, mail.ru 504) | **Primary** |
| **EU-Hydro River Network Database v1.3** (Nov 2020, CLMS/EEA) | CLMS full, free, open (Reg. 1159/2013): cite the source, state modifications, imply no EU endorsement | Explicit `NEXTDOWNID`, `NEXTUPID`, `FNODE`, `TNODE`, `STRAHLER`, `LONGPATH`, `CUM_LEN`, `nameText`; digitised downstream | 1:50,000, MMU 1 ha, imagery 2006–2012, EPSG:3035. EU-Hydro 2.0 is in production (EGU26) | The bulk GDB/GPKG needs EU Login. Anonymous ArcGIS REST: `https://image.discomap.eea.europa.eu/arcgis/rest/services/EUHydro/EUHydro_RiverNetworkDatabase/MapServer/12/query?…` (layers 5–13 = Strahler 1–9; `maxRecordCount` 1000) | **QA and licence-clean fallback** |
| HydroRIVERS v1.0 | Custom WWF licence: free commercial use, but redistribution needs an EULA "at least as protective" plus the Exhibit B notice. (v2, CC-BY 4.0, covers only the Americas so far) | Connected, single `NEXT_DOWN` (**no bifurcations**); `DIST_DN_KM`, `DIST_UP_KM`, `UPLAND_SKM`, `DIS_AV_CMS` | 15″ (about 300–450 m); weak in the flat polder landscape | `HydroRIVERS_v10_eu_shp.zip` (67,648,957 B) | Internal analysis only; **do not serve its geometry** |
| CCM2 v2.1 (JRC, 2008) | "freely available for non-commercial use" (search result) | Strahler/Pfafstetter | 100 m DEM | 502 / "Request Rejected" (UNVERIFIED) | Exclude |
| Natural Earth 10 m + Europe supplement | Public domain | None | 1:10M; the Rhine has about 500 vertices; Sambre, Ourthe, Lahn, Nahe, Rur and Dender are missing | `ne_10m_rivers_lake_centerlines.zip` 2.08 MB; `ne_10m_rivers_europe.zip` 0.6 MB (2021) | Low zoom only |
| EuroGlobalMap (EuroGeographics) | Attribution text: "This product includes Intellectual Property from European National Mapping and Cadastral Authorities and is licensed on behalf of these by EuroGeographics…". Exact licence UNVERIFIED | Direction not verified | 1:1M | UNVERIFIED | Not needed |
| EuroRegionalMap | UNVERIFIED | – | 1:250k | – | Not evaluated |
| LU geoportail primary rivers (LU-6) | CC0 | – | – | `https://features.geoportail.lu/collections/749/23` (311 features) | Optional LU context |

- **OSM relation IDs** (Wikidata P402 plus the OSM API): Rhein **123924** (`name:nl` Rijn, `distance=1233`; 269 members: 168 `main_stream`, 101 `side_stream`), Meuse **1075197** (351 members, including `spring`), Escaut **324288** (111 members, one with an empty role), Moselle **390416** (270 members: 13 empty-role, 18 `tributary`), Ems **370068**, Main 412876, Neckar 123881, Sambre 1600647, Ourthe 2246211, Rur 384594, Lahn 412935, Saar 390393, Sieg 409090, Ruhr 364754, Lippe 379691. Wikidata returns **two candidates each for the Nahe and the Lys**.
- EU-Hydro sample: `{"OBJECT_ID":"RL26021212","nameText":"BOVENRIJN, WAAL","STRAHLER":8,"NEXTDOWNID":"RL26021204","NEXTUPID":"RL26026307","FNODE":"NO26021119","TNODE":"NO26021093","LENGTH":9362.43,"LONGPATH":244200.2,"CUM_LEN":72728416}`. Pitfall: an implausible Strahler value in the delta (Linge = 8).
- **ODbL implications:**
  - The rendered map is a Produced Work, so only attribution is needed.
  - A river graph extracted from OSM is a **Derivative Database**. If it is served publicly, it must be offered under ODbL. Publish it as an ODbL download.
  - Station and measurement data is a separate **Collective Database** and is not caught by share-alike ([Horizontal Map Layers guideline](https://osmfoundation.org/w/index.php?title=Licence%2FCommunity_Guidelines%2FHorizontal_Map_Layers_-_Guideline&mobileaction=toggle_view_desktop); [Collective Database guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)).
  - Keep station chainage from official river-km, not from OSM geometry.

**Graph-build pipeline (offline, re-run monthly)**
1. Curate the OSM relation IDs for about 40–60 rivers: the Rhine branches (Bovenrijn/Waal/Pannerdensch Kanaal/Nederrijn-Lek/IJssel), Main, Neckar, Moselle, Saar, Sauer, Lahn, Nahe, Sieg, Ruhr, Lippe, Erft, the Meuse with Sambre/Ourthe/Semois/Rur/Niers, the Scheldt with Leie/Lys and Dender, the Ems, the Overijsselse Vecht, and the small border rivers.
2. Extract them from Geofabrik PBFs with osmium. Keep `main_stream` ways, or empty-role ways that connect.
3. Build a directed graph (nodes = shared OSM nodes; edges = ways as drawn). Check for cycles. Flag reversed ways by EU-DEM elevation or by conflict with EU-Hydro `NEXTDOWNID` (buffer match within about 200 m). **Allow several downstream edges at bifurcations** (Pannerdensche Kop and IJsselkop).
4. Simplify for display per zoom (Douglas–Peucker at 5 m, 50 m and 500 m). Keep the full version for snapping.
5. Snap stations to candidate edges within 300–500 m whose river name or Wikidata ID matches the station's water body (e.g. PEGELONLINE `water.longname`). **Never snap on distance alone**: the Juliana Canal and Albert Canal along the Meuse, the Bijlandsch Kanaal and the Grand Canal d'Alsace run beside the rivers. Keep a manual override table.
6. Chainage: prefer official river-km (PEGELONLINE `km`; RWS rkm for the Dutch Meuse and the Rhine branches, which continue the German Rhine-km; Belgian and French PK are UNVERIFIED). Fall back to graph distance to the Dutch entry point. Store `(river_id, km_official, km_system, km_to_NL_entry)`, because km systems count in different directions and restart per country.
7. Travel-time priors per edge (§3.7), then empirical calibration.

### 5.4 Visualisation techniques

1. **Time-slider replay (MVP):** hourly frames over a window that grows from go-live, played in about 10–20 s. Colour stations by anomaly class, never by absolute level. For 5k points, use a MapLibre `circle` layer with `feature-state`, or rebuild GeoJSON per frame (a few fps). For smooth 30–60 fps, use a deck.gl ScatterplotLayer with a Uint8Array colour buffer (5k × 4 bytes per frame).
2. **River segments coloured between stations:** split the main stems at station snap points and interpolate upstream and downstream values, optionally time-shifted by edge travel time. For smooth gradients, use a deck.gl PathLayer with per-vertex colours; MapLibre `line-gradient` cannot do this per feature.
3. **Flow direction:** cycle `line-dasharray` in `requestAnimationFrame`, or use a deck.gl TripsLayer (timestamps = cumulative travel hours). Both rely on downstream-oriented geometry.
4. **Flood-crest tracking (later):** detect peaks, link them along the graph, and show an "ETA at Lobith/Eijsden" band labelled indicative.
5. **Space-time (Hovmöller) panel per river:** x = river-km, y = time, colour = anomaly. A flood wave shows as a diagonal band. This is cheap and strongly recommended as an early post-MVP feature.
6. **Custom WebGL (later):** a data texture of station × time, with per-vertex attributes (upstream/downstream station index, fraction, travel-time offset), sampled as `value(t − offset)` in a shader. MapLibre `global-state` is an alternative (performance UNVERIFIED).
7. **Colour and accessibility:**
   - Use a diverging, colour-blind-safe anomaly palette (low = brown/orange, normal = light neutral, high = blue → purple; ColorBrewer BrBG or PuOr, or Crameri "vik"/"roma"). **Avoid red/green.**
   - Add redundant encodings: ▲/▼ trend arrows, size, and hatching for tidal and stale stations.
   - Keep the scale open-ended (the 2026 low water went below the recorded NW/NNW).
   - Respect `prefers-reduced-motion`, make the slider keyboard-operable, and check with a CVD simulator.
   - Keep the provider class colours where terms require it (LHP colours; CH band colours #FFFF00 / #FF9900 / #F7001D / #800000; LHP `#941094` … `#7CBD5C`, `#7b7b7b` for no data).
8. **Mobile:** cap the pixel ratio at about 1.5–2; throttle to 20–30 fps; pause on `visibilitychange`; serve hourly frames as compact binary (Int16/Float32); keep the basemap at z ≤ 14 with few labels; lazy-load deck.gl.

### 5.5 Attribution and OSM rules

- Protomaps: **"© OpenStreetMap contributors"** linking to https://www.openstreetmap.org/copyright, plus "Protomaps".
- OpenFreeMap: **"OpenFreeMap © OpenMapTiles Data from OpenStreetMap"**, exactly as in the TileJSON (`<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>`).
- The [OSMF attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines) place the credit in a map corner. On mobile it may collapse after interaction or after 5 s, as long as it stays findable.
- Keep the Referer header, because `no-referrer` breaks the OSM tile policy.

---

## 6. Storage, ingestion and security facts

### 6.1 Volume (datum-arch §B.1; stack-landscape)

- Rows per series per year: 35,040 at 15 min and 52,560 at 10 min. PEGELONLINE alone publishes about 630,000 values per day across all parameters (ITZBund).

| Scenario | Rows/yr | 5 yr | 10 yr |
|---|---|---|---|
| A: 2,000 series @ 15 min | 70 M | 350 M | 0.70 B |
| B: 3,000 @ mixed (about 120/day) | 131 M | 657 M | 1.31 B |
| C: 4,000 @ 10 min | 210 M | 1.05 B | 2.10 B |

| Engine | Bytes/row | A: 1 / 5 / 10 yr | C: 1 / 5 / 10 yr |
|---|---|---|---|
| Plain PG, narrow rows + PK | ~94 | 6.6 / 33 / 66 GB | 19.8 / 99 / 198 GB |
| Plain PG hourly rollup | ~100 B/row | +1.75 GB/yr | +3.5 GB/yr |
| TimescaleDB compressed (not benchmarked) | ~5–10 (vendor claims 90 %+) | 0.4–0.7 GB/yr | 1–2 GB/yr (UNVERIFIED) |
| DuckDB file | 3.2 measured (6–10 real) | 0.2–0.7 GB/yr | 0.7–2 GB/yr |
| ClickHouse MergeTree | 0.69 measured (1.5–3 real) | 0.1–0.2 GB/yr | 0.15–0.6 GB/yr |
| Parquet (zstd) archive | 1.1–1.4 measured | – | – |

- Worst case (scenario C, plain PG) is about 23 GB per year. stack-landscape estimates 100–250 M rows/yr and 8–20 GB/yr on plain PG, or under 10 % of that with TimescaleDB compression (UNVERIFIED). ch-bafu estimates about 100k rows/day (about 35 M/yr) for about 230 Swiss stations × 3 parameters.
- Storing French and Walloon data natively at 5 min multiplies their rows by 2–3.
- **Compression is an optimisation, not a requirement, for the first 2–3 years.**

### 6.2 Benchmark

Setup: PostgreSQL 16.13, DuckDB 1.5.5, chDB 4.4.0 (ClickHouse 26.7.2.1) on 4 vCPU / 15 GB. Data: synthetic, 17.86 M rows = 3,000 series × 62 days × 15 min, inserted time-major.

| Test | PostgreSQL 16 | DuckDB | ClickHouse |
|---|---|---|---|
| Storage | heap 52.2 B/row + PK 41.9 B/row; BRIN(ts) 80 kB per 8.9 M-row partition | 3.2 B/row | 0.69 B/row |
| Every series at time T (3 h window) | **LATERAL 15.9 ms**; with per-series staleness 20.3 ms; DISTINCT ON 173 ms without BRIN, 19.8 ms with | 9.4 ms (`arg_max`) | 38 ms (`argMax`) |
| One series, 62 days raw (5,952 points) | 10.1 ms | – | – |
| One series, 62 days as 3 h min/max/avg on the fly | 9.6 ms | 26 ms | 4.5 ms |
| Same from the hourly rollup table | 0.6 ms | – | – |
| All 3,000 series × 72 hourly frames | 160 ms; 370 KB gzip JSON | – | – |
| Idempotent upsert of a 12k-row batch | 127 ms; re-run is a no-op in 28 ms | – | – |

**Engine licences:**
- PostgreSQL License.
- TimescaleDB: the Apache-2 core has hypertables, `time_bucket` and `first/last`. The **TSL** "Community" edition adds compression/columnstore (`add_columnstore_policy`), continuous aggregates, `add_retention_policy`, `time_bucket_gapfill`/`locf`, SkipScan and the job scheduler. TSL is free to self-host but "you cannot sell … as a service". Most managed PG services ship only the Apache edition.
- ClickHouse: Apache-2 (`ReplacingMergeTree(batch_id)`, dedupe at merge time; overkill below about 1 B rows).
- DuckDB: MIT. SQLite: public domain. Both are single-writer.

### 6.3 Schema sketch (datum-arch; plain PostgreSQL)

```sql
CREATE TABLE series (
  series_id        integer PRIMARY KEY,
  station_id       integer NOT NULL REFERENCES station,
  quantity         char(1) NOT NULL CHECK (quantity IN ('H','Q')),
  provider_key     text    NOT NULL,           -- e.g. PEGELONLINE uuid+'W', RWS code+hoedanigheid, KiWIS ts_id
  native_unit      text    NOT NULL,           -- 'cm','m','mm','m3/s','l/s','m+NN'
  to_canonical     double precision NOT NULL,  -- H -> cm, Q -> m3/s (mm: 0.1, m: 100, l/s: 0.001)
  datum            text    NOT NULL,           -- 'NAP','TAW','NHN','NN','IGN69','NGF1884','LOCAL','MSL','PLAATSLR'
  gauge_zero_m     double precision,           -- when datum='LOCAL'
  gauge_zero_datum text, gauge_zero_valid_from date,
  expected_step    interval NOT NULL,          -- 5/10/15 min
  staleness_limit  interval NOT NULL DEFAULT '3 hours',
  active boolean NOT NULL DEFAULT true,
  UNIQUE (station_id, quantity, provider_key)
);
CREATE TABLE reference_value (                 -- MNW/MW/MHW/HHW/NNW/HSW/PREWAAK/WAAK/ALARM/P10_DOY...
  series_id integer REFERENCES series, kind text, value real NOT NULL, unit text NOT NULL,
  valid_from date, period_start date, period_end date, source_batch integer,
  PRIMARY KEY (series_id, kind, valid_from));
CREATE TABLE ingest_batch (                    -- provenance for every row
  batch_id serial PRIMARY KEY, source text, url text, started_at timestamptz, http_status smallint,
  etag text, bytes integer, sha256 bytea, raw_object_key text, n_rows int, n_new int, n_changed int, error text);
CREATE TABLE obs (
  ts timestamptz NOT NULL, series_id integer NOT NULL, value real NOT NULL,
  batch_id integer NOT NULL, qc smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, ts)
) PARTITION BY RANGE (ts);                     -- monthly partitions, created 2 months ahead
CREATE INDEX ON obs USING brin (ts) WITH (pages_per_range = 32);
CREATE TABLE obs_1h (series_id int, bucket timestamptz, vmin real, vmax real, vavg real, vlast real,
                     n smallint, qc_or smallint, PRIMARY KEY (series_id, bucket));
CREATE TABLE obs_1d (LIKE obs_1h INCLUDING ALL);
CREATE TABLE obs_revision (series_id int, ts timestamptz, old_value real, new_value real,
                           old_qc smallint, new_qc smallint, batch_id int, changed_at timestamptz DEFAULT now());
```

- `real` (float4) is enough (110.849 m and 12,000.0 m³/s both fit). Keep the datum on the series, not the row.
- **Additional entities the country reports require:**
  - A station **cross-reference** table mapping provider codes (e.g. AGE 11 / SN 02610012 / WSV 26100130 / LfU 26260303) to one canonical station, with a preferred source per parameter.
  - Gauge zero with validity periods.
  - Thresholds with type, value, unit, source, fetch time and validity (0 = undefined for AGE).
  - **Forecast runs** modelled bi-temporally (issue or run time × valid time), with percentile columns (p0/p10/p25/p50/p75/p90/p100 as available) and a `below_floor` flag.
  - Alerts and warning sections with polygon or line geometry and `valid_from`/`valid_until`.
  - A per-source freshness table.
  - stack-landscape notes that PG18 `WITHOUT OVERLAPS` temporal constraints suit time-valid thresholds and station metadata.

### 6.4 Key queries

```sql
-- 1. Every station at time T (last obs at or before T within its staleness window) - measured 20 ms
PREPARE at_t(timestamptz, float8, float8, float8, float8) AS
SELECT s.series_id, o.ts, o.value, o.qc, $1 - o.ts AS age
FROM series s JOIN station st USING (station_id)
CROSS JOIN LATERAL (
  SELECT ts, value, qc FROM obs
  WHERE obs.series_id = s.series_id AND ts <= $1 AND ts > $1 - s.staleness_limit
  ORDER BY ts DESC LIMIT 1) o
WHERE s.active AND st.lon BETWEEN $2 AND $4 AND st.lat BETWEEN $3 AND $5;
-- For "now": keep obs_latest(series_id PK, ts, value, qc) updated during ingest.

-- 2. One station A..B at a suitable resolution (at most about 3,000 points)
SELECT ts, value, qc FROM obs WHERE series_id=$1 AND ts >= $2 AND ts < $3 ORDER BY ts;              -- span <= 14 d
SELECT bucket, vmin, vmax, vavg FROM obs_1h WHERE series_id=$1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket;  -- <= 180 d
SELECT bucket, vmin, vmax, vavg FROM obs_1d WHERE series_id=$1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket;  -- longer

-- 3. Incremental hourly rollup, touching only the (series, hour) pairs that the batch changed
INSERT INTO obs_1h (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
SELECT o.series_id, date_bin('1 hour', o.ts, timestamptz '2000-01-01Z') b,
       min(value), max(value), avg(value), (array_agg(value ORDER BY ts DESC))[1], count(*), bit_or(qc)
FROM obs o
JOIN (SELECT DISTINCT series_id, date_bin('1 hour', ts, timestamptz '2000-01-01Z') b FROM staging) t
  ON o.series_id = t.series_id AND o.ts >= t.b AND o.ts < t.b + interval '1 hour'
GROUP BY 1, 2
ON CONFLICT (series_id, bucket) DO UPDATE SET vmin=EXCLUDED.vmin, vmax=EXCLUDED.vmax, vavg=EXCLUDED.vavg,
  vlast=EXCLUDED.vlast, n=EXCLUDED.n, qc_or=EXCLUDED.qc_or;

-- TimescaleDB equivalent (TSL):
-- CREATE MATERIALIZED VIEW obs_1h WITH (timescaledb.continuous) AS SELECT series_id, time_bucket('1 hour', ts) bucket,
--   min(value), max(value), avg(value), last(value, ts) FROM obs GROUP BY 1,2;
-- SELECT add_continuous_aggregate_policy('obs_1h', start_offset => INTERVAL '40 days', end_offset => INTERVAL '10 min',
--   schedule_interval => INTERVAL '15 min');   -- a start offset of 40 days or more covers late revisions
```

- Idempotent upsert: `ON CONFLICT … DO UPDATE … WHERE (o.value,o.qc) IS DISTINCT FROM (EXCLUDED.value,EXCLUDED.qc)`. Write the old row to `obs_revision` first (CTE or trigger).
- **Animation frames:** query `obs_1h` for all series over the window (160 ms for 3,000 × 72), align missing buckets in application code, and send a compact array per series (370 KB gzip). Windows older than 48 h are nearly immutable, so cache them aggressively.
- **Maintenance:**
  - Create monthly partitions with cron or pg_partman (5.5.0; pg_cron 1.6.8).
  - After 12–24 months, optionally DETACH old partitions and export them to Parquet, keeping `obs_1h` and `obs_1d` in PG.
  - REINDEX closed partitions: B-tree fill is about 42 B/row after time-major inserts, and should drop to about 31 B/row after a rebuild (estimate).

### 6.5 Ingestion design

**Poll plan per source** (each respects the provider's cadence and fair use):

| Source | Call | Interval | Window / notes |
|---|---|---|---|
| NL-1 RWS | `OphalenWaarnemingen` per curated station × {WATHTE/NAP/meting, Q/meting}; 60–80 stations, 100–150 requests of about 5 KB | 10 min | `now−3h … now`. Send a stable `X-API-KEY`, and consider telling the RWS Servicedesk about the load |
| NL-1 forecasts | `verwachting` WATHTE (183) and Q (13), T−10 min … T+2 days | nl-rws: every 6 h (RWS says forecasts are recalculated "elke 6 uur", UNVERIFIED; **correction 2026-10-03 (P8a): RWS issues one run a day**, §2.1). [synth] Poll hourly and dedupe by content hash so no run is missed (P8a: a capture is a run without its leading values, so captures that are tails of a stored run are that run, A§7.4 item 9) | Store as runs keyed by our fetch time (P8a: by first valid time and content hash, the issue time inferred from the earliest capture) |
| NL-2 RWS WFS | CQL snapshot (about 235 KB) | 10 min | Discovery; REST wins |
| NL-1 catalogue | `OphalenCatalogus` | Daily | 1.6–4.8 MB |
| DE-1 PEGELONLINE | One `stations.json` basin call with ETag | 15 min at hh:02/:17/:32/:47 (datum-arch suggests 5 min with ETag) | Gap fill with `measurements.json?start=PT6H` hourly and after outages (up to `P30D`). Downsample 1-min series to 15 min |
| DE-2 WV | `/{uuid}/WV/measurements.json` × 7 | [synth] Hourly; dedupe on `initialized` | Latest run only |
| DE-1 metadata | stations + PNP + characteristic values | Daily | Log PNP and `validFrom` changes |
| DE-6 LHP | `/data/stations?states=NW,NI,RP,HE,BW,BY,SL` plus `/data/alerts` (the raw archiver of §0.1a takes all states) | ≥ every 10 min (terms) | `If-None-Match` → 304 [V] |
| DE-7 NRW | `messwerte.zip` (optionally `layers/10/index.json`) | 15 min | 7 days self-heal |
| DE-9 NLWKN | `station/{id}/datenspuren/parameter/1/tage/-1` × 4–6 | 15 min | Use `DatumUTC` |
| BE-1 HIC | Layer 156163 (non-tidal H) and 156170 (Q); tidal `getTimeseriesValues&ts_id=<~20 W ids>&period=PT2H` | 10–15 min | Token once per 24 h; re-fetch a 6–24 h window daily |
| BE-2 VMM | `getTimeseriesValues` in batches of ≤ 100 ts_ids, `returnfields=Timestamp,Absolute%20Value,Quality%20Code`, `period=PT2H`, `timezone=UTC` (or the layer with `valuecolumn=absolute`) | 15 min | |
| BE-3 SPW | Layers 1962373 + 1962340 | 10 min (the edge cache is 300 s, so more often is pointless) | Only if permitted |
| FR-1 Hub'Eau | Wildcard `observations_tr`, `date_debut_obs = now−3h` (datum-arch: `last − 2h`) | 10–15 min | Follow `next`; accept 206 |
| FR-4 Vigicrues forecasts | `prevision.json` national list, then per station | [synth] 15–60 min (event-driven) | |
| FR-5 Vigicrues vigilance | `InfoVigiCru.geojson` | 15–30 min | |
| FR-1 referential | `referentiel/stations?code_station=A*` (and B*, D*, E1*, E2*, E3*) `&size=10000` | Daily | Curated gauge-zero table |
| LU-1/LU-2 | CSV (always) + per-station JSON (once allowed) | 15 min, staggered (:07/:22/:37/:52) | Detect the CSV offset daily |
| LU-3 | 14 × 5 percentile files | Hourly at about :20 | Run ID = (station, first step) + content hash |
| LU-4 | Station pages | Weekly | Alert on change |
| LU-5 | data.public.lu v2 resources | 5 min | Filter `[AGE]`/`FLOOD` |
| CH-1 LINDAS | SPARQL (river + lake cubes) | 10 min, offset to about :04/:14/… (**never more often**) | |
| CH-2 | `hydro_sensor_pq.geojson` | 10 min | Thresholds and fault notices |
| CH-4 | 55 `q_forecast` files | Hourly | New run = new run start + `Last-Modified` |
| CH-5 | `hydro_warn_levels_{lang}.geojson` | 30–60 min | |
| CH-3 | `p_q_40days` for key stations | Once at first start | 40-day backfill |

**Poll loop rules**
- **Overlap window:** each poll re-fetches the last 2–6 h (3 h for RWS and Hub'Eau), and the upsert is idempotent.
- **Backoff:** exponential with full jitter (base 30 s, cap 30 min); honour `Retry-After`. After 5 consecutive failures, open a per-host circuit breaker with a 30-min probe. Limit concurrency to 2–4 per host.
- **Timeouts:** connect 10 s, total 60 s, metadata 120 s. KiWIS needs at least 60 s.
- **Conditional requests** (re-tested in the gap check): PEGELONLINE (ETag), data.geo.admin.ch / hydrodaten (`If-Modified-Since`/ETag), **HLNUG** (ETag and `If-Modified-Since` → 304), **NRW layer JSON** (`If-Modified-Since` → 304; no ETag) and **LHP** (ETag → 304 until `updated` ticks). Vigicrues `InfoVigiCru.geojson` and Hub'Eau send neither; for them and every other source, hash the body (for Vigicrues, compare `DtHrInfoVigiCru`) and skip it when unchanged.
- **Provenance:** the first production slice is the raw archiver of §0.1a, followed by the day-0 harvest of §0.1b. Store every response body zstd-compressed under `sha256` in object storage and link it from `ingest_batch`; every `obs` row carries a `batch_id`. Keep raw payloads for 30–90 days (datum-arch). Forecasts, thresholds and alerts are overwritten upstream, so keep those payloads (or their parsed runs) permanently (lu.md, ch-bafu). As a size reference, PEGELONLINE alone is about 57 KB × 288 polls per day, or about 6 GB/yr gzipped if every 5-min snapshot were kept.
- **Metadata refresh:** daily, versioned with `valid_from`.
- **One adapter per source** (fetch → archive raw → parse → normalise → upsert), each with a freshness metric and schema-drift alarms. A CAP parser (LU-Alert) is reusable for other countries' warnings.
- **Headers:** send a descriptive User-Agent with a contact address. opendata.swiss rejects the default curl UA, and OSM tiles require a unique UA.
- **Tests run offline** against recorded provider fixtures. A **nightly live contract-check job** polls each provider once and fails on schema drift (stack-landscape).
- **Health:** per-source and per-station freshness exposed at `/health` (and `/health/sources`) and as a metric. Alarm thresholds: RWS level over 60 min, Eijsden Q over 120 min, LU over 45 min.

### 6.6 Flood-spike caching (datum-arch §D.3, stack-landscape §10, ch-bafu)

- `/map?t=now` → `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
- `t` quantised to 10 min within 48 h → `s-maxage=600`.
- Older `t` → `s-maxage=86400, stale-while-revalidate=604800`; stack-landscape proposes `public, max-age=31536000, immutable` for past buckets. Purge on revisions, or accept up to a day of staleness.
- **Best:** the ingest worker writes precomputed JSON snapshot files per 10-minute tick, and the proxy serves them statically, so a spike costs almost no app CPU. A CDN in front is optional and adds a third-party dependency.
- Caddy 2.11.4 has **no built-in response cache**: `cache-handler` v0.17.0 (Souin) needs a custom xcaddy 0.4.7 build. nginx 1.30.5 has a built-in `proxy_cache` and a native ACME module (since Aug 2025).

### 6.7 Security baseline (datum-arch §D)

**Fetchers and SSRF**
- Build URLs only from a static per-source config; no user input reaches a fetcher.
- Allowlist hosts at the egress firewall or proxy. datum-arch lists `www.pegelonline.wsv.de`, `ddapi20-waterwebservices.rijkswaterstaat.nl`, `waterinfo.rws.nl`, `hubeau.eaufrance.fr`, `www.vigicrues.gouv.fr`, `hicws.vlaanderen.be`, `download.waterinfo.be` and `hydrometrie.wallonie.be`. **[synth] Extend it** with the first-release hosts from the other reports: `geo.rijkswaterstaat.nl`, `api.hochwasserzentralen.de`, `www.hochwasserportal.nrw`, `www.opengeodata.nrw.de`, `bis.azure-api.net`, `hicwsauth.vlaanderen.be`, `inondations.public.lu`, `data.public.lu`, `features.geoportail.lu`, `ld.admin.ch`, `www.hydrodaten.admin.ch` and `data.geo.admin.ch`.
- **[synth] Allowlist additions from the gap check:** `pegelonline.wsv.de` without `www` (HyDAS, the DE-5 form), `rijkswaterstaatdata.nl` (NL-4 file and page), **`download.data.public.lu`** (the LU-5 CAP files are served from there, not from `data.public.lu`), `vorhersage.bafg.de` (DE-3, later), and, once permitted, `www.hochwasser.rlp.de`, `www.hlnug.de`, `www.hvz.baden-wuerttemberg.de`.
- Handle redirects manually and follow them only to the same host (Vigicrues returns 302s legitimately, e.g. `/services/v1.1/TronEntVigiCru.json` → `/services/TronEntVigiCru.json`). Configure canonical URLs so no cross-host redirect is needed: `hicws.vlaanderen.be` (not the legacy `www.waterinfo.be/tsmhic/…`, which 302s to `waterinfo.vlaanderen.be`), `inondations.public.lu` (not `inondations.lu`), and the resource `url` of data.public.lu (not the `latest` redirect link).
- Reject private, loopback and link-local addresses after DNS resolution.
- Cap response size at 25 MB and cap the decompressed size (gzip bombs); keep the timeouts from §6.5. datum-arch sized this against a 2.2 MB largest payload, but other reports measured larger ones: the full RWS catalogue at 4.86 MB, the RLP `index` at 2.9 MB, and NRW `messwerte.zip` (909 KB) decompressing to 12.1 MB. The 25 MB cap still covers them.
- **Per-format rules** (corrects the earlier "accept JSON only"; first-release inputs also include CSV, ZIP, CAP XML, SPARQL CSV and XLSX) [synth]:
  - **JSON / GeoJSON:** size cap as above; strict per-provider schema; reject unknown units or datums.
  - **ZIP** (NRW `messwerte.zip` 0.9 MB → 12.1 MB; `pegeldaten.zip` 10.1 MB → **128 MB**; DE-5 later): read the central directory first; allow only the expected member names (no `/`, `..` or absolute paths; never extract to disk by name); cap the member count (≤ 10), each member's and the total uncompressed size (≤ 200 MB), and the compression ratio (≤ 50:1); stream members instead of extracting.
  - **XML** (LU-Alert CAP; largest of 833 files is 255 KB; none uses a DTD): parse with DTDs, external entities and entity expansion disabled (`defusedxml`, or `fast-xml-parser` with entity processing off); cap the size at 1 MB; reject any `<!DOCTYPE`.
  - **XLSX** (NL-4) is a ZIP of XML: apply both rule sets (openpyxl in read-only mode; the file is 495 KB and 6,245 rows) (built: fflate + fast-xml-parser under the guards of `apps/server/src/http/guards.ts`).
  - **CSV** (LU-1 wide format: 42 rows × about 484 columns, P5b: 675 since 2026-09-30; SPARQL CSV from CH-1; RLP CSV later): cap rows (≤ 100,000), columns (≤ 1,000) and field length (≤ 1 KB); declare the encoding per source (Latin-1 for BAFU history and NRW metadata, UTF-8 for NRW `pegeldaten.zip`).
  - **HTML scraping** (LU-4, only once permitted): extract only the `data-to-json` attribute; never execute scripts.

**Public API input validation (sketch)**
```python
T_MIN = datetime(2026, 11, 1, tzinfo=UTC)          # go-live (placeholder date used by datum-arch)
def parse_t(s: str) -> datetime:
    if len(s) > 32: raise Bad()
    t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if t.tzinfo is None: raise Bad("offset required")
    t = t.astimezone(UTC)
    if not (T_MIN <= t <= datetime.now(UTC) + timedelta(minutes=5)): raise Bad()
    return t - timedelta(minutes=t.minute % 10, seconds=t.second, microseconds=t.microsecond)  # quantise -> cache key
def parse_bbox(s: str):
    w, s_, e, n = (float(x) for x in s.split(",", 3))
    if not (-5 <= w < e <= 16 and 45 <= s_ < n <= 56): raise Bad()      # basin envelope
    if (e - w) * (n - s_) > 60: raise Bad("bbox too large")
    return round(w, 3), round(s_, 3), round(e, 3), round(n, 3)
MAX_SPAN = {"raw": timedelta(days=14), "1h": timedelta(days=366), "1d": timedelta(days=3660)}
```
- **[synth] Adjust `T_MIN`/`t` bounds for forecasts:** the product lets the slider go into the near future (up to about 34 h for RWS, 96 h for BfG and 115 h for BAFU).
- Series IDs must be integers, at most 50 per request, with at most 20k rows per response. Queries use parameters only.
- DB role for the web tier:
```sql
CREATE ROLE web LOGIN;
GRANT SELECT ON ... TO web;
ALTER ROLE web SET default_transaction_read_only = on;
ALTER ROLE web SET statement_timeout = '2s';
```
  Put pgbouncer in front (pool about 20). The ingest role is separate and never reachable from the web tier.
- **Rate limiting** (nginx example): `limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s; limit_req zone=api burst=40 nodelay; limit_conn perip 20;`. Return 429 with `Retry-After`.

**CSP for the map page**
```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data: blob: https://tiles.example.org; connect-src 'self' https://tiles.example.org;
  worker-src 'self' blob:; child-src blob:; font-src 'self'; object-src 'none'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```
- MapLibre docs require `worker-src 'self'` and `img-src data: blob: 'self'`. If `blob:` workers are disallowed, set the worker URL to a same-origin file.
- Whether `style-src 'self'` works without `'unsafe-inline'` is UNVERIFIED, as is the v6 worker set-up (the CSP bundle was removed; §8 C23).
- Self-host maplibre-gl, with no third-party script CDN (or use SRI). Keep the Referer.

**Supply chain and secrets**
- Lockfiles; `npm ci --ignore-scripts` / pnpm `--frozen-lockfile`; `pip install --require-hashes`.
- Renovate with `minimumReleaseAge` ≥ 3 days (stack-landscape suggests 3–7 days); `npm audit signatures`.
- Pin actions to commit SHAs and images to digests; use distroless or minimal images.
- SBOM via syft; Dependabot or OSV alerts. Keep front-end dependencies few.
- Secrets: HIC and VMM tokens (register early), DB credentials and any CDN purge token. Keep them in env injection or a secret manager, never in the repo. Rotate them and scope them per service. **PEGELONLINE, RWS, Hub'Eau, Vigicrues, Wallonia, LINDAS, LHP and NRW need no key.** The NLWKN key is public, but keep it in config anyway.
- Container baseline: non-root `USER`, `read_only: true`, `cap_drop: [ALL]`, `security_opt: no-new-privileges`, and an internal network for Postgres with no published port. Rootless Docker/Podman complicates binding ports 80/443 (it needs `net.ipv4.ip_unprivileged_port_start`).

---

## 7. Tech-stack landscape facts (as of 2026-09-23; stack-landscape unless noted)

Versions were checked live against the registries (npm, PyPI, Go proxy, crates.io), `git ls-remote --tags`, Docker Hub, gcr.io/distroless, cgr.dev, dhi.io, nodejs.org `dist/index.json` + `schedule.json`, python.org, go.dev and the postgresql.org versioning page. **[L]** = verified live, **[D]** = vendor doc, **[U]** = unverified (secondary source). Disclosure: Bun is owned by Anthropic.

### 7.1 Recent changes that trip up 2025-era knowledge
1. **TypeScript 7.0 went stable on 2026-07-08** [L]. It is the Go-native `tsc`, shipped as per-platform binaries in the `typescript` package. It has **no stable programmatic API** (expected in 7.1 [U]). Tools that still need TS ≤ 6: `typescript-eslint` 8.70.1 (TS `>=4.8.4 <6.1.0`), `svelte-check` 4.7.6 and `@astrojs/check` (`^5 || ^6`), and `@sveltejs/kit` (peer `^5.3.3 || ^6.0.0`). **TypeScript 6.0.3 is the safe baseline.**
2. **Node.js** [L]:
   - Node 26.10.0 (2026-09-21) is Current. It becomes **LTS on 2026-10-28**, EOL 2029-04-30. `Temporal` is on by default, `.ts` files run through type-stripping, and V8 is 14.6.
   - Node 24.21.0 "Krypton" is Active LTS until 2026-10-20, then maintenance until 2028-04-30.
   - Node 22.23.3 "Jod" reaches EOL 2027-04-30. Node 20 reached EOL 2026-04-30.
   - From Node 27, there will be one major per year and every release becomes LTS; Node 27 alpha starts 2026-10-28.
3. Vite 8 (2026-03-12) uses Rolldown as its only bundler. Vitest 5.0 (2026-09-03) needs Node ≥ 22.12 and Vite ≥ 6.4; `clearMocks` now defaults to true, and unawaited async assertions fail.
4. **MapLibre GL JS 6** (2026-07-22): see §5.2.
5. Bun 1.4 (2026-08-20; 1.4.2 current) is the first release of the Zig → Rust rewrite and is "not 100% compatible with Node.js yet" [D].
6. **Framework churn:**
   - SolidStart 2.0 (2026-08-04) went into **maintenance mode** [U]; Solid 2.0 is at RC.
   - SvelteKit 3 has been RC since 2026-08-13 (`3.0.0-next.27`).
   - Astro 7 (2026-06-22). NestJS 12 (2026-08-27, ESM-only [U]). React Router 8 (2026-06-17).
   - Fastify 6 is at alpha.4. Drizzle 1.0 is at `rc.4` (stable 0.45.3).
   - TypeBox 1.x moved to the `typebox` package name and is ESM-only.
7. **Python:**
   - 3.14.7 (2026-08-05) and 3.13.15 are current; **3.15.0 is due 2026-10-01**; 3.10 reaches EOL 2026-10.
   - `httpx` has had no release since 0.28.1 (2024-12) and its tracker is closed [U]; the Pydantic-stewarded **`httpx2` 2.13.1** exists on PyPI.
   - APScheduler 4 is still alpha (3.11.3 is stable). Litestar 3 is unreleased.
8. **PostgreSQL 18.6** is current (supported to 2030-11-14); PG 19 is at Beta 3 (with `REL_19_BETA4` tagged). **TimescaleDB 2.30.1** (2026-09-17) supports PG 16/17/18 and dropped PG15 in 2.29.0. PG18 support arrived in TimescaleDB 2.23.0, about 5 weeks after PG18 GA. **The official `postgres:18` image moved `PGDATA` to `/var/lib/postgresql/18/docker` and the `VOLUME` to `/var/lib/postgresql`**, which matters for compose files.
9. **Supply-chain incidents** [U]:
   - The Trivy / trivy-action compromise on 2026-03-19 (76 of 77 action tags force-pushed; GHSA-69fq-xp46-6x23).
   - An npm worm in August 2026 ("ChainDrop"/Shai-Hulud) hit keyv, cacheable and about 440 other packages.
   - npm classic tokens were revoked on 2025-12-09.
   - pnpm 11+ has secure defaults; Dependabot has `cooldown`; Renovate's `config:best-practices` waits 3 days; uv has `exclude-newer = "7 days"`.
   - GitHub can enforce full-SHA pinning of actions [D, 2025-08-15].
10. **Containers and ops:**
    - Docker Hardened Images have been free (Apache-2.0) since 2025-12-17 [U]; `dhi.io` returns 401 without login.
    - Bitnami's free catalog moved to `bitnamilegacy` [U]. **Watchtower was archived on 2025-12-17** [U].
    - **Docker Compose is v5 (v5.5.1)** [L].
    - pgBackRest was archived in April 2026, then revived; 2.59.1 is the latest tag.
    - Let's Encrypt: 45-day certificates are opt-in since 2026-05-13; the default becomes 64 days from 2027-02-10 and 45 days from 2028-02-16 [U].

### 7.2 Runtimes

| Runtime | Current | Status | Licence |
|---|---|---|---|
| Node.js 26 | 26.10.0 | Current → LTS 2026-10-28, EOL 2029-04-30 | MIT |
| Node.js 24 | 24.21.0 | Active LTS → 2026-10-20; EOL 2028-04-30 | MIT |
| Node.js 22 | 22.23.3 | Maintenance; EOL 2027-04-30 | MIT |
| Bun | 1.4.2 | Rust port; not fully Node-compatible | MIT [U] |
| Deno | 2.9.7 tag (npm 2.9.6; 2.9.0 on 2026-06-25) | Stable 2.x; its per-host `--allow-net` sandbox is attractive for an ingest worker | MIT [U] |
| Python | 3.14.7; 3.13.15 | 3.14 bugfix to 2030-10 | PSF |
| Go | 1.27.1 / 1.26.8 | 1.27 (Aug 2026): generic methods, `encoding/json` backed by v2, a `uuid` package | BSD-3 |
| Rust | 1.98.1 (manifest 2026-09-03) | axum 0.8.9, tokio 1.53.1, sqlx 0.9.0, reqwest 0.13.5 | MIT/Apache |

Useful ingest libraries: `fast-xml-parser` 5.11.1, `csv-parse` 7.0.2, `proj4` 2.22.0 (EPSG:28992 RD New, Belgian Lambert, Swiss LV95 EPSG:2056 → WGS84), `lxml` 6.1.3, polars 1.44.2, pyproj 3.8.0.

### 7.3 API frameworks

| Framework | Version | Notes | Licence |
|---|---|---|---|
| **Hono** | 4.13.8; `@hono/node-server` 2.1.1 | `@hono/standard-validator` 0.4.0, `hono-openapi` 1.3.3, `@hono/zod-openapi` 1.6.3 (zod ^4); typed RPC client; no major pending | MIT |
| Fastify | 5.12.5 (6.0.0-alpha.4) | `@fastify/type-provider-typebox` 6.1.0 (typebox ^1), `fastify-type-provider-zod` 7.0.0, swagger 9.9, rate-limit 11.2; v6 migration likely in 2027 | MIT |
| Express | 5.2.1 (4.22.3) | No advantage here | MIT |
| NestJS | 12.1.0 | Overkill | MIT |
| FastAPI | 0.141.1 (Starlette 1.7.0, Pydantic ≥ 2.9) | De-facto Python standard | MIT |
| Litestar | 2.24.0 | 3.0 unreleased | MIT |
| Go `net/http` / chi / echo / huma | Go 1.27 / v5.3.2 / v5.3.1 (v5.0.0 2026-01-18; v4.15.4) / v2.39.1 | | BSD-3 / MIT / MIT / MIT [U] |

### 7.4 Frontend

| Option | Versions | Map binding | Notes |
|---|---|---|---|
| **React 19.3 + Vite 8.3** | react 19.3.0 (2026-09-09), vite 8.3.0, `@vitejs/plugin-react` 6.1.1 | `@vis.gl/react-maplibre` 8.1.3 (peer maplibre-gl ≥ 4; ML6 fix reported [U]) | Largest ecosystem; TanStack Router 1.170.39 for typed `?t=…&station=…`; React Router 8.4.0 |
| SvelteKit 2 / Svelte 5 | kit 2.70.3 (3.0 RC), svelte 5.57.1 | `svelte-maplibre-gl` 2.2.1 (`^5.19 \|\| ^6`) | Smaller bundles; Paraglide add-on; `svelte-check` locks TS ≤ 6 |
| SolidStart 2 | 2.0.5; solid-js 1.9.15 (2.0 rc.9) | `solid-map-gl` 2.2.4 | Maintenance mode: avoid |
| Vue 3 / Nuxt 4 | vue 3.5.43 (3.6 rc.9), nuxt 4.5.2 | **`vue-maplibre-gl` 5.6.1 peers `^5.17` only (no v6)** | Friction on the map layer |
| Astro 7 | 7.3.4, Node ≥ 22.12 | Via islands | Only for static pages |

- **Data fetching:** `@tanstack/react-query` 5.103.2; `@tanstack/svelte-query` 6.2.4.
- **Charts:**
  - **Apache ECharts 6.1.0** (2026-05-19, Apache-2.0) is the best fit for hydrographs (`markLine` thresholds, `markArea` bands, forecast ranges, `dataZoom`).
  - uPlot 1.6.32 (2025-03-14, MIT) is the smallest and fastest.
  - Observable Plot 0.6.17 (ISC). Chart.js 4.5.1 (MIT).
- **i18n:** `@inlang/paraglide-js` 2.25.4 (compile-time, typed), or `i18next` 26.4.2 + `react-i18next` 17.0.15.
- **Dates:** Safari lacks `Temporal` (Technology Preview only); Chrome, Edge 144+ and Firefox 139+ ship it [U]. Use `temporal-polyfill` 1.0.5, or `date-fns` 4.4.0 + `@date-fns/tz` 1.5.0.
- **Tooling:** tailwindcss 4.3.3, Biome 2.5.14, oxlint 1.85.0, ESLint 10.11.0, Prettier 3.9.9.

### 7.5 Map, database and tiles tooling

- **Map:** MapLibre 6.11.1 (BSD-3); deck.gl 9.4.0 (MIT; stack-landscape calls it overkill for 2–3k points); pmtiles 4.5.0; go-pmtiles 1.31.2; planetiler 0.10.2 (Apache-2.0); tilemaker 3.2.0 (FTWPL); tippecanoe (felt) 2.79.0 (BSD-2; for our own overlays as PMTiles); martin 1.16.1 (MIT/Apache; not needed if Caddy serves static PMTiles); versatiles-rs 4.15.0.
- **Database:**
  - PostgreSQL 18.6 (async I/O, `uuidv7()`, virtual generated columns, **temporal `WITHOUT OVERLAPS`**, B-tree skip scan, checksums on by default [D]); 17.11 (supported to 2029-11-08).
  - TimescaleDB images: `timescale/timescaledb:2.30.1-pg18` (about 366 MB amd64; the default tag is the Community build with TSL, `-oss` is Apache-only) and `timescale/timescaledb-ha:pg18` (Ubuntu, about 666 MB, **includes PostGIS**).
  - PostGIS 3.6.4 (`postgis/postgis:18-3.6(-alpine)`, GPL-2.0 [U]); "probably not needed" per stack-landscape.
  - ClickHouse 26.8 LTS / 26.9; QuestDB 10.0.1 (both overkill).
  - TimescaleDB costs one extra ops step: `ALTER EXTENSION timescaledb UPDATE` after each image bump.
- **Migrations and access:**
  - **dbmate 2.36.0** (MIT; plain SQL; handles Timescale DDL); sqitch; node-pg-migrate 9.0.0.
  - **Kysely 0.29.6** (Node ≥ 22) + `kysely-codegen` 0.20.0; Drizzle ORM 0.45.3 / drizzle-kit 0.31.11 (its generator does not understand hypertables).
  - Go: sqlc 1.31.1, goose 3.28.0, golang-migrate 4.20.1, pgx v5.11.0.
  - Python: Alembic 1.20.0 + SQLAlchemy 2.0.54 (2.1 rc2); psycopg 3.3.6 (LGPL-3.0); asyncpg 0.31.0.
- **Backups:** nightly `pg_dump` + `restic` 0.19.1 offsite; or WAL-G 3.0.9 / pgBackRest 2.59.1 for PITR (pgBackRest status was in flux in April–May 2026 [U]).

### 7.6 Scheduling, validation, testing

- **Scheduling:**
  - croner 10.0.1 (MIT) / node-cron 4.6.0 (ISC): the simplest option; add a Postgres advisory lock per source.
  - **pg-boss 12.34.0** (MIT, Node ≥ 22.12): Postgres-backed cron/RRULE, retries with backoff, dead-letter queues, throttling and singletons; also covers the backfill phase.
  - graphile-worker 0.18.0 (Node ≥ 22.18); supercronic 0.2.49.
  - Temporal server 1.32.0 / TS SDK 1.24.0 is overkill.
  - Python: APScheduler 3.11.3 / Procrastinate 3.9.0. Go: River 0.47.0 (MPL-2.0) / gocron v2.22.0.
- **Validation:** Zod 4.6.5 (Standard Schema, JSON Schema export); Valibot 1.5.0; `typebox` 1.3.34 (`@sinclair/typebox` 0.34.52 is legacy); ArkType 2.2.3; Standard Schema 1.1.0; Pydantic 2.13.5 (+ pydantic-settings 2.15.0). Write **one strict schema per provider response**, then map it to canonical `Observation` / `Forecast` / `Threshold` types.
- **Testing:**
  - Vitest 5.0.1; Playwright 1.63.0 (Apache-2.0); msw 2.15.0; nock 14.0.17 (recorder with native fetch UNVERIFIED).
  - pytest 9.1.1 / pytest-asyncio 1.4.0; VCR.py 8.3.0 / pytest-recording 0.13.4 / respx 0.23.1 (`httpx2` compatibility UNVERIFIED); go-vcr v4.0.7.
  - testcontainers: Node 12.1.0, Go 0.44.0, Python 4.15.0.

### 7.7 Proxy, containers, CI and observability

- **Reverse proxy:** **Caddy 2.11.4** (Apache-2.0; `caddy:2.11.4-alpine`; automatic HTTPS, HTTP/3, zstd, `file_server` with Range for PMTiles; no built-in cache). Traefik 3.7.13 (MIT). nginx 1.30.5 stable / 1.31.6 mainline.
- **Containers:** Docker CLI 29.8.1; Compose **v5.5.1** (init containers, `pull_policy` refresh windows [U]); Podman 6.1.2. Distroless `gcr.io/distroless/{nodejs24,nodejs26,python3,static,base}-debian13` (`:nonroot`/`:debug`). Chainguard free images show only `latest`/`latest-dev` (pin by digest).
- **CI action majors** [L tags]:
  - Core: `actions/checkout` v7; `setup-node`/`setup-python`/`setup-go` v7; `actions/cache` v6; `upload-artifact` v7; `attest-build-provenance`/`attest` v4.2.2.
  - Docker: `docker/build-push-action` v7.4.0; `login-action` v4.6.0; `setup-buildx-action` v4.4.1; `metadata-action` v6.2.0.
  - Security: `github/codeql-action` v4.38.1; `step-security/harden-runner` v2.21.1; `zizmorcore/zizmor` v1.30.1; `ossf/scorecard-action` v2.4.4; `anchore/sbom-action` v0.24.2; `aquasecurity/trivy-action` v0.36.0; `gitleaks/gitleaks-action` v3.0.0 (Node 24; a licence key is needed only for org-owned repos); `sigstore/cosign-installer` v4.1.2.
  - Toolchains: `pnpm/action-setup` v6.1.0; `astral-sh/setup-uv` v10.2.0.
  - GitHub is removing Node 20 from runners (date UNVERIFIED).
- **Scanners:** Trivy 0.74.0, Grype 0.119.0 and Syft 1.52.0 (Apache-2.0); gitleaks 8.30.1; Renovate CLI 44.111.3 (AGPL-3.0; the Mend app is free [U]); CodeQL is free on public repos (private repos cost about $30 per committer per month [U]). **After the March 2026 compromise, pin Trivy to a reviewed SHA, or use Grype/Syft.**
- **CI baseline:**
  - SHA-pinned actions (Renovate `helpers:pinGitHubActionDigests`); top-level `permissions: {}`; zizmor; harden-runner in audit mode.
  - GHCR with `GITHUB_TOKEN`; buildx `provenance: mode=max` + `sbom: true`.
  - **cosign keyless signing via GitHub OIDC**, and `cosign verify` on the VPS before `docker compose pull && up -d`.
  - Deploy through a `command=`-restricted SSH key, or pull-based via a systemd timer.
  - pnpm 12.6.0 (12.0 on 2026-08-26): raise `minimumReleaseAge` to 3–7 days, list `allowBuilds`, use `--frozen-lockfile`. npm 12.1.0 has `min-release-age` [U feature].
- **Observability:**
  - **Uptime Kuma 2.5.5** (MIT); **healthchecks.io** v4.4 (free hosted tier: 20 checks); **GlitchTip** 6.2.6 (MIT, 256–512 MB RAM; Sentry JS SDK 11.0.0 compatibility UNVERIFIED).
  - Prometheus 3.14.0 + Grafana 13.2.2 (AGPL-3.0; about 0.5–1 GB RAM [U]); VictoriaMetrics 1.152.0; Loki 3.7.8 / Alloy 1.19.2.
  - node_exporter 1.12.1, postgres_exporter 0.20.1, blackbox 0.28.0.
  - pino 10.3.1 / structlog 26.1.0 / Go `slog`; prom-client 15.1.3; `@opentelemetry/sdk-node` 0.222.0.
  - Sentry self-hosted 26.9.0 (FSL-1.1-Apache-2.0) needs **at least 4 cores, 16 GB RAM and 16 GB swap**, which is too heavy.
  - The most valuable signal is **per-source data freshness**.
- **VPS sizing estimate [U]:** 4 vCPU, 8 GB RAM, ≥ 160 GB NVMe (Postgres about 2 GB `shared_buffers`, the API and worker about 100–200 MB each for Node, Caddy, GlitchTip about 512 MB, Uptime Kuma, and an 8.2 GB PMTiles file). Go to 16 GB if Prometheus and Grafana are added.

### 7.8 Candidate stacks (stack-landscape)

| Criterion | A: TypeScript monorepo (recommended default) | B: Python services + TS SPA | C: Go services + TS SPA (documented fallback) |
|---|---|---|---|
| Composition | Node 26, pnpm 12 workspaces (`apps/{ingest,api,web}`, `packages/{schemas,db}`), TS 6.0.3 strict; ingest with fetch/undici + p-retry/p-limit + fast-xml-parser/csv-parse + proj4 + Zod 4 + pg-boss 12; PG 18 + TimescaleDB 2.30, Kysely 0.29 + kysely-codegen, dbmate; Hono 4.13 (or Fastify 5.12); React 19.3 + Vite 8.3 + TanStack Router/Query + MapLibre 6.11 + pmtiles + ECharts 6 (or uPlot) + Paraglide 2 + temporal-polyfill; Vitest 5, msw 2, testcontainers 12, Playwright 1.63; pino 10, GlitchTip, Caddy 2.11; built on `node:26-trixie-slim`, run on `gcr.io/distroless/nodejs26-debian13:nonroot`, pinned by digest | Python 3.14 + uv 0.12.18 + ruff 0.16.8 + mypy 2.3.1 or pyright 1.1.414 (`ty` 0.0.83 is pre-1.0); FastAPI 0.141 + Pydantic 2.13 + Granian 2.8 or Uvicorn 0.53; SQLAlchemy 2.0 Core or psycopg 3.3 + Alembic 1.20; httpx2 2.13 or niquests 3.21 / aiohttp 3.14; Procrastinate 3.9 or APScheduler 3.11; structlog 26; pytest 9 + VCR.py 8; frontend as A via `openapi-typescript` 7.13 + `openapi-fetch` 0.17 | Go 1.27 + stdlib (or chi v5.3) + huma v2; pgx v5.11 + sqlc 1.31 + goose/dbmate; River 0.47 or gocron v2; `slog`; go-vcr v4 + testcontainers-go; `distroless/static-debian13`; frontend as A |
| Languages / toolchains | **1** | 2 | 2 |
| End-to-end typing | **Strongest** | Medium | Strong |
| Provider-parsing ergonomics | Good | **Best** | OK |
| Record-and-replay testing | Good | **Best** | Good |
| Runtime footprint | Medium | Medium | **Lowest** |
| Agent familiarity | **Highest** | High | High |
| Supply-chain surface | Largest (npm) | Medium | **Smallest** |
| 12-month churn risk | Medium-high | Medium | **Low** |
| Backfill / analysis fit | Good | **Best** | Good |

- **Svelte variant (A-S):** SvelteKit 2 adapter-static SPA + Svelte 5 + `svelte-maplibre-gl` 2.2 + svelte-query 6. The price is an imminent SvelteKit 3 migration and TS pinned to ≤ 6.
- **Pins proposed by stack-landscape:** Node 26.x (24.x until 2026-10-28 if LTS is required from day one), pnpm 12.6, TypeScript 6.0.3; Hono 4.13, Zod 4.6, Kysely 0.29, dbmate 2.36, pg-boss 12.34; React 19.3, Vite 8.3, TanStack Router 1.170 / Query 5.103, MapLibre GL JS 6.11, pmtiles 4.5, ECharts 6.1 (or uPlot 1.6.32), Paraglide 2.25; Vitest 5.0, Playwright 1.63, msw 2.15, testcontainers 12.1; PostgreSQL 18.6 + TimescaleDB 2.30.1 (`timescale/timescaledb:2.30.1-pg18`); Caddy 2.11.4, distroless `nodejs26-debian13:nonroot`, Docker Compose v5.
- **Agent-specific guidance:**
  - Put a `CLAUDE.md` "bill of materials" in the repo with pinned versions and migration-guide links (MapLibre 6 ESM/WebGL2; the PG18 `PGDATA` path; TS 7 tooling limits; the TypeBox rename; Vitest 5 defaults).
  - Pin exact versions and prefer low-churn libraries (Kysely over the Drizzle RC; Hono or Fastify 5 over NestJS 12).
  - Run tests offline against fixtures, with a nightly live contract check.
  - Add a SessionStart hook so cloud agent sessions have dependencies installed.
- **Scheduled re-checks:**
  - 2026-10-28: Node 26 LTS.
  - TS 7.1 with a stable API plus support in typescript-eslint and svelte-check.
  - SvelteKit 3 GA (if the Svelte variant is chosen); Fastify 6 GA (if Fastify); Drizzle 1.0 GA.
  - PG 19 GA: wait for TimescaleDB support, and not before 2027.
  - Safari Temporal (then drop the polyfill).
  - Ongoing supply-chain incidents.

---

## 8. Contradictions between reports

Each item is marked **Resolved** (with the evidence) or **Flagged** (needs a decision or a check).

| # | Topic | Report A says | Report B says | Status |
|---|---|---|---|---|
| C1 | Flood travel time to Lobith (the same RWS 1985 note) | map-rivers: Andernach 28–48 h (≈39 h), Köln 22–46 h (≈30 h) | ch-bafu: Andernach 28–49 h; Köln about 22–40 h | **Flagged (minor).** Both cite GWIO 85.006, appendix 1. Re-read the PDF (`scratchpad/gwio85006.pdf`) before quoting exact bounds. Use "about 1.5 days (28–49 h)" for Andernach in the UI |
| C2 | Basel → Lobith total | ch-bafu: composite "about 3–4 days" (UNVERIFIED) | map-rivers: Maxau → Lobith about 4–5 days (derived from the 1999 floods) plus IKSR Basel → Maxau 23 h, i.e. about 5–6 days. A secondary source says "Upper Rhine water about 5 days to Lobith"; a blog says "6 days" | **Flagged.** No primary source covers the whole path. Show segment anchors only, and calibrate from our own data |
| C3 | PEGELONLINE absolute-unit series | de-pegelonline: 683 cm series, **54** in `m+NN`, 2 `m+PNP` | datum-arch: 668 relative, **67** in `m+NN`, 2 `m+PNP` | **Flagged (immaterial).** The two probably counted different timeseries sets. The design rule is the same either way: branch on `unit` per series. Both agree 95 series have no gauge zero |
| C4 | PEGELONLINE latency | de-pegelonline: value available about 2 min after its timestamp (Emmerich 22:00 was in by 22:02:13) | datum-arch: "~12 min" observed lag | **Resolved.** de-pegelonline measured availability; datum-arch measured value age at poll time (15-min step + poll phase). Poll at hh:02/:17/:32/:47 |
| C5 | RWS REST latency | nl-rws: about 20 min | datum-arch: about 14 min | **Resolved as a range.** Design for 20–30 min, plus 75 min for Eijsden Q |
| C6 | RWS datum-variant counts | nl-rws: TAW 8, MSL 17, PLAATSLR 22 (per F007/method row) | datum-arch: NAP 690, TAW 8, MSL 18, PLAATSLR 23 locations | **Resolved (method of counting).** Immaterial |
| C7 | Lobith duplicate | datum-arch: PEGELONLINE LOBITH (51.8498 N, 6.1124 E) read 627 cm, while RWS `lobith.bovenrijn.haven` read 615 cm NAP; "different physical gauges about 2 km apart" | nl-rws: RWS `lobith.bovenrijn.tolkamer` (51.8495, 6.1024) read 627–628 cm NAP; de-pegelonline: PEGELONLINE Lobith read 628 | **Largely resolved.** The PEGELONLINE LOBITH values match RWS **Tolkamer**, not Haven. The datum-arch comparison used the wrong RWS gauge. The coordinates still differ (6.1124 vs 6.1024) and the datum is still UNVERIFIED. Regardless, take Lobith from RWS (all reports agree) |
| C8 | VMM history depth | be-flanders: 15-min since 1973 (Sint-Joris-Weert) | datum-arch: "since 2023 for the sampled stations" | **Resolved.** Depth varies by station; read the `coverage` from/to per series |
| C9 | Wallonia history | be-wallonia-lu: from 1969 (Tabreux Q), levels 1976–1977 | datum-arch: "since 1976" | **Resolved:** consistent subsets |
| C10 | Hub'Eau licence | datum-arch: "presumably Etalab 2.0 – UNVERIFIED" | fr-hubeau-vigicrues: CGU verified (Licence Ouverte Etalab; data.gouv.fr "Licence Ouverte 2.0") | **Resolved:** Licence Ouverte / Etalab 2.0 |
| C11 | Flemish licences | datum-arch: "specific licence text not found – UNVERIFIED" | be-flanders: VMM Modellicentie Gratis Hergebruik v1.0 (verified); HIC disclaimer and acknowledgement text (verified) | **Resolved** in favour of be-flanders |
| C12 | Wallonia licence scope | datum-arch: "commercial or advertising use needs prior authorisation" | be-wallonia-lu quotes the mentions légales: **any** provision to third parties or the public (website, webservice) needs prior written consent. Metawal: no publishing via a web service. Third-party "CC BY 4.0" claims were not found on official pages | **Resolved: the stricter reading applies.** Written permission is needed even for non-commercial use |
| C13 | Vigicrues vigilance URL | fr: `https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson` (the `/services/1/…` path redirects here) | datum-arch: `https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson` | **Resolved:** both work via a same-host 302. Configure the canonical `/services/InfoVigiCru.geojson` and allow same-host redirects |
| C14 | LU CSV timing | be-wallonia-lu: latency "about 10 minutes"; no label offset reported | lu.md: latency 11–25 min; **CSV labels are 15 min late** (479/480 and 94/94 matches) | **Resolved in favour of lu.md** (more detailed evidence). Detect the offset daily (P5b: **the lag ended with a format change.** Against DE-1 Perl the old 5-day file matched at −15 minutes (96 of 96) and the 7-day file since 2026-09-30 at 0 (96 of 96); the default is now 0 and the detector measures the rest) |
| C15 | LU CSV time zone history | INSPIRE metadata: "UTC+1 all year" | data.public.lu note (09/2026): local time only now | **Resolved:** the INSPIRE record is out of date |
| C16 | Storage engine for the MVP | datum-arch: plain PostgreSQL (partitions + BRIN + hand-rolled rollups); TimescaleDB later (year 2–3). Benchmarked 16–20 ms | stack-landscape: PG 18.6 + TimescaleDB 2.30.1 from Phase 0 (continuous aggregates, gapfill/locf, compression). ch-bafu and lu.md: PG 16/17 + TimescaleDB + PostGIS | **Flagged: an architecture decision.** Facts: both work at this scale; TSL features are free to self-host; PG18 changed the image `PGDATA` path; TimescaleDB adds an `ALTER EXTENSION` step per upgrade |
| C17 | PostGIS | ch-bafu, lu.md: include PostGIS | stack-landscape: "probably not needed" (static geometry / PMTiles) | **Flagged: a decision.** `timescaledb-ha:pg18` bundles PostGIS if wanted |
| C18 | Implementation language | lu.md: Python 3.13 (httpx, pydantic v2, lxml, APScheduler) + FastAPI; ch-bafu: Python 3.12 (httpx, tenacity, pydantic) + FastAPI | stack-landscape: TypeScript monorepo (Node 26) by default; Go as fallback. Notes httpx is unmaintained since 0.28.1 [U] (use httpx2) and APScheduler 4 is alpha | **Flagged: a decision.** Version facts come from stack-landscape (the dedicated, live-checked report). Python 3.12/3.13 are older than the current 3.14.7 |
| C19 | deck.gl | map-rivers: add deck.gl 9.4 (`MapboxOverlay`) for animation phases | stack-landscape: "overkill for about 2–3k station points" | **Resolved:** not needed for the MVP station layer (both agree MapLibre `circle` + `feature-state` is enough). Consider it later for animated river paths. MapLibre v6 interop is UNVERIFIED |
| C20 | Reverse proxy / caching | datum-arch: nginx `limit_req` example; CDN for spikes | stack-landscape: Caddy 2.11.4 (no built-in cache; Souin needs xcaddy) + precomputed static snapshot files. lu.md and ch-bafu: Caddy | **Flagged: a decision.** Facts are in §6.6 |
| C21 | Response-size cap basis | datum-arch: largest payload about 2.2 MB | nl-rws: catalogue 4.86 MB; de-states: RLP index 2.9 MB, NRW zip → 12.1 MB decompressed | **Resolved:** the 25 MB cap still holds, but size the decompression guard for at least 12.1 MB |
| C22 | Kaub reference-value names | map-rivers: "NW 25, MW 208, HSW 640, HW 719, GlW 77, M_I 460" | de-pegelonline: the shortnames are GlW, TuGLW, M_I, M_II, HHW, NNW, MNW, MW, MHW, HSW; Kaub MNW/MW/MHW/HSW = 65/208/544/640 | **Resolved (P7a, 2026-10-03).** "NW" and "HW" **are** PEGELONLINE shortnames, and they are not NNW and HHW. The recorded `de-1-meta` (2026-09-29; the owner's export of 2026-10-03 is equal) states for Kaub `NW` 25 ("Niedrigster Tageswasserstand", `timespanStart` 2010-11-01, `timespanEnd` 2020-10-31, occurrence 2018-10-22) and `HW` 719 ("Höchster Momentanwasserstand", occurrence 2013-06-05); `HHW` is 825 (1883). MNW/MW/MHW/HSW = 65/208/544/640 are confirmed. P7a stores `NW` and `HW` as historical references with their period and never classifies on them |
| C23 | MapLibre CSP | datum-arch: follow MapLibre docs (`worker-src 'self' blob:`; set a same-origin worker URL if blob is disallowed) | stack-landscape: v6 **removed the CSP bundle** | **Flagged.** Verify the CSP set-up against v6 in staging |
| C24 | Storage volume | datum-arch: worst case about 23 GB/yr plain PG (4,000 series @ 10 min) | stack-landscape: 8–20 GB/yr plain PG [U] | **Resolved:** the same order of magnitude |
| C25 | TAW sign | be-flanders: "0 m TAW ≈ NAP −2.33 m" (general knowledge, UNVERIFIED); be-wallonia-lu: DNG about 2.3 m below NAP | datum-arch and nl-rws: H_TAW = H_NAP + 2.33 m (live pairs at 3 stations) | **Resolved:** all consistent, and now verified live |
| C26 | NHN vs NAP | de-pegelonline: offset UNVERIFIED | datum-arch: PROJ gives 0.5–2 cm | **Resolved for display** (negligible). Not yet confirmed at a shared gauge |
| C27 | Swiss datum | datum-arch: Swiss offsets UNVERIFIED | ch-bafu: LN02 ≈ NHN + 0.32 m at Basel (derived from two published gauge zeros) | **Partly resolved:** use 0.32 m at Basel, labelled derived |
| C28 | Using `OphalenLaatsteWaarnemingen` | datum-arch §C.1 lists "OphalenLaatsteWaarnemingen / OphalenWaarnemingen every 10 min, 3 h window" | nl-rws: do not rely on `OphalenLaatsteWaarnemingen` (stale series, 1–2 value lag) | **Resolved:** use `OphalenWaarnemingen` per station with a 3 h window (nl-rws evidence) |
| C29 | PEGELONLINE poll interval | de-pegelonline: every 15 min, aligned | datum-arch: every 5 min with ETag | **Resolved:** either is polite. 15 min matches the 15-min gauges; 5 min with 304s costs little |
| C30 | HIC cache behaviour | be-flanders: `max-age` 30/60/300 by call type | datum-arch: `max-age=60`; `Last-Modified` = request time; `If-Modified-Since` still returns 200 | **Resolved:** consistent; conditional GETs do not help |
| C31 | Percentile conventions | HIC: P10 > P90 (exceedance) | SPW: P90 > mean (non-exceedance) | **Not a contradiction but a trap:** normalise per provider |
| C32 | Licence conflicts inside one provider | NLWKN manual (use with a source credit) vs Impressum (no commercial use, no storage); HIC English "non-commercial" vs Dutch "informatieve doeleinden"; GKD "CC BY 4.0" vs Impressum; LANUK DL-Zero vs a legacy "Nutzungsvereinbarung" paragraph; PEGELONLINE DL-Zero vs BfG terms for `WV` | – | **Flagged:** needs written clarification (§0.2) |
| C33 | BAFU history time zone | FAQ: UTC+1, start of interval | Sample CSV: `+00:00` | **Flagged:** ask BAFU before the backfill |
| C34 | WRIJ Nexus timestamps | Nexus mirror of RWS Lobith: 6.28 m at "16:00Z" | RWS: 628 cm at 19:00Z | **Flagged** (not a first-release source) |
| C35 | Go-live date | datum-arch sample code: `T_MIN = 2026-11-01` | Product: "from go-live", with no date given | **Flagged:** a placeholder, not a decision |
| C36 | LHP stations without a class | Gap note: 34 features with `lhpClass` = null (HE 25, BW 9) | Gap check (all states): the key is **absent**, not null, on 216 features (MV 180, HE 26, BW 9, TH 1) | **Resolved:** treat an absent class as `no-ref`; the count depends on which states are requested |
| C37 | LHP ETag | Catalogue: "the ETag changes every call" | Gap check: `If-None-Match` with the current ETag returns 304; the ETag changes when `updated` ticks (about every minute) | **Resolved:** use conditional GETs |
| C38 | Vigicrues station → section link | Gap note: only a placeholder (`"A renseigner"`), so FR-5 cannot be attached to stations | Gap check: the downward link (`TronEntVigiCru` `aNMoinsUn`) lists every section's stations; 331 stations, each in one section | **Resolved** (§2.5) |
| C39 | NL-4 content | Catalogue: static classes "Normale / Verhoogde / Hoogwater / Extreem" | Gap check: Waterinfo display classes with seasonal periods, priorities, slug duplicates and a "no rights" disclaimer; updated "quarterly" in theory | **Resolved** (§2.1 parser specification) |
| C40 | IGN69 → NAP offset | §4.1: H_IGN69 ≈ H_NAP + 0.47–0.49 m, "±2 cm" | Shared gauges: +0.535 (Breisach), +0.58 (Kehl), +1.57 m (Hanweiler); EPSG:5419 accuracy 0.1 m; Strasbourg open data +0.35 m | **Flagged:** no French absolute heights in the first release; curate a zero table later |
| C41 | Belgian fallbacks | §0.2: "VMM for non-navigable rivers"; gap note: Hub'Eau Tournai and Sambre are available; RWS `sasvangent` is a Belgian point | VMM is gated too; Tournai and Solre-Erquelinnes deliver nothing; Sas van Gent is in NL | **Resolved** (§0.6) |
| C42 | BfG `WV` weekend runs | §2.2: UNVERIFIED | §3.1 stated it as fact | **Resolved [D]:** BfG documents weekday runs plus weekend/holiday runs when Ruhrort < 4 m |
| C43 | NRW `pegeldaten.zip` | Catalogue: [V] "2 months heal" | Gap note: only `messwerte.zip` was downloaded | **Resolved [V]:** downloaded and measured in the gap check (§2.3) |
| C44 | RLP forecast percentiles | Catalogue: p10/p50/p90 | Gap check: p10, p20 … p90 (9 series) at 66 gauges | **Resolved** |
| C45 | CH-1 outage cost | §0.1: "Lost, except for 40 days from CH-3" | ch-bafu: 5/10-min data from 1974 by order (CH-8) | **Resolved:** values are recoverable by order; only `dangerLevel` states are lost |

---

## 9. Open questions

**For the product owner**
1. **Commercial or not?** Ads or paid tiers would decide how far we can rely on NLWKN (the Impressum bans commercial use), HIC ("non-commercial"), SPW, GKD Bayern and LANUK's legacy paragraph.
2. **Who sends the Phase-0 permission e-mails, and when?** HIC, VMM, SPW, AGE, NLWKN, BfG (Belegexemplar), **LfU RLP (moved to Phase 0: 66 forecast gauges, §0.5)** and LUBW, plus later LfU Bayern, BAFU (history order and hydrodaten polling), ITZBund/WSV (history form) and the Dutch water boards. HIC needs weeks of lead time. Keep the permission tracker described in §0.2.
3. **If SPW refuses or is slow**, is a link-out for Wallonia acceptable in the first release? The ungated set is in §0.6 (about 25 Belgian points from RWS and Hub'Eau; the Walloon Meuse between Chooz and Lixhe stays empty).
4. **Tidal stations** (Zeeschelde, Western Scheldt, Ems estuary, lower delta): show raw 10-min levels, a tidal mean, or the surge (measured − astronomical)?
5. **Impounded and lock gauges** (Moselle, Saar, Neckar, Main, Lahn, upper Ems, Walloon Meuse): show them, or prefer Q and anomaly stations?
6. **Forecast horizon on the slider:** RWS about 34 h; PEGELONLINE `WV` 96 h (0–48 forecast + 48–96 estimate); BAFU about 115 h; LU about 45 h (the site shows only 24/48 h); HIC 60 h and 10 days; Vigicrues about 21 h and event-only. Cap it at one horizon, or per station? Show "estimate" segments?
7. **Default map mode:** a threshold/anomaly class (many markers will be grey where there is no reference) or Δh since the window start (datum-free, works from day one)?
8. **Absolute heights:** detail view only (with the conversion caveat), or not at all in the first release? Gap check recommendation: NL, DE, LU, CH and BE (TAW) in the detail view; **French stations not at all** until the zero table is curated (§4.1, C40).
9. **Time step of the date/time selector:** 10-min quantisation (datum-arch, ch-bafu) or 15 min (most German, LU and NRW sources)?
10. **Dutch water-board rivers** (Dinkel, Berkel, Roer, Niers, Swalm, Regge): is it acceptable to cover them first through German upstream gauges and the RWS Vecht stations?
11. **Is it acceptable to publish the OSM-derived river graph under ODbL** (required if we serve it)?
12. **Basemap extent and zoom:** the study area (2.9 GB at z14) or the full Rhine basin including the Swiss Alps (4.3 GB at z14; 8.2–9.2 GB at z15)?
13. **Refresh expectations:** is 10–15 min polling with 20–75 min end-to-end latency acceptable as "near-real-time"?
14. **Go-live date** (for `T_MIN`, the time-slider start and the first backfill window).

**For the architecture phase** (see §8 C16–C20)
15. Plain PostgreSQL vs TimescaleDB for the MVP; PG 17 vs 18.
16. Whether PostGIS is needed.
17. Implementation language (TS vs Python vs Go) and scheduler (pg-boss vs croner vs APScheduler/Procrastinate).
18. Caddy with static snapshots vs nginx `proxy_cache`; whether to put a CDN in front.
19. How long to keep raw payloads (30–90 days, vs permanent for forecasts, thresholds and alerts).

**For providers (UNVERIFIED items to confirm)**
20. RWS: what quality code 25 means; whether `OphalenActueleWaarnemingen` will be fixed; whether the API hosts change with the CTD migration on 5 Nov 2026 (the documentation site move is confirmed; the API hosts are not mentioned); whether the NL-4 classes relate to the WMCN warning phases and whether those exist machine-readably; whether the longer waterinfo fan forecasts exist as data; the real forecast cadence ("elke 6 uur"); the error at the 160k limit; where 10-min history starts per station.
21. PEGELONLINE/BfG: whether DL-DE Zero covers the `WV` series and the third-party mirrors (BAFU, RWS, RP Freiburg, Ruhrverband); **how `WV` behaves above HSW / Marke II** (weekend issuance is now documented [D]); whether raw values are revised within 31 days; whether a bulk history export is allowed; the RWS mirror datum (NAP presumed).
22. HIC/VMM: credit allowances; the VMM quality-code table; whether HIC `Pv.10` timestamps are instantaneous or interval-end; the percentile convention; `getTimeseriesEnsembleValues`; how offset-less `from`/`to` inputs are read.
23. SPW: numeric alert thresholds (`NIVCRU`); forecasts; the 13 mm Abs/Rel inconsistency; permission for server-side polling and backfill.
24. Hub'Eau: confirm `altitude_ref_alti_station` is the gauge zero; NGF-1884 offsets; per-station Vigicrues thresholds; HydroPortail export access.
25. AGE: CC0 confirmation for the JSON, forecasts and page metadata; fixes for the CSV offset, `SN_Remich.json` and `Water-Levels-Localstation.csv`; archive licence; RLP's code for Bollendorf; how the percentiles are produced.
26. BAFU: the `threshold_customer` meaning; the forecast schedule outside floods; the historical CSV time zone; the LINDAS endpoint terms and any per-query runtime limit; whether one delivery of the whole network at 10 min from 2000 to now is possible.
27. NLWKN: written licence clarification; access to wasserdaten.niedersachsen.de.
28. WRIJ, Vechtstromen, Waterschap Limburg: whether an official feed exists or can be arranged; the Nexus timestamp semantics.
29. Travel times: Maxau → Lobith, Trier → Koblenz, Chooz → Borgharen and Namur → Eijsden have no primary tables; calibrate from our own data.
30. Map: the `@protomaps/basemaps` 5.7.2 × v4 tiles compatibility; CDN caching of range requests; OpenFreeMap build retention; VersaTiles and CARTO terms; the EuroGlobalMap licence; Overpass access; Belgian and French river-km systems.
31. **Class crosswalk sign-off** (§4.9), including whether RWS "Licht verhoogd" counts as `elevated`. *Answered 2026-10-03 (D18): §4.9 as proposed, "Licht verhoogd" = `elevated`.*
32. **Austria and Liechtenstein** (Alpine Rhine inflows, Bodensee at Bregenz): in scope or not? Not researched.

---

## 10. Remaining open items (after the 2026-09-23 gap check)

Items from `plan/CATALOGUE-GAPS.md` that could not be closed from the sandbox, with the reason and the next step. Items 1–8 were worked through; see the resolution log in that file.

| # | Open item | Why it is still open | Next step / owner |
|---|---|---|---|
| R1 | BfG `WV` behaviour above HSW / Marke II (stopped, capped or kept?) | Not documented; only the 14-day forecast is documented as hidden above HSW; no flood occurred | E-mail vorhersage@bafg.de (with the Belegexemplar question) |
| R2 | Flood-state fixtures for FR-4 (NL-bound basin), CH-5 and DE-10 | No archived NL-bound Vigicrues forecast or Swiss warning-section capture was found; RLP has no test server | Record live during the first event; hand-build fixtures meanwhile (§0.4) |
| R3 | Whether RWS has the longer waterinfo fan/ensemble forecasts as data; whether NL-4 classes map to WMCN phases | Needs RWS; the WMCN site is behind Keycloak and publishes PDFs only | RWS Servicedesk Data |
| R4 | Whether the RWS API hosts change on 5 Nov 2026 | The CTD announcement only covers the documentation site; GitHub Discussions returned 403 to the sandbox | Ask in GitHub Discussions; keep base URLs in config; watch the updates page |
| R5 | Permission answers: HIC, VMM, SPW, AGE (incl. CC0 scope of third-party gauges in LU-1), NLWKN, BfG, **LfU RLP**, LUBW, BAFU (hydrodaten polling) | Requires sending e-mails; the owner must decide who sends them (§9 Q2) | Phase 0 permission tracker (§0.2) |
| R6 | IGN69 offset and French gauge zeros | EPSG accuracy is 0.1 m; the EVRF2019 grid is not on the PROJ CDN; the BKG EVRS site and IGN Circé were not reachable or not scriptable from the sandbox; Hub'Eau Hanweiler zero is wrong by about 1.1 m | Hand-curate a zero table; ask DREAL/SCHAPI about A940000101; use IGN Circé manually for the curated stations |
| R7 | Endpoint reachability from the production VPS (IPv4 and IPv6) and re-test of sandbox failures (waterstandlimburg.nl 403, Saarland Bunny Shield, `server.wver.de`, `evrs.bkg.bund.de`, GitHub HTML) | Cannot be tested from the sandbox | Smoke test from the VPS with body signatures (gap item 11) |
| R8 | Whether the VMM Kempen gauges (Mark, Dommel, Warmbeek, Kleine Aa, Noordermark) deliver live values; Brabant water-board open data | Metadata only (anonymous); the Aa en Maas and Brabantse Delta ArcGIS hubs were not checked for real-time series | After the VMM token; check the ArcGIS hubs |
| R9 | What RWS `kanne` Q measures (Jeker/Geer or canal) | Not documented in the catalogue | RWS Servicedesk or compare with SPW/VMM |
| R10 | Austria/Liechtenstein inflows (Ill, Bregenzerach, Bodensee at Bregenz) | Owner decision; not researched | §9 Q32 |
| R11 | Volume budget (gap item 16), backup/RPO and isolation (item 9), bandwidth budget (item 10), DST fixtures (item 12), seed list and coverage metric (item 17), privacy and legal pages (item 18), multilingual names (item 19) | Design and prototype work, not source facts | Phase planning; the partial data points gathered are: LU-Alert archive 30 MB for 15 months; InfoVigiCru 2.2 MB per change (not per poll); `pegeldaten.zip` 10 MB per daily copy (128 MB unpacked), about 3.7 GB a year if every copy is kept |
| R12 | Owner decisions: go-live date (C35), commercial or not (§9 Q1), who sends the permission e-mails (§9 Q2), crosswalk sign-off (§9 Q31) | Owner input | Product owner |

---

## Appendix A: contact points named in the reports

| Provider | Contact | Purpose |
|---|---|---|
| RWS | "Servicedesk Data" contact form; https://github.com/Rijkswaterstaat/WaterWebservices/discussions | Fair use, API issues |
| BfG | vorhersage@bafg.de | Forecast credit / Belegexemplar |
| NLWKN | HWVZ@nlwkn.niedersachsen.de | Licence clarification |
| LUBW | Pegelinfo@lubw.bwl.de | Consent |
| HIC | hic@vlaanderen.be | TYPE 3 credentials + User Agreement |
| VMM | hydrometrie@waterinfo.be | Token |
| SPW | hydrometrie@spw.wallonie.be | Written permission |
| AGE (LU) | hydrometrie@eau.etat.lu | CC0 confirmation, bug reports, archive |
| BAFU | abfragezentrale@bafu.admin.ch (live data); hydrologie@bafu.admin.ch (history orders) | Terms, `threshold_customer`, history |
| LfU Rheinland-Pfalz | poststelle@lfu.rlp.de; Kaiser-Friedrich-Straße 7, 55116 Mainz; 06131 6033-0 (hochwasser.rlp.de Impressum) [V] | Consent for forecasts (66 gauges), alert regions and values |
| RWS WMCN | Status bulletins at `https://waterberichtgeving.rws.nl/data/…statusbericht…pdf` | Official NL river warning phases (PDF only) |


## Appendix B: documentation and evidence URLs cited by the reports

URLs not already given above, grouped by topic. Provider documentation pages may move; RWS's is due to move on 5 Nov 2026.

**Netherlands**
- RWS GitHub discussions: https://github.com/Rijkswaterstaat/WaterWebservices/discussions/57 (Laatste lag / Actuele), https://github.com/Rijkswaterstaat/WaterWebservices/discussions/42 (transition issues)
- Retirement notice: https://rijkswaterstaatdata.nl/projecten/waterwebservices-overschakeling/ (now 404). CTD preview: https://rijkswaterstaatdata.nl/preview-dataportaal/
- WFS GetCapabilities: https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities
- NGR record (HVD, "Geen beperkingen"): https://www.nationaalgeoregister.nl/geonetwork/srv/api/records/68ebd5c9-0ea1-4f22-9907-ec4c06mcd3e2
- Digitale Delta API: https://www.ihw.nl/digitale-delta-api; Gouden API 2026: https://www.digitaleoverheid.nl/nieuws/gouden-api-voor-slimme-waterdata-uitwisseling/
- Water boards: https://open.waterschaplimburg.nl/waterstanden-in-limburg, https://www.waterstandlimburg.nl/Home/Waterstanden, https://waterdata.wrij.nl/index-data.html, https://opengeo.wrij.nl/arcgis/rest/services/WaterData/Nexus_P/FeatureServer, https://kaarten.vechtstromen.nl/openbaar/, https://gprw.eu/nl/themas/data-en-kaarten; Lizard `demo.lizard.net/api/v4/organisations/`
- Clients: https://github.com/Deltares/ddlpy, https://pypi.org/project/rws-waterinfo/, R `wstolte/rwsapi`

**Germany**
- PEGELONLINE: https://www.pegelonline.wsv.de/webservice/dokuRestapi, https://www.pegelonline.wsv.de/webservice/guideRestapi, https://www.pegelonline.wsv.de/webservice/hydas, https://www.pegelonline.wsv.de/webservice/downloads, https://pegelonline.wsv.de/gast/hilfe, https://www.pegelonline.wsv.de/gast/nutzungsbedingungen, https://www.govdata.de/dl-de/zero-2-0, https://www.govdata.de/suche/daten/pegelonline-rest-schnittstelle, ITZBund press release https://www.itzbund.de/SharedDocs/Pressemitteilungen/DE/2024/2024-06-14_Pegelonline-DL-DE-Zero.html
- BfG: https://www.bafg.de/DE/3_Beraet/2_Exp_quantitaet/Vorhersagen_M2/vorhersagen_node.html, https://www.bafg.de/DE/5_Informiert/1_Portale_Dienste/14Tagevorhersage/14tagevorhersage_text.html, https://vorhersage.bafg.de/, https://6wochenvorhersage.bafg.de/
- ELWIS: https://www.elwis.de/DE/dynamisch/Wasserstaende/Pegelvorhersage:KAUB, https://www.elwis.de/DE/Service/Haftungsausschluss-und-Nutzungsbedingungen/Haftungsausschluss-und-Nutzungsbedingungen-node.html
- LHP: https://www.hochwasserzentralen.de/developers/, https://www.hochwasserzentralen.de/developers/api-docs; NRW state link `https://hochwasserportal.nrw.de/lanuv/webpublic/index.html#/Lageberichte`
- NRW: https://www.hochwasserportal.nrw/webpublic/, GovData CKAN https://www.govdata.de/ckan/api/3/action/package_search?q=hygon
- Others: https://wver.de/pegelstaende/, https://www.niersverband.de/gewaesser/pegelwesen/daten (e.g. `/fileadmin/user_upload/Dateien_GL/GL_GH/Internet_peg-kesw-woche.PDF`), https://www.hochwasser.rlp.de/ (Impressum `/static/shared/partials/impressum.phtml`), https://www.hlnug.de/static/pegel/wiskiweb3/webpublic/, https://www.hvz.baden-wuerttemberg.de/, https://www.gkd.bayern.de/, https://www.hnd.bayern.de/pegel, LfU Bayern WMS page https://www.lfu.bayern.de/umweltdaten/geodatendienste/index_detail.htm?id=1e21731e-b21d-4a3d-b9a3-bc8fa8ac8871&profil=WMS, Saarland https://www.saarland.de/mukmav/DE/portale/wasser/informationen/hochwassermeldedienst/wasserstaende_warnlage, Ruhrverband https://www.talsperrenleitzentrale-ruhr.de/online-daten

**Belgium**
- HIC: https://hicws.vlaanderen.be/
- waterinfo FAQ (tokens): https://waterinfo.vlaanderen.be/default.aspx?path=Public%2FOver+waterinfo%2FFAQ+open+data
- VMM open-data manual: https://waterinfo.vlaanderen.be/download/9f5ee0c9-dafa-46de-958b-7cac46eb8c23?dl=0; VMM disclaimer https://vmm.vlaanderen.be/disclaimer
- Modellicentie: https://www.vlaanderen.be/digitaal-vlaanderen/onze-diensten-en-platformen/open-data/voorwaarden-voor-het-hergebruik-van-overheidsinformatie/modellicentie-gratis-hergebruik
- Clients: https://docs.ropensci.org/wateRinfo/ (token endpoint), https://fluves.github.io/pywaterinfo/tutorial.html, https://github.com/fluves/pywaterinfo/issues/19
- Metadata record: https://metadata.beta-vlaanderen.be/srv/api/records/83299953-7afa-4d5e-b8a2-0af017ab4c72
- Wallonia: https://hydrometrie.wallonie.be/mentions-legales.html, https://hydrometrie.wallonie.be/conditions-dutilisation.html, https://hydrometrie.wallonie.be/home/services/telechargements-des-donnees.html, https://hydrometrie.wallonie.be/home/en-savoir-plus/reseaux-de-mesure.html, https://geoportail.wallonie.be/catalogue/a06b1f40-f85f-469e-a1af-ede1b578553d.html, https://geoportail.wallonie.be/catalogue/49373603-418d-451b-afb5-7badc8783a43.html, https://infrastructures.wallonie.be/news/lhydrometrie-en-wallonie--le-nouveau-portail; third-party claim (UNVERIFIED) https://www.kayaksemois-ardenne.be/nl/waterpeil-meuse
- Datum: https://ngi.be/tweede-algemene-waterpassing/, https://nl.wikipedia.org/wiki/Tweede_Algemene_Waterpassing, https://fr.wikipedia.org/wiki/Deuxi%C3%A8me_nivellement_g%C3%A9n%C3%A9ral

**France**
- Hub'Eau: https://hubeau.eaufrance.fr/page/api-hydrometrie, https://hubeau.eaufrance.fr/page/conditions-generales, https://www.data.gouv.fr/dataservices/hubeau-hydrometrie, https://www.data.gouv.fr/pages/legal/licences/etalab-2.0
- Vigicrues: https://www.vigicrues.gouv.fr/services/v1.1, https://www.vigicrues.gouv.fr/categorie/2
- Sandre: http://id.eaufrance.fr/nsa/76

**Luxembourg**
- https://inondations.public.lu/fr.html, https://inondations.public.lu/fr/information-niveaux-alertes.html, https://inondations.public.lu/fr/support/aspects-legaux.html, https://inondations.public.lu/fr/hydrometrie.html
- https://data.public.lu/fr/datasets/niveau-deau/, https://data.public.lu/fr/pages/api-tutorial, https://data.public.lu/en/pages/fact-sheets/licenses/
- https://eau.gouvernement.lu/fr/domaines-activite/inondations/service-de-prevision-des-crues.html; AGE annual report 2024 (pp. 18–21): https://eau.gouvernement.lu/dam-assets/publications/rapports-d'activit%C3%A9/2024.pdf
- Station fiche: http://geoportail.eau.etat.lu/pdf/hydrometrie/FichesStations/11-Diekirch.pdf; PEGELONLINE cross-check: https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?waters=MOSEL,SAAR,SAUER,OUR
- "Meine Pegel" news: https://gouvernement.lu/de/actualites/toutes_actualites/communiques/2022/11-novembre/07-application-eau.html

**Switzerland**
- https://www.hydrodaten.admin.ch/de/aktuelle-hydrologische-daten-beziehen, https://www.hydrodaten.admin.ch/de/fragen, https://www.hydrodaten.admin.ch/de/erlauterungen-zu-den-vorhersage-plots
- https://www.bafu.admin.ch/de/hydrologische-vorhersagen-und-warnungen
- BAFU 2020 conditions: https://www.bafu.admin.ch/dam/de/sd-web/g7vjiKP5LJ11/liefer-nutzungsbedingungen-hydrologische-daten.pdf; 2019 conditions: https://www.bafu.admin.ch/dam/de/sd-web/5NAitqNKub6m/allgemeine_bedingungenfuerdasherunterladenaktuellerhydrologische.pdf
- https://opendata.swiss/en/terms-of-use, https://data.bs.ch/api/v2/catalog/datasets/100089
- https://undine.bafg.de/rhein/pegel/rhein_pegel_basel.html, https://www.meteoswiss.admin.ch/weather/warning-and-forecasting-systems/icon-forecasting-systems.html, https://opendatadocs.meteoswiss.ch/, https://gibs.bkg.bund.de/geoid/de/dacherlaeuter_em.php
- Non-authoritative: https://klimaatgek.nl/wordpress/2026/08/30/nogmaals-rijnafvoer/

**Datums, map and geometry**
- EPSG: https://epsg.io/7838, https://epsg.io/5419, https://epsg.io/5198; BKG EVRS https://evrs.bkg.bund.de/Subsites/EVRS/EN/RealizationofEVRS/EVRF2019/evrf2019.html; https://de.wikipedia.org/wiki/Deutsches_Haupth%C3%B6hennetz
- https://docs.protomaps.com/basemaps/layers, https://maplibre.org/maplibre-style-spec/layers/, https://maplibre.org/maplibre-style-spec/expressions/, https://maplibre.org/maplibre-gl-js/docs/, https://deck.gl/docs/api-reference/geo-layers/trips-layer, https://deck.gl/docs/api-reference/layers/path-layer, https://visgl.github.io/react-map-gl/docs/whats-new
- https://www.hydrosheds.org/products/hydrorivers, https://data.hydrosheds.org/file/technical-documentation/HydroSHEDS_TechDoc_v1_4.pdf, https://www.hydrosheds.org/products/hydrosheds-v2, EU-Hydro metadata https://sdi.eea.europa.eu/catalogue/copernicus/api/records/393359a7-7ebd-4a52-80ac-1a18d5f3db9c, https://download.geofabrik.de/europe.html, BfG Undine 1993 https://undine.bafg.de/rhein/extremereignisse/rhein_hw1993.html

**Stack landscape**
- Node: https://nodejs.org/en/blog/release/v26.0.0, https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule, https://www.infoq.com/news/2026/07/nodejs-26-temporal/
- TypeScript 7: https://www.infoq.com/news/2026/08/typescript-7-released/, https://www.theregister.com/devops/2026/07/09/speedier-type-checks-in-typescript-70-as-first-stable-go-release-ships/5268828
- Build and test: https://vite.dev/blog/announcing-vite8, https://vitest.dev/blog/vitest-5.html
- Bun: https://bun.com/blog/bun-v1.4, https://anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone
- Frameworks: https://astro.build/blog/astro-7/, https://www.infoq.com/news/2026/09/solid-start-v2/, https://svelte.dev/blog/sveltekit-3-release-candidate, https://trilon.io/blog/nestjs-12-is-now-available, https://github.com/fastify/fastify/milestone/6, https://litestar.dev/blog/v3-announcement/, https://orm.drizzle.team/docs/latest-releases, https://github.com/sinclairzx81/typebox/blob/main/changelog/1.0.0-migration.md
- Database: https://www.tigerdata.com/docs/about/latest/timescaledb-editions, https://www.postgresql.org/about/news/postgresql-18-released-3142/
- Python: https://docs.bswen.com/blog/2026-03-05-httpx-library-status/, https://pydevtools.com/handbook/how-to/how-to-use-exclude-newer-for-reproducible-python-environments/
- Supply chain: https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23, https://www.microsoft.com/en-us/security/blog/2026/03/24/detecting-investigating-defending-against-trivy-supply-chain-compromise/, https://www.wiz.io/blog/keyv-and-cacheable-npm-supply-chain-attack, https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/, https://socket.dev/blog/pnpm-11-adds-new-supply-chain-protection-defaults, https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/, https://github.blog/changelog/2025-07-01-dependabot-supports-configuration-of-a-minimum-package-age/, https://github.com/renovatebot/renovate/discussions/42610, https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/, https://github.com/security/plans
- Containers: https://www.docker.com/blog/docker-hardened-images-for-every-developer/, https://github.com/bitnami/containers/issues/83267, https://support.chainguard.dev/hc/en-us/articles/40405733238299-Customer-Notice-Free-Image-Tier-Changes, https://linuxiac.com/docker-update-tool-watchtower-reaches-end-of-maintenance/, https://github.com/docker/compose/releases
- TLS: https://letsencrypt.org/2025/12/02/from-90-to-45, https://letsencrypt.org/2025/09/11/native-acme-for-nginx
- Ops: https://develop.sentry.dev/self-hosted/, https://glitchtip.com/documentation/install, https://healthchecks.io/pricing/, https://percona.community/blog/2026/04/28/pgbackrest-is-archived-what-now/, https://noise.getoto.net/2026/05/19/pgbackrest-will-continue/, https://caniuse.com/temporal

**Raw evidence.** The reports name these raw files in `scratchpad/`:
- RWS: `catalog.json`, `openapi.json`, `wfsall.json`, `last_many.json`, `fc1.json`.
- PEGELONLINE: `stations_all.json`, `all_ts.json`, `basins_full.json`, `wv.json`, `kaub_q.csv`, `hist.zip`; 30-day series in `po/`.
- Flanders: `wi/`.
- France: `fr/`.
- Luxembourg: `station_configs.json` (thresholds and metadata for all 42 stations), `js/`, `fc/`, `Water-Levels-LocalTime.csv`, `lualert_all.json`, `fc_watch.log`.
- Travel times: `gwio85006.pdf`, `maas2021.pdf`.
- Tools: the `go-pmtiles` binary in `bin/`.

The other reports saved their payloads in `scratchpad/` without naming individual files.
