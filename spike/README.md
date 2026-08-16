# Phase 1 spike — sizing the Rijkswaterstaat backfill

Throwaway script that probes the live WaterWebservices (WADAR / `ddapi20`) and the
OGC WFS, dumps every raw response to `fixtures/`, and prints the numbers that decide
the backfill scope.

## Run

```sh
node spike/phase1-spike.mjs                 # full run (catalogue call can take minutes)
node spike/phase1-spike.mjs --skip-catalogue
node spike/phase1-spike.mjs --sample 25     # more locations in the count sample
node spike/phase1-spike.mjs --out fixtures  # output dir (default: fixtures)
```

No dependencies; needs Node >= 18. Environment overrides: `RWS_API_BASE`,
`RWS_WFS_URL`, `RWS_API_KEY` (a dummy value is sent by default, as RWS requests),
`ACTIVE_WINDOW_DAYS` (default 7).

## What it measures

1. **`OphalenCatalogus`** — wall-clock time (documented as slow), size, and the
   inventory of quantities (`Grootheden`) and compartments.
2. **WFS `GetCapabilities`** — whether GeoJSON output is offered (preferred over CSV).
3. **WFS `locaties`** — count of *all* water-management locations.
4. **WFS `locatiesmetlaatstewaarneming`** — the authoritative layer for this app:
   row count, unique locations, discovered field names (dumped as a sample-feature
   fixture), and a freshness histogram with the 7-day active cut-off.
5. **Bulk service probe** — whether `AanvragenBulkWaarnemingen` survived the WADAR
   migration (404 = gone, fall back to chunked `OphalenWaarnemingen`).
6. **`OphalenAantalWaarnemingen`** (`Groeperingsperiode: "Maand"`, trailing 12 full
   months, bounded at 4 concurrent requests) on a deterministic sample of active
   locations — real per-month point counts, projected to the full active population:
   total rows, uncompressed disk size, and wall-clock download estimate.

Everything lands in `fixtures/`, including `phase1-report.json` with the raw numbers
behind the printed summary. The sample-feature and `OphalenAantalWaarnemingen`
fixtures double as the ground truth for the Phase 2 normalisers.

## Network requirements

The script needs outbound HTTPS to:

- `ddapi20-waterwebservices.rijkswaterstaat.nl`
- `geo.rijkswaterstaat.nl`

In a sandboxed Claude Code environment these hosts must be on the network egress
allowlist, otherwise every call fails with a proxy 403 ("Host not in allowlist").
The script degrades gracefully: it records each failure in the report and continues
with whatever it can still reach.
