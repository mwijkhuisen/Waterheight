# Basemap fixtures

Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL 1.0,
https://www.openstreetmap.org/copyright). The tiles are the Protomaps basemap (https://protomaps.com),
whose rendering of OpenStreetMap is a Produced Work: show the credit "© OpenStreetMap contributors"
wherever these tiles are displayed.

## `lobith-z14.pmtiles`

A small extract around Lobith (51.85 N, 6.10 E), for the Playwright end-to-end tests, the CI deploy
end-to-end run of `basemap promote` and the style tests. Every test runs offline against this file.

| | |
|---|---|
| Source | Protomaps daily build `20261001` (`https://build.protomaps.com/20261001.pmtiles`), tiles version 4.15.2 |
| Made | 2026-10-01 with go-pmtiles 1.31.2 (sha256-checked release binary), 31 HTTP Range requests |
| Command | `pmtiles extract https://build.protomaps.com/20261001.pmtiles lobith-z14.pmtiles --bbox=6.04,51.82,6.16,51.88 --maxzoom=14` |
| Header | spec 3, `mvt`, gzip, z0–14, bounds 6.04,51.82,6.16,51.88, 76 tiles |
| Bytes | 2,803,030 |
| sha256 | `7fd2effdffcdfdf0fe049168b38404fea44298852367852e9a9c8e00c01c54d3` |

`lobith-z14.metadata.json` is its metadata (`pmtiles show --metadata`), including the `vector_layers`
that `test/basemap-style.test.ts` checks every style layer against.

## `planet-z2.pmtiles`

The whole world at z0–2: the tests' stand-in for the production `planet-z6-<build>.pmtiles` (z0–6, 45 MB).

| | |
|---|---|
| Source | Protomaps daily build `20261001`, tiles version 4.15.2 |
| Made | 2026-10-01 with go-pmtiles 1.31.2, 5 HTTP Range requests |
| Command | `pmtiles extract https://build.protomaps.com/20261001.pmtiles planet-z2.pmtiles --maxzoom=2` |
| Header | spec 3, `mvt`, gzip, z0–2, bounds -180,-85.0511287,180,85.0511287, 21 tiles |
| Bytes | 864,227 |
| sha256 | `40edeada75d9551a0f29989a950c7d48e17d8633355a9fc7bfec351be63836c2` |
