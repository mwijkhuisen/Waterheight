# Cross-country comparability and storage architecture: research report

**Run metadata:** research ran on 2026-09-23 from about 20:10 to 20:45 UTC, roughly 35–40 minutes of wall-clock time for this agent. I called every endpoint below with curl through the proxy unless it is marked UNVERIFIED. I did not use any files from the local repository. I ran the benchmarks on this container (4 vCPU, 15 GB RAM) with PostgreSQL 16.13, DuckDB 1.5.5 and chDB 4.4.0 (embedded ClickHouse 26.7.2.1). The benchmark data was synthetic (see the caveats in section B). Afterwards I stopped and deleted the temporary PostgreSQL cluster.

---

## A. Vertical datums and comparability

### A.1 Datum offsets

The table below is anchored on NAP. EVRF2007 is realised on NAP, and EPSG:5425 gives NAP→EVRF2000 as −0.005 m. The offsets for one physical point come from PROJ 9.5.1's `proj.db` (EPSG parameters), which I queried locally with pyproj 3.7.2. I cross-checked them against live data wherever a provider publishes two datums at the same gauge.

| Datum (who uses it) | EPSG | Relation to NAP / EVRF2007 | Evidence |
|---|---|---|---|
| **NAP** (RWS, NL water boards) | 5709 | Reference, 0 | NAP is the datum point of EVRF2007. EPSG:5425 gives NAP→EVRF2000 as −0.005 m. |
| **TAW (NL) = DNG (FR)** (Flanders HIC/VMM, Wallonia SPW, and RWS for 8 Meuse border gauges) | 5710 "Ostend height" | **H_TAW ≈ H_NAP + 2.33 m.** TAW zero is about 2.33 m below NAP zero. | EPSG:5199 Ostend→EVRF2007 is offset −2.317 m plus a latitude slope of −0.031″. Computed by PROJ: Givet 2.307, Eijsden 2.318, Antwerp 2.326, Emmerich 2.336, Coevorden 2.349 m. **Live, same gauge, same instant: RWS Eijsden grens 4637 cm TAW vs 4404 cm NAP = 233 cm. Stevensweert 2331 vs 2098 = 233. HIC Maaseik 23.32 m TAW vs RWS Maaseik 20.99 m NAP = 2.33 m.** DNG and TAW are the same system (NGI; fr.wikipedia "Deuxième nivellement général"). |
| **DHHN2016 / DHHN92, "m ü. NHN"** (PEGELONLINE gauge zeros, Länder) | 7837 / 5783 | H_EVRF2007 = H_DHHN2016 + 0.014 m + slope (EPSG:7838), so **H_NHN ≈ H_NAP − 0.5…2 cm** in the basin (PROJ: Emmerich +0.010, Eijsden +0.016, Coevorden +0.005 m). | proj.db, EPSG:7838 and EPSG:5211. Negligible for display. |
| **DHHN12 "m ü. NN"** (old). 40 PEGELONLINE gauge zeros still use it, and 67 W series report in `m+NN`. | 7699 | NHN − NN ranges from −80 to +42 mm across Germany (mean 4 mm). In NRW it is +55 mm near Aachen and −20 mm in the east. | de.wikipedia "Deutsches Haupthöhennetz"; NRW DHHN info. |
| **NGF-IGN69** (France; Sandre code 3) | 5720 | H_EVRF2000 = H_IGN69 − 0.486 m (EPSG:5419, verified in proj.db). For EVRF2007, BKG's 5-parameter fit has a1 = −0.46998 m. So **H_IGN69 ≈ H_NAP + 0.47–0.49 m.** | EPSG:5419 is verified. The EVRF2007 value came from IGN Circé doc search results; I did not fetch it, so it is **UNVERIFIED-lite**. |
| **NGF-Lallemand 1884** (Sandre code 2) | – | Differs from IGN69 by a spatially variable, decimetre-level amount. | **UNVERIFIED** magnitude. Observed live: Hub'Eau `B720000002` (Chooz Île Graviat) has `altitude_ref_alti_station: 99.0, code_systeme_alti_site: 2`, while the neighbouring `B720000001` has `101.34, code 3`. |
| Swiss LN02 "mü.M." (Basel-Rheinhalle in PEGELONLINE), Austrian "m ü. A." (Danube) | – | Not needed for the NL catchment except Basel. | **UNVERIFIED** offsets |
| RWS `MSL` (18 offshore stations), `PLAATSLR` (23 local-datum stations) | – | Station-specific | Seen in the RWS catalogue |

### A.2 Most readings are relative gauge readings

This is from the live catalogues.

| Provider | What `value` means | Unit | Datum / gauge-zero metadata |
|---|---|---|---|
| PEGELONLINE `W` | Reading above the Pegelnullpunkt (PNP) for 668 series. 67 series are in `m+NN` and 2 in `m+PNP` (canals such as DEK, DHK, MLK). | cm (or m) | `gaugeZero {unit:"m. ü. NHN", value, validFrom}` on 642 of 737 W series. Units: 593 NHN, 40 NN, 8 "m ü. A.", 1 "mü.M.". **95 have no gauge zero**, including 10 RIJKSWATERSTAAT stations such as `LOBITH` and `DORDRECHT`. |
| RWS DDL `WATHTE` | Absolute | cm | `Hoedanigheid` is NAP (690 locations), TAW (8), MSL (18) or PLAATSLR (23) |
| Hub'Eau `observations_tr` H | **Relative:** `code_systeme_alti_serie: 31` means "Système local – hauteur relative" (Sandre nomenclature 76) | **mm** | The station referential has `altitude_ref_alti_station` plus `code_systeme_alti_site` (2 = NGF 1884, 3 = IGN 1969). That this field is the gauge zero is presumed but **UNVERIFIED**. |
| Vigicrues `observations.json` H | Relative (0.06 at Chooz while Hub'Eau shows 60 mm) | **m** | None |
| HIC Flanders KiWIS | Absolute (TAW): Maaseik reads 23.32 | m | Implicit (TAW) |
| Wallonia SPW KiWIS `05-Hauteur.Complet` | Relative (Tabreux: 0.189) | m | Statistics exist in both `.Abs` and `.Rel` forms. Mean.Abs − Mean.Rel = 110.849 − 0.908 = 109.941 m, but P90.Abs − P90.Rel = 109.928 m. **The two differ by 13 mm, which suggests the gauge zero changed during the record.** |

Cross-provider duplicates of the same place do not agree. At 20:00Z, PEGELONLINE `LOBITH` (51.8498 N, 6.1124 E) read 627 cm with no datum, while RWS `lobith.bovenrijn.haven` read 615 cm NAP. They are different physical gauges about 2 km apart. Do not merge them. For each country, prefer the authoritative agency.

### A.3 Why neither raw readings nor absolute heights are comparable (live Rhine example, 20:00Z)

| Gauge (km) | Raw W (cm) | Gauge zero (m NHN) | Absolute (m NHN) | MNW / MW / MHW (cm) | **Index (W−MNW)/(MHW−MNW)** | PEGELONLINE state |
|---|---|---|---|---|---|---|
| Maxau (362) | 285 | 97.721 | 100.57 | 353 / 496 / 785 | **−0.16** | low |
| Kaub (546) | 9 | 67.669 | 67.76 | 65 / 208 / 544 | **−0.12** | low |
| Köln (688) | 54 | 35.038 | 35.58 | 114 / 297 / 725 | **−0.10** | low |
| Düsseldorf (744) | 8 | 24.529 | 24.61 | 70 / 257 / 684 | **−0.10** | low |
| Duisburg-Ruhrort (781) | 137 | 16.106 | 17.48 | 201 / 394 / 835 | **−0.10** | low |
| Emmerich (852) | −7 | 7.998 | 7.93 | 51 / 239 / 669 | **−0.09** | low |
| RWS Lobith haven | 615 cm NAP | – | 6.15 (NAP) | – | – | waterinfo: "Verlaagde waterstand" |

Raw readings range from −7 to 285 cm and absolute heights from 7.9 to 100.6 m, because absolute height mostly reflects bed slope. The normalised index sits between −0.09 and −0.16 along the whole river, and that is the signal a user can "follow downstream". Emmerich is now below its NNW of −1 cm (2022-08-18). Its discharge series stopped on 2026-09-19 with the comment *"Abflussermittlung unter W=-1cm aktuell nicht möglich"*, so discharge disappears exactly at extremes.

### A.4 Reference values published via API

| Provider | Reference values | Call (verified) | Status |
|---|---|---|---|
| **PEGELONLINE** | MNW, MW, MHW (with `timespanStart/End`, e.g. 2010-11-01 to 2020-10-31), NNW and HHW (with `occurrences`), HSW, GlW, Marke I/II/III, and tidal values (MThw etc.). Also `stateMnwMhw` (low/normal/high/unknown/commented/out-dated) and `stateNswHsw`. | `GET https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/EMMERICH.json?includeTimeseries=true&includeCurrentMeasurement=true&includeCharacteristicValues=true` | Verified. Coverage across 737 W series: MW 383, MNW 376, MHW 375, HHW 325, HSW 127. Current state: 356 "unknown", 219 normal, 156 low. |
| **RWS DDL** | None. The catalogue contains only `WATHTE` × {NAP, TAW, MSL, PLAATSLR} and `Q` m3/s. | `POST https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus` | Verified absent |
| **waterinfo.rws.nl** (undocumented SPA backend) | Class label per latest value: "Normale waterstand" (210), "Verlaagde waterstand" (23), "Geen klasse-indeling" (66), plus colour and `possiblyFaulty` (5 true). No numeric thresholds and no history. | `GET https://waterinfo.rws.nl/api/point/latestmeasurement?parameterId=waterhoogte-t-o-v-nap` (213 KB, `Cache-Control: public,max-age=300`) | Verified. **Undocumented, so fragile.** `/api/legend/legend` returned 500. |
| **HIC Flanders** (`hicws.vlaanderen.be`, KiWIS `datasource=4`) | `DrempelPrewaak.O` / `DrempelWaak.O` / `DrempelAlarm.O` (m TAW); day-of-year percentiles `MeetPeriodeDagP10…P99`; `AnalysePeriodeP10…P90`; Q return periods `KalJaarT005…T200`; `AlarmStatusDroogteDag` | `getTimeseriesList&station_no=maa02a-1066` then `getTimeseriesValues&ts_id=123903010,…&from=2022-01-01&to=2026-12-31` | Verified (Maaseik: prewaak 29.30, waak 30.99, alarm 32.00 m TAW). Percentile convention: P10 (24.04) > P90 (23.26), so P-values look like **exceedance** percentiles. **UNVERIFIED** from docs. |
| **VMM waterinfo.be** (`download.waterinfo.be`, `datasource=1`) | `DrempelPrewaak`, `DrempelWaak`, `DrempelPrealarm`, `DrempelAlarm`, `AlarmStatus` series exist | same KiWIS calls | Series exist, but values were **empty** for every sampled station (Melle, Maaseik brooks) |
| **Wallonia SPW** (`hydrometrie.wallonie.be/services/KiWIS`, `datasource=0`) | Long-term `Moyen/Median/P05…P95` in `.Abs` and `.Rel` forms (P90 > mean, so non-exceedance: **the opposite of HIC**); `998-…CrueDeReference.Top3` (e.g. 2021-07-15 4.269 m). A series named `05a-Hauteur.Complet.Alarmes` exists, but its values equal `Complet`. | `getTimeseriesValues&ts_id=240684010,240676010&from=1970-01-01&to=2028-01-01` | Stats verified. **Numeric alert thresholds UNVERIFIED** (not found in KiWIS). The main Meuse stations (Visé, Amay) have **only discharge** (`Débit ultrason`). |
| **Vigicrues** | Vigilance colour per *tronçon* (`NivInfViCr` 1–4; all 337 were 1/green today); per-station `CruesHistoriques` (heights in m). No per-station numeric thresholds. | `GET https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson` (2.2 MB); `GET …/services/station.json/index.php?CdStationHydro=B720000002` | Verified |
| **Hub'Eau** | None in `observations_tr` or `referentiel/stations` fields | – | Verified absent |

### A.5 How to present comparable values honestly

1. **Map colour uses one ordinal "state" scale with explicit provenance:** `no-ref` (grey), `low`, `normal`, `elevated`, `high`, `extreme`. Fill it in this priority order:
   - operational thresholds (HIC prewaak/waak/alarm, Vigicrues tronçon colour, any Länder Meldestufen added later);
   - statistical references (PEGELONLINE MNW/MHW and HHW; Wallonia/HIC percentiles);
   - the provider's own class (waterinfo.rws.nl label).

   Store `state_basis` (for example `PEGELONLINE:MNW/MHW 2010–2020`) and show it in the popup. The legend should say that classes follow each agency's own references and are not strictly equivalent across countries.
2. **The continuous index** `I = (W − MNW)/(MHW − MNW)` applies only where MNW and MHW exist, which is about half of PEGELONLINE. Do not mix it with threshold-based classes on one colour ramp.
3. **"Follow the water" mode (MVP, needs no climatology):** show the *change* since the start of the selected window, `Δh = h(t) − h(t0)`, in cm and as an arrow or size. The datum cancels out, so it works on relative readings in every country from day one.
4. **Discharge (m³/s)** is physically comparable and conserved downstream, so it is the best quantity for the flow story where it exists. Coverage is thinner: PEGELONLINE has 94 Q vs 737 W series and RWS 199 Q locations. Wallonia's Meuse main stem is Q-only. Q drops out at extremes (Emmerich), and some French Q switches sibling station below 40 m³/s. Vigicrues' Chooz event text says *"Les débits inférieurs à 40 m3/s sont calculés à la station Chooz Trou du Diable"*, and Hub'Eau Q came from `B720000001` flagged *"Douteuse"*.
5. **Absolute height** belongs only in the detail view, as "≈ x.xx m NAP (converted from TAW −2.33 m / NHN +0.01 m / IGN69 −0.48 m; ±2 cm)". Always also show the raw value exactly as the provider published it, with unit and datum.
6. **Later phase:** our own day-of-year percentiles once we have at least 1–3 years of data, or earlier via historical backfill.

### A.6 Key excerpts (trimmed)

```json
// PEGELONLINE EMMERICH W
{"shortname":"W","unit":"cm","equidistance":15,
 "currentMeasurement":{"timestamp":"2026-09-23T22:00:00+02:00","value":-7.0,"stateMnwMhw":"low","stateNswHsw":"normal"},
 "gaugeZero":{"unit":"m. ü. NHN","value":7.998,"validFrom":"2019-11-01"},
 "characteristicValues":[{"shortname":"MNW","unit":"cm","value":51.0,"timespanStart":"2010-11-01","timespanEnd":"2020-10-31"},
   {"shortname":"MHW","value":669.0,...},{"shortname":"NNW","value":-1.0,"occurrences":["2022-08-18"]},{"shortname":"HHW","value":986.0,"occurrences":["1926-01-03"]}]}
```
```bash
curl -X POST https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen \
 -H 'Content-Type: application/json' \
 -d '{"LocatieLijst":[{"Code":"eijsden.grens"}],"AquoPlusWaarnemingMetadataLijst":[{"AquoMetadata":{"Compartiment":{"Code":"OW"},"Grootheid":{"Code":"WATHTE"}}}]}'
# -> eijsden.grens TAW cm 2026-09-23T21:00:00.000+01:00 4637  Ongecontroleerd 00
#    eijsden.grens NAP cm 2026-09-23T21:00:00.000+01:00 4404  Ongecontroleerd 00
#    eijsden.grens NAP cm 1978-11-15T08:00:00.000+01:00 4428  Definitief (stale "latest" of another method F009!)
```
```json
// HIC thresholds, Maaseik rkm 52.8/Maas
[{"ts_name":"DrempelAlarm.O","ts_unitsymbol":"m","data":[["2022-12-14T00:00:00.000+01:00",32.0]]},
 {"ts_name":"DrempelWaak.O","data":[["2022-12-14T00:00:00.000+01:00",30.99]]},
 {"ts_name":"DrempelPrewaak.O","data":[["2022-12-14T00:00:00.000+01:00",29.3]]}]
// Hub'Eau H, relative, mm
{"code_station":"B720000002","grandeur_hydro":"H","code_systeme_alti_serie":31,"date_obs":"2026-09-23T20:00:00Z","resultat_obs":60.0,"libelle_statut":"Brute","libelle_qualification_obs":"Non qualifiée"}
// waterinfo.rws.nl
{"locationCode":"lobith.bovenrijn.haven","latestValue":615.0,"dateTime":"2026-09-23T20:00:00Z","possiblyFaulty":false,"unitCode":"cm","qualityCode":"NAP","measurementLabel":"Verlaagde waterstand"}
```

---

## B. Storage

### B.1 Volume

Rows per series per year: 35,040 at 15 min, 52,560 at 10 min.

| Scenario | Rows/yr | Rows after 5 yr | Rows after 10 yr |
|---|---|---|---|
| A: 2,000 series @15 min | 70 M | 350 M | 0.70 B |
| B: 3,000 @ mixed (~120/day) | 131 M | 657 M | 1.31 B |
| C: 4,000 @10 min | 210 M | 1.05 B | 2.10 B |

French and Walloon sources deliver every 5 minutes (Hub'Eau and Wallonia 5-min steps observed). Storing them natively multiplies their rows by 2–3. For scale, PEGELONLINE alone says it publishes about 630,000 values per day across all parameters (ITZBund).

Sizes use the measured bytes per row from B.2. Columnar figures are shown as synthetic × 2–4 to allow for real data.

| Engine | Bytes/row | A: 1 / 5 / 10 yr | C: 1 / 5 / 10 yr |
|---|---|---|---|
| Plain PG, narrow rows + PK | ~94 | 6.6 / 33 / 66 GB | 19.8 / 99 / 198 GB |
| Plain PG hourly rollup (~100 B/row, series×8,760/yr) | – | +1.75 GB/yr | +3.5 GB/yr |
| TimescaleDB compressed (not benchmarked) | ~5–10 (vendor claims 90%+) | 0.4–0.7 GB/yr | 1–2 GB/yr — **UNVERIFIED** |
| DuckDB file | 3.2 measured (6–10 real) | 0.2–0.7 GB/yr | 0.7–2 GB/yr |
| ClickHouse MergeTree | 0.69 measured (1.5–3 real) | 0.1–0.2 GB/yr | 0.15–0.6 GB/yr |
| Parquet (zstd) archive | 1.1–1.4 measured | – | – |

Even the worst case (scenario C, plain PG) is about 23 GB per year. That fits one modest VM, so compression is an optimisation, not a requirement, for the first 2–3 years.

### B.2 Benchmark (17.86 M rows = 3,000 series × 62 days × 15 min, inserted time-major like real ingestion)

The synthetic values are a sinusoid plus ±1 noise, rounded. Real series will compress 2–4× worse in columnar engines (estimate, **UNVERIFIED**).

| Test | PostgreSQL 16 | DuckDB 1.5.5 | ClickHouse (chDB) |
|---|---|---|---|
| Storage | heap 52.2 B/row + PK 41.9 B/row; BRIN(ts) 80 kB per 8.9 M-row partition | 3.2 B/row | 0.69 B/row (`value` Gorilla+ZSTD = 0.67) |
| Every series at time T (3 h window) | **LATERAL: 15.9 ms**; with per-series staleness: 20.3 ms; DISTINCT ON without BRIN: 173 ms, with BRIN: 19.8 ms | 9.4 ms (`arg_max`) | 38 ms (`argMax`) |
| One series, 62 days raw (5,952 points) | 10.1 ms | – | – |
| One series, 62 days as 3-h min/max/avg on the fly | 9.6 ms | 26 ms | 4.5 ms |
| Same from the hourly rollup table | 0.6 ms | – | – |
| All 3,000 series × 72 hourly frames (animation) | 160 ms; 370 KB gzip JSON | – | – |
| Idempotent upsert of a 12k-row batch | 127 ms; re-run is a no-op (0 rows) in 28 ms | – | – |

### B.3 Engine comparison

| | License | Fit |
|---|---|---|
| **PostgreSQL + native partitioning + BRIN** | PostgreSQL License | Runs anywhere, including every managed PG. Upserts and revisions are easy, and point-in-time queries are fast. Storage is about 94 B/row, and rollups are hand-maintained. **Recommended for the MVP.** |
| **TimescaleDB** | Apache-2 core has hypertables, `time_bucket`, `first/last`. The **TSL "Community" edition** adds columnstore/compression (`add_columnstore_policy`), continuous aggregates, `add_retention_policy`, `time_bucket_gapfill`/`locf`, SkipScan and the job scheduler. TSL is free to self-host but "you cannot sell … as a service". | The simplest upgrade path when volume matters. Most managed PG services ship only the Apache edition, which lacks compression and continuous aggregates. Updating compressed chunks (for example, provisional values later validated) works but costs more. |
| **ClickHouse** | Apache-2 | Best compression and scan speed. `ReplacingMergeTree(batch_id)` gives idempotency, but dedupe happens at merge time (`FINAL`/`argMax` needed). It is one more system to operate. Overkill below about 1 B rows. |
| **DuckDB / SQLite** | MIT / public domain | Single-writer, embedded. Good for offline analytics over Parquet archives and static exports. Not suited to a concurrent public API that is also being ingested into. |

### B.4 Schema (plain PostgreSQL)

```sql
CREATE TABLE series (
  series_id        integer PRIMARY KEY,
  station_id       integer NOT NULL REFERENCES station,
  quantity         char(1) NOT NULL CHECK (quantity IN ('H','Q')),
  provider_key     text    NOT NULL,           -- e.g. PEGELONLINE uuid+'W', RWS code+hoedanigheid, KiWIS ts_id
  native_unit      text    NOT NULL,           -- 'cm','m','mm','m3/s','l/s','m+NN'
  to_canonical     double precision NOT NULL,  -- H -> cm, Q -> m3/s (e.g. mm: 0.1, m: 100, l/s: 0.001)
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

Value storage choices:
- `real` (float4) is enough: 110.849 m and 12,000.0 m³/s both fit within 7 significant digits.
- H is stored in cm and Q in m³/s.
- Keep the datum on the series, not the row.

### B.5 Key queries

**1. Every station at time T, taking the last observation at or before T within its staleness window.** This is the measured 20 ms plan. Runtime partition pruning worked: the older partition was "never executed".

```sql
PREPARE at_t(timestamptz, float8, float8, float8, float8) AS
SELECT s.series_id, o.ts, o.value, o.qc, $1 - o.ts AS age
FROM series s
JOIN station st USING (station_id)
CROSS JOIN LATERAL (
  SELECT ts, value, qc FROM obs
  WHERE obs.series_id = s.series_id
    AND ts <= $1 AND ts > $1 - s.staleness_limit
  ORDER BY ts DESC LIMIT 1) o
WHERE s.active AND st.lon BETWEEN $2 AND $4 AND st.lat BETWEEN $3 AND $5;
```

For "now", keep `obs_latest(series_id PK, ts, value, qc)` updated during ingest, or run the same query with T = now().

**2. One station between A and B at a suitable resolution**, aiming for at most about 3,000 points:

```sql
-- span <= 14 d : raw
SELECT ts, value, qc FROM obs WHERE series_id=$1 AND ts >= $2 AND ts < $3 ORDER BY ts;
-- span <= 180 d: hourly (min/max band + avg line)
SELECT bucket, vmin, vmax, vavg FROM obs_1h WHERE series_id=$1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket;
-- longer      : daily
SELECT bucket, vmin, vmax, vavg FROM obs_1d WHERE series_id=$1 AND bucket >= $2 AND bucket < $3 ORDER BY bucket;
```

**3. Incremental rollup after each batch.** This touches only the (series, hour) pairs that the batch changed:

```sql
INSERT INTO obs_1h (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
SELECT o.series_id, date_bin('1 hour', o.ts, timestamptz '2000-01-01Z') b,
       min(value), max(value), avg(value), (array_agg(value ORDER BY ts DESC))[1], count(*), bit_or(qc)
FROM obs o
JOIN (SELECT DISTINCT series_id, date_bin('1 hour', ts, timestamptz '2000-01-01Z') b FROM staging) t
  ON o.series_id = t.series_id AND o.ts >= t.b AND o.ts < t.b + interval '1 hour'
GROUP BY 1, 2
ON CONFLICT (series_id, bucket) DO UPDATE SET vmin=EXCLUDED.vmin, vmax=EXCLUDED.vmax, vavg=EXCLUDED.vavg,
  vlast=EXCLUDED.vlast, n=EXCLUDED.n, qc_or=EXCLUDED.qc_or;
```

The TimescaleDB equivalent is `CREATE MATERIALIZED VIEW obs_1h WITH (timescaledb.continuous) AS SELECT series_id, time_bucket('1 hour', ts) bucket, min(value), max(value), avg(value), last(value, ts) FROM obs GROUP BY 1,2;` plus `add_continuous_aggregate_policy('obs_1h', start_offset => INTERVAL '40 days', end_offset => INTERVAL '10 min', schedule_interval => INTERVAL '15 min')`, which is TSL. The start offset of 40 days or more covers late revisions.

**4. Animation frames.** Query `obs_1h` for all series over the window (160 ms for 3,000 × 72). Align the missing buckets in application code, and send a compact array per series (370 KB gzip). Cache aggressively, because windows older than 48 hours are nearly immutable.

**Retention and maintenance.**
- Create partitions monthly with a cron job or pg_partman.
- After 12–24 months, optionally `DETACH` old partitions and export them to Parquet (1.1–1.4 B/row) while keeping `obs_1h` and `obs_1d` in PG permanently.
- Run `REINDEX` on closed partitions. B-tree fill after time-major inserts is about 42 B/row; a rebuild should bring it to about 31 B/row (estimate).

---

## C. Ingestion design

### C.1 Per-source behaviour observed around 20:10–20:30 UTC

| Source | Step | Observed lag | Cache / conditional | Time format seen | History via API | Suggested poll |
|---|---|---|---|---|---|---|
| PEGELONLINE `stations.json?timeseries=W&includeTimeseries=true&includeCurrentMeasurement=true` | 15 min (some 1/5/10/60) | ~12 min | `max-age=33–48`; **ETag + `If-None-Match` gives 304 (verified)**; 622 KB raw, 57 KB gzip | `2026-09-23T22:00:00+02:00` (local offset); CSV is local time without offset | 31 days (`/measurements.json?start=P31D`) | Every 5 min with ETag, plus per-series catch-up (`start=PT6H`) when gaps appear |
| RWS DDL `OphalenLaatsteWaarnemingen` / `OphalenWaarnemingen` (POST) | 10 min | ~14 min | none (POST) | **`2026-09-23T21:00:00.000+01:00`, fixed UTC+1 even in summer** | decades | Every 10 min with a 3 h window |
| waterinfo.rws.nl `latestmeasurement` | 10 min | ~13 min | `max-age=300` | `…Z` (JSON); the chart CSV uses "Tijd (NL tijd)" without offset | latest only | Every 15 min, for class labels only |
| Hub'Eau `observations_tr` | 5 min | ~15 min | none; **responds `206 Partial Content`** when paginated; `Link` rel=next cursor | `…Z` | 1 month ("maintient un historique d'un mois") | Every 10–15 min with `date_debut_obs = last − 2h`; `size` ≤ 20000 |
| Vigicrues `observations.json` | 5 min | – | `max-age=120`; `/services/x.json/?` answers **302** to `index.php` | `+00:00` | about 66 days (returns **the whole window: 865 KB per station**, no size limit seen) | Avoid for bulk. Use Hub'Eau for observations and Vigicrues `InfoVigiCru.geojson` every 15–30 min. |
| HIC KiWIS | 15 min | ~13 min | `max-age=60`; `Last-Modified` equals the request time; **`If-Modified-Since` still returns 200** | `+02:00` by default; **`&timezone=UTC` gives `…Z` (verified)**; daily values stamped `01:00+02:00` (UTC+1 midnight) | since the 1970s | Every 15 min, with several comma-separated `ts_id` per call, `period=PT3H` |
| VMM KiWIS | 15 min | – | `no-cache` | `+02:00` | since 2023 for the sampled stations | Every 15 min |
| Wallonia KiWIS | 5 min | ~17 min | `max-age=300` | `+02:00` | since 1976 | Every 15 min |

Only PEGELONLINE supports conditional GETs. For every other source, deduplicate on the ingest side: hash each response body and skip it if the hash is unchanged.

KiWIS wildcard list calls are slow. `getTimeseriesList&ts_name=Drempel*` **timed out at more than 60 s**, and a `station_name=Maaseik*` list took 16 s. Cache the metadata daily and never run wildcard listings on the hot path.

### C.2 Poll loop

- **Overlap window.** Each poll re-fetches the last 2–6 hours. The upsert is idempotent (`ON CONFLICT … DO UPDATE … WHERE (o.value,o.qc) IS DISTINCT FROM (EXCLUDED.value,EXCLUDED.qc)`), so re-polls cost nothing (measured no-op above). When the old row differs, write it to `obs_revision` first, using a CTE or trigger.
- **Backoff.** Use exponential backoff with full jitter: base 30 s, cap 30 min, and honour `Retry-After`. After 5 consecutive failures, open a per-host circuit breaker and fall back to a 30-min probe. Limit concurrency per host to 2–4. Timeouts: connect 10 s, total 60 s, and 120 s for metadata calls.
- **Provenance.** Store each response body zstd-compressed in object storage under `sha256`, and link it from `ingest_batch`. Every `obs` row carries `batch_id`. Keep raw payloads for 30–90 days; after that, the normalised rows plus daily Parquet are the archive. PEGELONLINE alone is about 57 KB × 288 polls/day, or roughly 6 GB/yr gzip, if every 5-min snapshot is kept, so deduplicate 304s and unchanged hashes.
- **Metadata refresh.** Refresh stations, reference values and gauge zeros daily. Version them with `valid_from`, because gauge zeros change (for example, `validFrom 2019-11-01` at Emmerich).

### C.3 UTC and DST

- Parse every timestamp with its offset and store `timestamptz` in UTC.
- Never parse local-time CSV (PEGELONLINE CSV, the waterinfo.rws chart CSV) without a timezone database. On **2026-10-25 01:00Z** the local hour 02:00–02:59 occurs twice.
- The RWS "+01:00 all year" convention is correct once offset-parsed, but it will fool anyone who drops the offset.
- Align rollups on UTC, and document that provider daily means (KiWIS `DagGem` at 00:00 UTC+1) differ from ours.
- Reject timestamps more than 15 min in the future.

### C.4 Units (all verified live)

| Source | H | Q | Canonical factor |
|---|---|---|---|
| PEGELONLINE | cm (some `m+NN`, `m+PNP`) | m³/s | ×1; for `m+NN` ×100 with datum=NN |
| RWS | cm | m3/s (there is also `m3/d` Sommatie; ignore it) | ×1 |
| Hub'Eau | **mm** | **l/s** (17300 l/s = Vigicrues 17.3 m³/s) | ×0.1; ×0.001 |
| Vigicrues | **m** | m³/s | ×100; ×1 |
| KiWIS HIC/VMM/SPW | m | m³/s | ×100; ×1 |

Unit parsing and scale belong in `series.native_unit/to_canonical`, set during metadata review, never guessed per row.

### C.5 Quality, stale and frozen data

- **Provider flags to map into the `qc` bitmask.** Bits: 1 = provisional/raw, 2 = validated, 4 = provider-suspect, 8 = estimated, 16 = our range check, 32 = our spike check, 64 = our flatline check.
  - PEGELONLINE: everything is `ROHDATEN`; a `comment` object signals disruption.
  - RWS: `Statuswaarde` is Ongecontroleerd, Gecontroleerd or Definitief; `Kwaliteitswaardecode` 00 is normal. Code 25 appeared on TAW values on 2025-11-27; its meaning is **UNVERIFIED**.
  - waterinfo.rws: `possiblyFaulty`.
  - Hub'Eau: `libelle_statut` "Brute", `libelle_qualification_obs` "Non qualifiée" or "Douteuse", `code_methode_obs`.
  - KiWIS: numeric `Quality Code` whose scheme differs per instance (HIC 111, VMM 100 "GoodExt", SPW 200). Map them per provider; the DOV wiki page "Kwaliteitsvlaggen hydrometrie-data HIC en VMM" documents HIC and VMM.
- **Stale.** Compute at query time with `age = T − ts`. Show a badge when the age exceeds `max(3 × expected_step, 45 min)`, and drop the station from the map after 25 h (the PEGELONLINE convention). Live: 10 of 737 PEGELONLINE W series were more than 1 h old, 3 more than 25 h, 1 more than 7 days.
- **RWS "latest" trap.** `OphalenLaatsteWaarnemingen` returns ancient "latest" values for other method variants (1978, 1993, 2018). Filter on `ProcesType=meting`, the expected `WaardeBepalingsMethode` (F007 "gemiddelde over vorige 5 en volgende 5 minuten") and a recent timestamp.
- **Frozen sensor.** Flag it when the value is unchanged for 12 h or more *and* a hydraulically linked neighbour moved by more than 5 cm. A flat line alone is not enough: Emmerich stayed at −7 cm for hours legitimately, and weir-regulated Meuse and Moselle reaches can stay flat for days.
- **Spike.** Flag a jump larger than a physical rate (for example 50 cm per 15 min on the main rivers) that reverts within 2 steps.
- **Discharge gaps.** Q can switch station or stop at extremes (Emmerich, Chooz). Model sibling stations explicitly.

---

## D. Security baseline

### D.1 Fetchers and SSRF

- Build URLs only from a static per-source config. No user input ever reaches a fetcher.
- Allowlist these hosts at the egress firewall or proxy: `www.pegelonline.wsv.de`, `ddapi20-waterwebservices.rijkswaterstaat.nl`, `waterinfo.rws.nl`, `hubeau.eaufrance.fr`, `www.vigicrues.gouv.fr`, `hicws.vlaanderen.be`, `download.waterinfo.be`, `hydrometrie.wallonie.be`.
- Handle redirects manually and follow them only to the same host. Vigicrues legitimately returns a 302 to `index.php`.
- After DNS resolution, reject private, loopback and link-local addresses.
- Cap response size at 25 MB (the largest seen is the 2.2 MB RWS catalogue or Vigicrues GeoJSON), cap decompressed size to guard against gzip bombs, and keep the timeouts from C.2.
- Accept JSON only. If XML is ever used, parse it with `defusedxml`.
- Validate payloads with a schema (pydantic/zod) and reject unknown units or datums.

### D.2 Public API input validation

A Python sketch; the same rules apply in any stack.

```python
T_MIN = datetime(2026, 11, 1, tzinfo=UTC)          # go-live
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

- Series IDs must be integers, at most 50 per request, with at most 20k rows per response.
- Queries use parameters only.
- The DB role for the web tier:

```sql
CREATE ROLE web LOGIN;
GRANT SELECT ON ... TO web;
ALTER ROLE web SET default_transaction_read_only = on;
ALTER ROLE web SET statement_timeout = '2s';
```

  Put pgbouncer in front with a pool of about 20. The ingest role is separate and never reachable from the web tier.

### D.3 Rate limiting and caching

- Nginx: `limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s; limit_req zone=api burst=40 nodelay; limit_conn perip 20;`. Return 429 with `Retry-After`.
- `/map?t=now` → `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
- Quantised `t` within 48 h → `s-maxage=600`.
- Older `t` → `s-maxage=86400, stale-while-revalidate=604800`. Purge on revisions, or accept a staleness of up to a day.
- Serve animation frames as static files regenerated every 10 min.
- With the CDN in front, most requests never reach the DB.

### D.4 CSP for the map page

MapLibre's documentation requires `worker-src 'self'` and `img-src data: blob: 'self'`. If `blob:` workers are disallowed, it says to set the worker URL to a same-origin file.

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data: blob: https://tiles.example.org; connect-src 'self' https://tiles.example.org;
  worker-src 'self' blob:; child-src blob:; font-src 'self'; object-src 'none'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

- Self-host maplibre-gl (no third-party script CDN, or use SRI).
- `style-src 'self'` without `'unsafe-inline'` should work because MapLibre styles via the CSSOM. Confirm in staging (**UNVERIFIED**).
- Keep the Referer header: `no-referrer` breaks the OSM tile policy.
- The **OSM tile policy** requires visible "© OpenStreetMap contributors" attribution, a unique User-Agent, a valid Referer, no prefetching or bulk download, and caching of at least 7 days. It explicitly says capacity is limited and heavy users may be blocked. For a public site, use a commercial or sponsored tile provider, or self-host vector tiles (for example, PMTiles on our CDN). A live tile check returned `cache-control: max-age=525986`.

### D.5 Supply chain and secrets

- Use lockfiles with `npm ci --ignore-scripts` and `pip install --require-hashes`.
- Run Renovate with `minimumReleaseAge ≥ 3 days`, plus `npm audit signatures`.
- Pin GitHub Actions to commit SHAs and container images to digests; use distroless or minimal images.
- Generate an SBOM (syft), and use Dependabot or OSV alerts.
- Prefer few front-end dependencies: MapLibre plus a small chart library.

Secrets:
- **waterinfo.vlaanderen.be asks for token access for automated querying for both HIC and VMM.** Anonymous access limits the number of requests and values. Register early and keep the tokens in a secret manager or env injection, never in the repo.
- PEGELONLINE, RWS, Hub'Eau, Vigicrues and Wallonia needed no key in these tests.
- The remaining secrets are the DB credentials and a CDN purge token. Rotate them and scope them per service.

### D.6 Licences and attribution to display

| Source | Licence | Attribution |
|---|---|---|
| PEGELONLINE | DL-DE→Zero-2.0 since 2024 | Not required; credit is courteous |
| RWS | CC0 | Not required; do not imply government endorsement |
| Vigicrues | Etalab 2.0 (per its API page) | Credit required |
| Hub'Eau | Presumably Etalab 2.0 | **UNVERIFIED** |
| Wallonia SPW | "Sources des données : SPW", with a link to hydrometrie.wallonie.be | **Commercial or advertising use needs prior authorisation** |
| waterinfo.be / HIC | Specific licence text not found | **UNVERIFIED** |

---

## E. UNVERIFIED items

1. Hub'Eau `altitude_ref_alti_station` is presumed to be the gauge zero.
2. The NGF-1884 vs IGN69 offset magnitude.
3. The NGF-IGN69→EVRF2007 value of −0.470 m came from search results; EVRF2000's −0.486 m is verified.
4. Swiss and Austrian offsets.
5. Wallonia numeric alert thresholds.
6. VMM thresholds are empty for the sampled stations only; others may have values.
7. RWS numeric alarm or normal levels: none found; waterinfo.rws.nl exposes class labels only, through an undocumented API.
8. The meaning of RWS quality code 25.
9. The HIC and Wallonia percentile conventions, inferred from values.
10. The PEGELONLINE `LOBITH` datum (627 cm is presumably NAP).
11. TimescaleDB compression ratio and ClickHouse on real data (the benchmarks were synthetic).
12. Whether MapLibre works without `'unsafe-inline'` styles.
13. Licences for Hub'Eau and waterinfo.be.

---

## Recommendation for phase planning

**MVP**
- Store raw readings in canonical units with datum metadata.
- Plain PostgreSQL 16/17 with monthly partitions, a `(series_id, ts)` primary key, BRIN on `ts`, `obs_latest`, and hand-rolled `obs_1h`/`obs_1d` rollups. Worst case is about 23 GB/yr, the queries measured 1–20 ms, and there is no licence or hosting lock-in.
- Ingest from PEGELONLINE (ETag), RWS DDL, Hub'Eau, HIC/VMM KiWIS (register tokens) and Wallonia KiWIS. Use overlap windows, idempotent upserts, the `ingest_batch` provenance table, raw payloads kept 30–90 days, UTC normalisation, and unit tables.
- Map colour uses the provider-derived state class: PEGELONLINE `stateMnwMhw` and MNW/MHW, HIC thresholds, Vigicrues tronçon colour, waterinfo.rws labels. Stations with no reference show a neutral "no reference" marker.
- The "follow the water" animation uses **Δh since the window start** (datum-free and available from day one), plus Q where it exists.
- Stale and frozen checks as in C.5.
- The security baseline in D.
- Non-OSM-hosted tiles.

**Later**
- TimescaleDB (TSL, self-hosted) or a Parquet/ClickHouse archive once raw data exceeds about 50 GB, likely in year 2–3.
- Historical backfill: HIC and Wallonia go back to the 1970s, RWS decades, PEGELONLINE only 31 days, Hub'Eau `observations_tr` one month.
- Our own day-of-year percentile climatology once we have a year or more of data or a backfill.
- German Länder flood-warning levels (Meldestufen), not researched here.
- Absolute-height profiles along the river converted to EVRF2007/NAP.
- Forecasts from Vigicrues `previsions.json` and RWS.

**Risks**
1. Reference coverage is patchy: about 51% of PEGELONLINE W series have MNW/MHW, RWS has no numeric levels, VMM's are empty and Wallonia's are unknown. Many markers will be grey unless Δ-mode is the default.
2. waterinfo.rws.nl is undocumented and can change without notice.
3. The Flemish token requirement and Walloon commercial-use restriction.
4. Datum metadata drifts: gauge zeros change (`validFrom`), and there is the 13 mm Abs/Rel inconsistency in Wallonia.
5. Cross-provider duplicate stations with different values (Lobith: 627 vs 615 cm).
6. Discharge disappears at extremes (Emmerich Q stopped when W < −1 cm).
7. Mixed time conventions: RWS fixed +01:00, local-time CSVs, the KiWIS UTC+1 day boundary. DST change on 2026-10-25.
8. OSM tile policy blocking under load.
9. KiWIS metadata calls can take more than 60 s, so they need caching and off-path refresh.

---

**Sources**
- [PEGELONLINE REST API documentation](https://www.pegelonline.wsv.de/webservice/dokuRestapi) · [PEGELONLINE help: characteristic values](https://pegelonline.wsv.de/gast/hilfe) · [ITZBund: DL-DE Zero 2.0 for PEGELONLINE](https://www.itzbund.de/SharedDocs/Pressemitteilungen/DE/2024/2024-06-14_Pegelonline-DL-DE-Zero.html)
- [Rijkswaterstaat waterdata (CC0)](https://rijkswaterstaatdata.nl/waterdata/) · [waterinfo.rws.nl](https://waterinfo.rws.nl/)
- [Hub'Eau Hydrométrie API](https://hubeau.eaufrance.fr/page/api-hydrometrie) · [Sandre nomenclature 76: altimetric systems](http://id.eaufrance.fr/nsa/76) · [Vigicrues API v1.1](https://www.vigicrues.gouv.fr/services/v1.1)
- [waterinfo.be open data FAQ (tokens)](https://waterinfo.vlaanderen.be/default.aspx?path=Public%2FOver+waterinfo%2FFAQ+open+data) · [DOV: HIC/VMM quality flags](https://www.milieuinfo.be/confluence/display/DDOV/Kwaliteitsvlaggen+hydrometrie-data+HIC+en+VMM) · [Hydrométrie Wallonie: conditions d'utilisation](https://hydrometrie.wallonie.be/conditions-dutilisation.html)
- [NGI: Tweede Algemene Waterpassing](https://ngi.be/tweede-algemene-waterpassing/) · [nl.wikipedia: TAW](https://nl.wikipedia.org/wiki/Tweede_Algemene_Waterpassing) · [fr.wikipedia: Deuxième nivellement général](https://fr.wikipedia.org/wiki/Deuxi%C3%A8me_nivellement_g%C3%A9n%C3%A9ral) · [de.wikipedia: Deutsches Haupthöhennetz](https://de.wikipedia.org/wiki/Deutsches_Haupth%C3%B6hennetz)
- [EPSG:7838 DHHN2016→EVRF2007](https://epsg.io/7838) · [EPSG:5419 NGF-IGN69→EVRF2000](https://epsg.io/5419) · [EPSG:5198 Ostend→EVRF2000](https://epsg.io/5198) · [BKG EVRS](https://evrs.bkg.bund.de/Subsites/EVRS/EN/RealizationofEVRS/EVRF2019/evrf2019.html)
- [TimescaleDB editions (Tiger Data)](https://www.tigerdata.com/docs/about/latest/timescaledb-editions) · [MapLibre GL JS docs (CSP)](https://maplibre.org/maplibre-gl-js/docs/) · [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)