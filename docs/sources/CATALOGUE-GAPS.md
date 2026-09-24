# Gaps in SOURCE-CATALOGUE.md: what is missing, wrong or weak (prioritised)

Reviewed on 2026-09-23 against the 11 raw reports in `scratchpad/research/`. I also spot-checked the raw evidence in `scratchpad/`: `grens.xlsx`, `fr/st_*.json`, `basins_full.json`, `lhp_multi.json`, `lhp_alerts.json`, `fr/vc_sta_det.json`, `wv.json`, `nrwdl/` and `fc_watch.log`. Items are ordered by how much they would change the phase plan. Each item says what is wrong or missing, why it matters, and a concrete check that resolves it.

---

1. **The data-loss clock ranks the wrong streams first. Forecasts, alert states and threshold versions are the data that cannot be recovered. Most observations can be.**
   - **Problem.** §0.1 treats every source's retention window as data lost for good. But the raw reports show that most observations can be recovered later:
     - PEGELONLINE raw W and Q since 2000 via the DE-5 form;
     - BAFU 5- and 10-minute data from 1974 by order (CH-8), so CH-1 is not "Lost";
     - the AGE validated archive for 2002–2024, on request;
     - decades of data from RWS and all three KiWIS servers;
     - Hub'Eau daily aggregates (FR-2), and HydroPortail exports (UNVERIFIED).

     What is genuinely lost is:
     - every forecast run (RWS, BfG WV, Vigicrues, LU-3, CH-4, RLP);
     - every alert or class state (LHP, Vigicrues `NivInfViCr`, CH-5/CH-6, LINDAS `dangerLevel`, LU-Alert before the dump);
     - every threshold version (the NL-4 quarterly xlsx, LU-4 pages, PEGELONLINE characteristic values and PNP `validFrom`);
     - the raw values exactly as published at the time.

     The catalogue says "store raw payloads from go-live". It does not turn this into a rule for what goes first, and its cross-reference points to §6.2 (the benchmark) instead of §6.5.
   - **Why it matters.** The scheduling insight says to get minimal ingestion running early. The minimal slice should therefore be a *raw, hash-deduplicated archiver of forecast, alert, class and threshold payloads* from sources that need no permission. It can store raw now and parse later. It does not have to be an observation pipeline with a finished schema.
   - **Resolve.**
     - Add a table with a "recoverable by" column for each stream: API, order/form, or never.
     - Define the first ingestion slice as a raw archiver covering:
       - NL-1 forecasts;
       - DE-2 WV;
       - DE-6 classes;
       - FR-4 and FR-5;
       - LU-5;
       - CH-1, CH-2, CH-4 and CH-5;
       - weekly NL-4 and PEGELONLINE metadata snapshots.
     - Add a "day-0 harvest" of every rolling window on the first run:
       - PEGELONLINE `P31D`;
       - Hub'Eau 1 month;
       - Vigicrues about 66 days per station;
       - NRW `messwerte.zip`, plus `pegeldaten.zip` once verified;
       - CH-3 40 days;
       - LU-1 5 days.

2. **None of the flood-time behaviour has been observed live. All research ran during an extreme low-water event.**
   - **Problem.** No provider was seen in a flood state:
     - LHP `/data/alerts` returned 0 features (`lhp_alerts.json`) and every class was 0 or −1.
     - Vigicrues had no forecast in territory 2. The only forecast payload came from a Loire station (K490003010).
     - All 337 `NivInfViCr` values were 1.
     - One Swiss warning section was seen.
     - No HIC threshold was exceeded.

     BfG WV is a navigation forecast. The BfG 14-day CSV suppresses values above 640 cm at Kaub, and BfG says the state flood centres (HVZ) are official during floods. Whether WV continues, is capped or is replaced during a flood is unknown. Yet the catalogue lists DE-6 as having "alerts" [V] and DE-2 as a first-release forecast.
   - **Why it matters.** Flood time is when the product matters most and when traffic peaks. Parsers and the UI would ship untested on exactly those code paths.
   - **Resolve.**
     - Build flood fixtures from these sources:
       - the LHP test server `…/public/v1/test` (fixed test data, including classes 1–4 and alerts);
       - LU-Alert CAP files since 2025-06, filtered on `[AGE]`/`FLOOD`;
       - archived Vigicrues `InfoVigiCru`/`prevision.json` payloads from a past event (for example via the Wayback Machine);
       - a CH-4 run from a flood day.
     - Ask vorhersage@bafg.de how WV behaves above HSW or Marke II, and whether it stops in favour of the HVZ products.
     - Add a "flood drill" test phase before public launch.

3. **Official forecast coverage upstream of NL is very thin at first release. German state flood forecasts are missing completely.**
   - **Problem.** Taking the licence gates into account, the forecasts available at first release are:
     - NL: RWS, about 34 h, at 183 H and 13 Q locations.
     - DE: WV at 7 Rhine gauges only (BfG terms, including the Belegexemplar).
     - FR: event-only.
     - CH: undocumented CH-4.
     - BE: none. HIC is gated; for VMM `H_voorspeld` only the parameter was seen, and it is token-gated; SPW has none.
     - LU: none. LU-3 is gated.

     So the Meuse upstream of Eijsden and the whole Moselle, Saar, Main, Neckar, Lahn and Ems have no forecast outside French events. The state flood centres (RLP LfU for the Middle Rhine, Mosel, Saar, Nahe and Lahn; LUBW for the Upper Rhine; HLNUG) publish the *official* flood forecasts. The catalogue puts them under "later / not needed for the first release". RLP also computes the Perl, Stadtbredimus and Wasserbillig forecasts that Luxembourg displays. EFAS and GloFAS are not assessed at all.
   - **Why it matters.** The requirement is "official forecasts where published", and the time slider is meant to reach into the future. As planned, the forecast layer is weakest in exactly the reaches where floods start.
   - **Resolve.**
     - Add a per-river forecast-coverage matrix: first release versus after each permission.
     - Move the LfU RLP and LUBW permission e-mails to Phase 0. The RLP address was not researched, so find it from the Impressum.
     - Record an explicit decision on EFAS (real-time data is restricted to authorities, UNVERIFIED) and on GloFAS (open, but modelled and not "official").
     - Ask RWS whether the longer waterinfo forecasts (fan charts) are available anywhere as data.

4. **Belgium can be empty at first release. The fallbacks in §0.2 depend on sources that are themselves gated.**
   - **Problem.**
     - HIC needs a TYPE-3 User Agreement.
     - VMM asks for a token for any automated use.
     - SPW needs written consent.

     The §0.2 fallback for HIC names "VMM for non-navigable rivers". VMM is also gated, and it covers neither the Scheldt, Leie, Dender and Zeeschelde nor the Meuse. Without permissions the map has a hole between France (Chooz, Maulde, Bousbecque) and NL (Eijsden, Bath). Some fallbacks are not in the catalogue:
     - RWS's own CC0 Belgian points (`antwerpen` with a forecast, `lixhebiefaval`, `sasvangent`);
     - Hub'Eau's hourly Belgian partner stations (Semois, Chiers/Torgny, Sambre, Escaut/Tournai, Lys/Menen);
     - the Metawal clause that allows SPW data "sur support statique (… pdf ou image sur Internet)".
   - **Why it matters.** The product promises Belgium from the start, and HIC's first reply alone takes 5 working days.
   - **Resolve.**
     - Send all permission e-mails now, and keep a permission tracker with date sent, date answered, conditions and a per-source go/no-go date.
     - Quantify how many curated BE stations can be served with no permissions: RWS BE locations, Hub'Eau partners, and possibly static images for SPW.
     - Check whether the EU High-Value Datasets regulation (2023/138) covers real-time hydrometry. This is UNVERIFIED; if it does, it strengthens the requests to SPW, HIC and AGE.

5. **Our own public API is itself redistribution, and the catalogue never says so.**
   - **Problem.** Every `/snapshot`, `/series` or CSV download republishes the ingested data. The restrictive terms forbid exactly this:
     - SPW: *"site web, webservice"*;
     - NLWKN: *"an Dritte weiterzugeben"*;
     - the AGE CGU;
     - the HIC TYPE-3 agreement (terms still unknown);
     - RLP and LUBW.

     Per-response attribution duties also exist:
     - Etalab: the date of last update;
     - LHP: "Stand" and a clickable link;
     - HIC: the retrieval date;
     - BfG: credit and a Belegexemplar.
   - **Why it matters.** Without enforcement in the data model, a permission that is granted "for display only" can still be breached by the API or by a bulk export.
   - **Resolve.**
     - Add per-source licence flags (display, API, bulk export, history export, attribution text) to the series and source tables.
     - Make the API and export layer filter on those flags.
     - Include the attribution and "last updated" text in each response.
     - In every permission e-mail, ask explicitly about machine-readable redistribution and historical archives.

6. **The cross-country class mapping is not specified, and several threshold sources are weaker than the catalogue says.**
   - **Problem.** Section 4.7 gives a priority order but no crosswalk from each provider's scale to the six-level `low…extreme` scale. The scales to map are:
     - LHP 0–4;
     - Vigicrues 1–4;
     - BAFU 1–5;
     - AGE yellow/orange/red plus HQ levels;
     - HIC prewaak/waak/alarm;
     - NRW Info 1–3;
     - NLWKN Meldestufe 1–3;
     - RWS labels;
     - PEGELONLINE MNW/MHW/HSW/M_I/M_II.

     The raw data also shows these problems:
     - **LHP duplicates the same gauge across states, with conflicting classes.** Worms is RP 0 and HE −1; Perl is SL 0, RP −1 and a second SL entry −1; Kaub and Mainz appear under both HE and RP; Kleinheubach and Obernau appear under both BY and HE. In addition, 34 features have `lhpClass` = null ("Ohne Hochwasser-Einstufung": HE 25, BW 9), which the documented −1…4 range does not allow.
     - **The Vigicrues station-to-section link is only a placeholder.** In `v1.1/StaEntVigiCru` it reads `aNPlusUn.CdEntVigiCruSuperieur: "A renseigner"`. FR-5 section colours therefore cannot be attached to stations from metadata, although the catalogue plans that for FR-5 at first release.
     - **LU at first release has only the 3 LU-Alert zones**, because LU-4 is gated.
   - **Why it matters.** "Classified honestly across countries" is a product requirement. Without a written crosswalk, each implementing agent will make up its own mapping.
   - **Resolve.**
     - Write a crosswalk table with one row per provider class, the target level, the rationale and whether the class measures stage, discharge or a regional area. The product owner signs it off.
     - Set a rule for LHP duplicates: prefer the state that operates the gauge, or the "worst class wins", shown with its provenance.
     - Map stations to Vigicrues sections by a spatial join between the station point and the `InfoVigiCru` MultiLineStrings, with a manual override table.

7. **NL-4 is described wrongly. It holds Waterinfo legend classes, not alert levels, and it is neither static nor simple.**
   - **Problem.** I parsed `grens.xlsx` (6,245 rows; about 240 location codes; 5,722 NAP-level rows; 480 Q rows):
     - Class bounds **vary by month or season**. Lobith Q "Normaal" starts at 1,000 to 1,400 m³/s depending on the month, and there are periods such as "Winterstand" and "VeerseMeer".
     - Each code has **three slug variants** (for example `Lobith(LOBI)`, `-1`, `-2`).
     - Label wording varies ("Licht verhoogd", "Stormvloed", "Streefpeil", "Hoogwater (1225cm)" without the ">").
     - The `Uitleg` sheet says *"hier kunnen geen rechten aan worden ontleend"* and that the file is **updated quarterly**, so the 15-4-2026 edition may already be stale.
     - Key stations have no rows at all: `holtheme.vecht` and `millingenaanderijn.pannerdensekop`.
     - The official WMCN warning phases are not researched.
   - **Why it matters.** The catalogue's description ("Normale / Verhoogde / Hoogwater / Extreem", static) would lead to a wrong parser, and to marketing display classes as official alert levels.
   - **Resolve.**
     - Specify a parser that honours `Period`, `FromMonth`/`ToMonth` and `Priority`, and deduplicates the slug variants.
     - Compute the class coverage of the curated NL station list.
     - Check rijkswaterstaatdata.nl for a newer edition of the file, and detect new editions automatically.
     - Ask the RWS Servicedesk whether these classes match the WMCN alarm or warning levels and whether those levels exist in machine-readable form.

8. **The IGN69 datum conversion is contradicted by the only shared gauges.**
   - **Problem.** Section 4.7(5) says to show "≈ m NAP (… IGN69 −0.48 m; ±2 cm)", using H_IGN69 ≈ H_NAP + 0.47…0.49. Three gauges are mirrored in both Hub'Eau (`code_systeme_alti_site` 3) and PEGELONLINE (NHN):
     - Breisach: 185.05 vs 184.515, a difference of **+0.535 m**;
     - Kehl: 133.6 vs 133.02, a difference of **+0.58 m** (identical readings, 1850 mm and 185 cm);
     - Hanweiler: 191.3 vs 189.731, a difference of **+1.57 m** (identical readings, 2347 mm and 234 cm).

     Either the offset or Hub'Eau's `altitude_ref_alti_station` is unreliable; at Hanweiler the difference is off by more than a metre. The catalogue never ran this check, although the data was in hand.
   - **Why it matters.** It would put wrong absolute heights in the detail view and produce false cross-border comparisons.
   - **Resolve.**
     - Show no converted absolute heights for French stations at first release.
     - Verify the IGN69→EVRF2007 offset with IGN Circé or the BKG tool.
     - Compare every Hub'Eau/PEGELONLINE and Hub'Eau/SPW shared gauge. SPW Chooz DGH 8702 (datum in DNG) against Hub'Eau B720000001 would test TAW↔IGN69 directly.
     - Hand-curate the zero table.

9. **The single VPS is a single point of failure for the unrecoverable streams, and backup, recovery and isolation are barely specified.**
   - **Problem.** Backups get one line (§7.5). There is:
     - no recovery point objective or recovery time objective;
     - no off-box replication of the raw archive;
     - no second collector;
     - no restore drill before go-live;
     - no disk-full alarm.

     There is also no isolation between the public API and ingestion during a traffic spike: CPU, memory and database connections are shared.
   - **Why it matters.** A dead VPS or a full disk during a flood loses precisely the forecasts and alert states from item 1, at the moment they matter most. It can also starve ingestion exactly when data is needed.
   - **Resolve.**
     - Set a recovery point objective for the raw archive (for example ≤ 1 h) and an hourly offsite sync (restic to object storage).
     - Consider a second, minimal collector for the forecast, alert and class streams at another provider or region. First check that its IP is not blocked (item 11).
     - Give the containers Compose CPU and memory limits, and give ingestion its own database pool and priority.
     - Alarm on disk usage.
     - Run a restore drill before public launch.

10. **There is no bandwidth or egress budget for flood spikes.**
    - **Problem.** The basemap (2.9–4.3 GB PMTiles), the JavaScript (MapLibre alone is about 300 KB gzip) and the API all come from one VPS. The caching design covers API CPU but not network egress or the VPS's traffic cap.
    - **Why it matters.** "Must not fall over during a flood" is more likely to fail on uplink saturation (tiles) than on database load. If the uplink saturates, the API goes down with it.
    - **Resolve.**
      - Measure the bytes per typical map session in a prototype.
      - Multiply by the expected flood-day sessions.
      - Compare the result with the chosen VPS plan's bandwidth and monthly traffic cap.
      - Decide beforehand whether tiles (static and licence-neutral) go behind a CDN, or whether to accept an automatic switch to OpenFreeMap under load.

11. **Endpoint reachability was never tested from the production IP.**
    - **Problem.** All research ran through a cloud sandbox proxy. Several failures may be artefacts of that environment:
      - waterstandlimburg.nl 403;
      - Saarland Bunny Shield 403;
      - `server.wver.de` and `waterdata.wrij.nl` resets;
      - Overpass, Geofabrik and CCM2.

      The reverse can also happen: datacentre IP ranges can be blocked by Cloudflare (AGE), Azure APIM (NLWKN) or "usage abusif" rules (Hub'Eau). The OSM tile server returns HTTP 200 with a "blocked" PNG.
    - **Why it matters.** Sources could silently fail on day one, or unreachable sources could be written off wrongly.
    - **Resolve.**
      - Run a smoke test from the actual VPS over IPv4 and IPv6 against every endpoint in §1a.
      - Assert on a body signature, not only the HTTP status.
      - Re-test the "unreachable" sources from there.

12. **Two external deadlines fall in the likely go-live window.**
    - **Problem.**
      - The DST fall-back is on 2026-10-25 at 01:00Z. At least 8 inputs carry offset-less local times: LU-1 CSV, NL-2 WFS, DE-6 features, the DE-1 CSV, the DE-3 "GMT+1" CSV, the DE-10 CSV, DE-12 "MESZ"/"MEZ" and DE-13.
      - RWS moves its documentation to CTD on 2026-11-05. Whether the API hosts change is UNVERIFIED.
    - **Why it matters.** A parser first used near 25 October corrupts the repeated hour. The LU CSV's 15-minute label bug makes this worse. NL is the core source, so an RWS host change right after go-live would break it.
    - **Resolve.**
      - Add DST-transition fixtures for every offset-less parser before the first production run, or keep those sources out of the first slice. Use RWS REST rather than the WFS.
      - Ask RWS in GitHub Discussions whether `ddapi20-waterwebservices…` changes on 5 November.
      - Keep all base URLs in configuration and watch the RWS updates page.

13. **The security baseline says "Accept JSON only", which is wrong for the chosen sources.**
    - **Problem.** First-release inputs include:
      - CSV (LU-1);
      - ZIP files of CSV (DE-7, and DE-5 later);
      - CAP XML (LU-5);
      - SPARQL CSV (CH-1);
      - XLSX (NL-4);
      - HTML scraping (LU-4, once permitted).

      The allowlist and redirect rules also miss some cases:
      - HIC's legacy URL redirects to `waterinfo.vlaanderen.be`, another host;
      - `pegelonline.wsv.de` without `www` (HyDAS and DE-5);
      - `rijkswaterstaatdata.nl` (the NL-4 refresh);
      - `vorhersage.bafg.de`.
    - **Why it matters.** Unhardened ZIP, XML or XLSX handling is a real attack surface (zip-slip, zip bombs, XML entity expansion), and a strict "same host only" redirect rule will break HIC.
    - **Resolve.**
      - Write per-format rules: a ZIP entry-count, size and path check; XML with DTDs and entities disabled (this includes XLSX); CSV row and field limits.
      - Complete the egress allowlist from §1a and state the redirect exceptions explicitly.

14. **Several rivers that flow into NL are not covered, and no decision about them is recorded.**
    - **(a) The Belgian Kempen rivers that enter NL directly:** the Mark, Dommel, Aa/Weerijs, Warmbeek/Tongelreep, Keersop and Merkske, plus the Voer at Eijsden. VMM names the Mark and the Voer, but the shortlist has no station for any of them. The NL water boards on those rivers (De Dommel, Brabantse Delta, Aa en Maas) were not researched.
    - **(b) Rhineland-Palatinate tributaries have classes only, not values:** Ahr (3 LHP gauges), Kyll (7), Prüm (5), Nahe (7), and the German banks of the Sauer and Our. The Ahr is the river of the 2021 flood disaster, and visitors will expect it.
    - **(c) The Alpine Rhine inflows from Austria (Vorarlberg Ill, Bregenzerach) and Liechtenstein, plus the Bodensee level at Bregenz.** These countries are outside the owner's list, but they are part of the supplying basin.
    - **(d) The NL water-board stretches of the Roer, Niers, Swalm, Dinkel, Berkel, Regge, Oude IJssel and Westerwoldse Aa.**
    - **(e) Canals that move river water across borders:** the Albert Canal withdrawal at Monsin, the Juliana Canal, the Zuid-Willemsvaart, and Gent–Terneuzen (HIC's Zelzate calculated Q; RWS `sasvangent`).
    - **Resolve.**
      - Run VMM `getStationList` with a bounding box over the Kempen border area.
      - Check open data from the Brabant water boards.
      - Ask the product owner to decide on Austria and Liechtenstein; check eHYD and Vorarlberg open data (UNVERIFIED).
      - Put the RLP permission in Phase 0 (see item 3).

15. **The Swiss first-release content depends on undocumented website files, and nobody has confirmed they may be polled.**
    - **Problem.** CH-2 (thresholds), CH-4 (forecasts) and CH-5 (warnings) are internal hydrodaten files. According to ch-bafu, the 10-minute rule in the BAFU 2019 conditions was "written for account-based downloads"; the catalogue drops that nuance. LINDAS, the official feed, has `dangerLevel` but no numeric thresholds and no forecasts.
    - **Resolve.**
      - E-mail abfragezentrale@bafu.admin.ch. Ask whether polling hydrodaten JSON is acceptable and at what interval, and whether the thresholds and forecasts are, or will be, on LINDAS.
      - Define the fallback as LINDAS `dangerLevel` plus the official CH-6 classes.

16. **There is no volume budget for the raw archive.**
    - **Problem.** Rough uncompressed volumes per day, before deduplication:
      - RWS forecasts: 196 series × about 60 KB, hourly, about 280 MB;
      - Vigicrues `InfoVigiCru`: 2.2 MB per poll, 100–200 MB;
      - LU JSON: about 105 MB;
      - RWS REST: about 100 MB;
      - NRW `messwerte.zip`: about 87 MB, already compressed, so it will not shrink further;
      - Hub'Eau: tens to hundreds of MB, depending on the window;
      - CH-2: about 36 MB.

      That totals roughly 0.5–1 GB a day. The plan keeps forecasts, alerts and thresholds permanently, on a VPS sized at 160 GB.
    - **Resolve.**
      - Archive a 48-hour sample with sha256 deduplication and zstd, and measure it.
      - Set retention per source.
      - Prefer delta-friendly endpoints: NRW layer 10 instead of the zip, and `InfoVigiCru` only when `DtHrInfoVigiCru` changes.
      - Size the disk and the offsite target from the measured numbers.

17. **There is no machine-readable seed list of stations and no coverage metric.**
    - **Problem.** Section 3 is narrative and mixes gated with ungated sources. Implementing agents need one file with a row per physical gauge and quantity. Each row should hold:
      - the canonical source and provider IDs;
      - coordinates;
      - datum and gauge zero, with validity dates;
      - river and km system;
      - tidal or weir flags;
      - the threshold source and forecast source;
      - the licence-gate status;
      - whether the station is in the first release.
    - **Resolve.**
      - Generate that file (CSV or YAML) from §3.
      - Report two numbers: the share of first-release stations that get a non-grey class, and the share that have a forecast, using sources that need no permission.

18. **Privacy, legal pages and disclaimers are missing entirely.** The catalogue has no GDPR or privacy content. Still needed:
    - an IP-logging and retention policy (for rate limiting and access logs);
    - no third-party requests without disclosure (the OpenFreeMap fallback, a CDN, glyphs and fonts);
    - cookie-less analytics, if any analytics at all;
    - a privacy notice and colophon in NL and EN;
    - one consolidated "not an official warning service" page linking the official channel per country: RWS/WMCN, LHP, waterinfo.be, SPW, Vigicrues, inondations.lu and naturgefahren.ch.

    **Resolve:** add these as acceptance criteria in the launch phase.

19. **Multilingual names and labels are not planned.**
    - **Problem.** Providers publish several language variants: LU pages in FR, DE and EN; CH files in de, en, fr and it; section names in German, such as "Rhein von Mündung Aare bis Mündung Ergolz". Alert labels come in FR and DE. River names differ between languages: Maas/Meuse, Moezel/Mosel/Moselle, Sûre/Sauer, Schelde/Escaut, Leie/Lys.
    - **Resolve.**
      - Station names: use the name in the canonical source's primary language.
      - River names: keep a curated NL/EN table, seeded from OSM `name:nl`/`name:en` and Wikidata.
      - Translate the provider alert labels ourselves in a reviewed table.

20. **Verification-status corrections**, each small but worth fixing so that agents do not trust them:
    - DE-7: "up to 2 months heal from `pegeldaten.zip`" is marked [V], but only `messwerte.zip` was downloaded (`scratchpad/nrwdl/`). DE-8's `hydro/q` was also not downloaded. Both should be [D].
    - DE-6 "plus alerts": only an empty alerts response was seen. The alert schema is unverified.
    - FR-4: the parser sample is a Loire station. No forecast from an NL-bound basin has been seen.
    - LU-3 "hourly": this rests on two samples 8 minutes apart (`fc_watch.log`), so it is only partly verified.
    - §2.2 says WV weekend behaviour is UNVERIFIED, while §3.1 states "WV runs at weekends when Ruhrort is below 400 cm" as fact.
    - §6.5 says only PEGELONLINE and geo.admin/hydrodaten support conditional requests. HLNUG also sends an ETag. LHP's ETag changes every minute.
    - §0.2 lists LU-1 as "safe", but the CSV includes third-party gauges (LfU RLP Bollendorf and Gemünd, WSV Perl, Service de la navigation). Whether AGE's CC0 covers them is UNVERIFIED (be-wallonia-lu).
    - The owner decisions that block the plan are still open and should be answered now: the go-live date (C35 `T_MIN`), commercial or not (§9 Q1), and who sends the permission e-mails (§9 Q2).

---

## Resolution log (gap check, 2026-09-23, about 21:15–22:15 UTC)

Live calls went through the sandbox proxy; raw evidence is in `scratchpad/gapcheck/`. `SOURCE-CATALOGUE.md` was updated in place (the pre-revision copy is `plan/SOURCE-CATALOGUE.before-gapcheck.md`). Anything still open is listed in the catalogue's new **§10 Remaining open items**.

| # | Status | What was checked | Result and where it landed |
|---|---|---|---|
| 1 | **Resolved** | Retention of every stream, re-read against the raw reports; NRW `pegeldaten.zip` downloaded | §0.1 rewritten with a "recoverable by" column (API / order-form / never). CH-1 values are recoverable by order (CH-8); only `dangerLevel` states are lost. New §0.1a (raw archiver for forecasts, alerts, classes and threshold versions, with the change gate per stream) and §0.1b (day-0 harvest list). The cross-reference now points to §6.5. |
| 2 | **Partly resolved** | LHP test server (`/public/v1/test/data/{stations,alerts}`); Wayback CDX for Vigicrues, hydrodaten and LHP; all 833 LU-Alert dumps; BfG documentation | New §0.4. LHP test data is the 2024-01-25 flood (station classes up to 3; 40 alerts, classes 1/2/4/5). **The alert schema is now verified**: string `lhpClass`, a different 1/2/4/5/6 scale, Polygon/LineString, no per-alert times. LU-Alert has **real AGE flood alerts** (red Sud 2025-09-08/09, Moselle 2026-02-13); Cancel messages have no `<info>`; a TEST message has `status` Actual. Wayback: InfoVigiCru 2023-12-11 with levels 2–3 (different key casing); CH-4 2023-11-02 (storm Ciarán). BfG: the 14-day forecast is hidden above HSW; `WV` behaviour above HSW is still unknown (open, R1). No NL-bound FR-4 or CH-5 flood capture found (R2). A flood drill is proposed. |
| 3 | **Resolved (matrix), open (answers)** | RLP Impressum (saved page) and live `/api/v1/index` + `/config`; EFAS/GloFAS terms; RWS WMCN site | New §0.5 coverage matrix. **RLP publishes p10–p90 forecasts at 66 gauges** (Rhine 20 from Maxau to Emmerich, Mosel 9 incl. Perl/Stadtbredimus/Wasserbillig, Ahr 3, Nahe 5, Lahn 4, Sauer 2, Our 2 …) plus 46 alert regions; contact **poststelle@lfu.rlp.de** (Kaiser-Friedrich-Straße 7, 55116 Mainz); moved to Phase 0. EFAS: real-time restricted to authorised users, open after 30 days → not used. GloFAS: open (EWDS, CEMS-FLOODS licence) but modelled → not used in the first release. RWS fan forecasts and WMCN phases: WMCN publishes PDF status bulletins only (open, R3). |
| 4 | **Resolved** | RWS catalogue + live WFS for Belgian locations; Hub'Eau referential and `observations_tr` for commune 99131; VMM `getStationList` bbox; HVD Regulation 2023/138 on EUR-Lex | New §0.6 and a corrected §0.2. Ungated Belgium = about 25 live points: RWS `antwerpen` (fc), `lixhebiefaval`, `maaseik` (H+Q fc), `herenlaak`, `lanaken` (fc), `kanne`, `smeermaas.zuidwillemsvaart`, plus 18 NL-bound Hub'Eau partner stations. **Corrections:** `sasvangent` is in NL; Hub'Eau Escaut/Tournai and Sambre/Solre deliver nothing. VMM has gauges on the Mark, Dommel, Warmbeek, Kleine Aa and Noordermark (token-gated). HVD: no real-time requirement for hydrometry → only a soft argument. Permission-tracker rule added. |
| 5 | **Resolved (design rule)** | Licence texts already in the catalogue; RLP Impressum | New §0.7: per-source licence flags (display / api / bulk_export / history_export / attribution / last-updated / retrieval-date), API and export filtering, per-response attribution; every permission e-mail asks about machine-readable redistribution and archives (§0.2). |
| 6 | **Resolved (proposal needs sign-off)** | LHP live (all states) for duplicates and class-less features; Vigicrues `TerEntVigiCru`/`TronEntVigiCru` for 3 territories; RLP class config | New §4.9 crosswalk (one row per provider class, target level, basis stage/discharge/area, rationale) and an LHP duplicate rule. **Corrections:** LHP class-less features are 216 with the key *absent* (MV 180, HE 26, BW 9, TH 1), not 34 nulls; the Vigicrues section → station link *is* published downward (`TronEntVigiCru` `aNMoinsUn`; 56 sections, 331 stations, one section each), so no spatial join is needed except as a cross-check; no Vigicrues section covers the French Escaut/Scarpe/Deûle. Sign-off is §9 Q31. |
| 7 | **Resolved** | Parsed `grens.xlsx`; checked the rijkswaterstaatdata.nl waterdata page and the CTD preview page | §2.1 NL-4 parser specification and corrected §1a/§1b rows: 237 H codes, 27 Q codes, seasonal/monthly periods (union with `Gehele jaar`), lower Priority number wins, slug duplicates (6,245 → 1,542 rows), label variants. Coverage of curated live series: H 49/54, Q 14/18 (missing listed). Only the 15-4-2026 edition is online (the quarterly update did not appear). The URL is at risk from the CTD launch on 5 Nov 2026. WMCN phases: PDF bulletins only; mapping to NL-4 is UNVERIFIED (R3). |
| 8 | **Resolved (decision), open (true offset)** | Hub'Eau vs PEGELONLINE zeros and live readings at Breisach, Kehl, Hanweiler; PROJ database; Strasbourg open data; SPW Chooz 8702 vs Hub'Eau | Readings agree within 1–2 cm, zeros differ by +0.535, +0.58 and +1.57 m; PROJ IGNF:TSG1251 gives −0.47 m constant and EPSG:5419 has 0.1 m accuracy; Strasbourg says +0.35 m. **Decision recorded: no converted absolute heights for French stations in the first release** (§4.1, §4.7(5), C40). The SPW Chooz gauge matches Hub'Eau *Île Graviat* (NGF-1884), not Trou du Diable (IGN69), so it cannot test TAW↔IGN69 as proposed. EVRF2019 grids and the BKG EVRS site were not reachable (R6). |
| 9 | Open | – | Design item; listed in §10 R11. |
| 10 | Open | – | Design item; §10 R11. |
| 11 | Open | Proxy status confirms sandbox-specific failures (`server.wver.de`, `evrs.bkg.bund.de`, GitHub HTML 403) | Needs the production VPS (§10 R7). |
| 12 | **Partly resolved** | CTD preview page; DST parser list | CTD confirmed for the documentation site from 5 Nov 2026; no word on API hosts (R4). §0.3 now requires DST fixtures for every offset-less parser before its first run. |
| 13 | **Resolved (rules)** | CAP sizes (max 255 KB, no DTDs), `pegeldaten.zip` unpacked size (128 MB), HIC redirect note, LU-5 download host | §6.7: per-format rules (ZIP, XML, XLSX, CSV, HTML), allowlist additions (incl. **`download.data.public.lu`**, which serves the CAP files), canonical URLs to avoid cross-host redirects. |
| 14 | **Partly resolved** | VMM Kempen stations; RLP forecasts for the Ahr, Kyll, Prüm, Nahe; RWS canal points | (a) VMM covers the Kempen rivers (token-gated); Brabant water-board hubs not checked (R8). (b) RLP permission now in Phase 0; RLP forecasts cover the Ahr, Kyll, Prüm, Nahe. (c) Owner decision (§9 Q32). (e) RWS `smeermaas.zuidwillemsvaart` and `kanne` added to §3.3. |
| 15 | Open | – | Ask BAFU (§10 R5). |
| 16 | Partly | LU-Alert archive (30 MB / 15 months), InfoVigiCru change gate, `pegeldaten.zip` size | Data points in §0.1a and §10 R11; no 48-h measurement made. |
| 17–19 | Open | – | Design items (§10 R11). |
| 20 | **Resolved** | NRW `pegeldaten.zip` downloaded; `hydro/q` listing; LHP alerts schema; BfG schedule page; conditional GETs to HLNUG, NRW, LHP, Vigicrues, Hub'Eau | DE-7 now truly [V]; DE-8 `hydro/q` marked listing-only; DE-6 alerts verified via the test server; FR-4 Loire-only noted in §0.4; LU-3 cadence marked partly verified; WV weekend schedule now [D] and consistent in §2.2 and §3.1; §6.5 conditional-request list corrected (HLNUG ETag+IMS, NRW IMS, LHP ETag → 304; Vigicrues and Hub'Eau none); LU-1 third-party CC0 question added to the AGE e-mail. Owner decisions remain open (§10 R12). |
