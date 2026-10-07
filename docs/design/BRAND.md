# Rivierkijker — brand pack

The owner's design document (issue #90, 2026-09-29) as the repository applies it (P10c, PHASES §31, D23). The design document is the source; this file says where each part lives in the code and what the code checks.

## 1. Name and language

- The public name is **Rivierkijker**, the same on the Dutch and the English site; there is no English brand name. The repository, the packages, the user agent (`rivierstanden/…`) and the internal host names keep their names.
- The name is always set in two colours: "Rivier" in Rivierblauw and "kijker" in Waterblauw (on Rivierblauw: Naamaccent op donker). In running text: Rivierkijker, one word with a capital R.
- Every text on a site is in that site's language: Dutch at `/`, English under `/en/`.

## 2. Texts (Paraglide, `apps/web/messages/{nl,en}.json`)

| Key | Dutch | English |
|---|---|---|
| `heading` (the name; the page-title suffix) | Rivierkijker | Rivierkijker |
| `name_lead` / `name_accent` (the two colours) | Rivier / kijker | Rivier / kijker |
| `site_title` (the map's `<title>`) | Rivierkijker – Waterstanden en afvoer naar Nederland | Rivierkijker – River levels & discharge to the Netherlands |
| `subtitle` (under the name) | Waterstanden en afvoer van de rivieren naar Nederland | River levels & discharge on their way to the Netherlands |
| `meta_description` | Rivierkijker toont bijna-realtime waterstanden en afvoer van de rivieren die Nederland binnenstromen, met verwachtingen en waarschuwingen waar beschikbaar. Kies zelf datum en tijd. | Rivierkijker shows near-real-time river levels and discharge for the rivers flowing into the Netherlands, with forecasts and warnings where available. Pick any date and time. |

Every other page's title is `<page> · Rivierkijker`. The short text for cards and the repository's About: "Kijk mee met de rivieren richting Nederland." / "Watch the rivers heading for the Netherlands."

**The meta description is softened** (owner, 2026-10-06). The document's text claims "verwachtingen en alarmniveaus" for every river. Per `docs/plan/` the public site shows official forecasts for NL (NL-1) and CH (CH-4), FR (FR-4) only during events, none for DE, LU or BE; warning classes for DE (DE-6), FR (FR-5) and CH (CH-5), display classes for NL, LU-5 CAP messages for LU and nothing for BE. Hence "where available". The `intro` text and the README say the same.

## 3. Colours (`apps/web/src/styles/base.css`)

The only brand hex values in CSS are the tokens in `base.css`; the logo SVGs (`features/layout/Logo.tsx`, `public/favicon.svg`) carry their own. `apps/web/test/brand.test.ts` checks the values, the contrasts below and that no signal colour is a brand colour.

| Token | Name | Hex | Use | Contrast (tested minimum) |
|---|---|---|---|---|
| `--ink` | Rivierblauw | #0E3A4B | text, "Rivier", the subtitle; the footer background | 10.8:1 on `--paper` (≥ 10) |
| `--water` | Waterblauw | #1A7F96 | "kijker", the iris; **large text (from 24 px) and graphics only** | 4.1:1 on `--paper` (≥ 3, and < 4.5 by test) |
| `--paper` | Gebroken wit | #F4F1EA | background; text on Rivierblauw | 10.8:1 on `--ink` (≥ 10) |
| `--accent` | Link | #17738A | links and small accent text on the light background | 4.8:1 (≥ 4.5) |
| `--accent-ink` | – | #F4F1EA | text on `--accent` | ≥ 4.5 |
| `--muted` | Secondary text | #46606B | secondary text | 5.9:1 (≥ 4.5) |
| `--water-dark` | Waterblauw op donker | #4FB3C9 | the iris on Rivierblauw | 5.0:1 on `--ink` (≥ 3) |
| `--name-dark` | Naamaccent op donker | #7CCADB | "kijker" and links on Rivierblauw (the footer) | 6.6:1 on `--ink` (≥ 4.5) |
| `--line` | – | #C9C3B6 | borders: a warm neutral, decorative | – |
| – | Lichtwater | #8FD0DE | the wave line in the mark only, never text | 1.5:1 |
| – | Wit | #FFFFFF | the highlight in the pupil only | – |

The focus ring stays #1D4ED8 (≥ 3:1 on the off-white); on the footer it is `--name-dark`. There is no dark mode yet: add it with the dark tokens when wanted.

## 4. Logo

- **Mark:** an eye (almond outline), a Rivierblauw pupil, a Waterblauw water half with a wave as its top edge, a Lichtwater wave line and a white highlight. viewBox `0 0 96 96`. The drawings were taken from the document's canvas, artboard "icoon en formaten":
  - 64 px and larger (`Logo variant="light"`; P10e: the top bar shows it at 32 px, the same drawing scaled): outline 5, pupil r 16, wave line 2.5, highlight;
  - 32 px: outline 6, wave line 3, no highlight (the separate drawing is still not used);
  - 16 px (`public/favicon.svg`): outline 9, pupil r 18, water without wave line or highlight;
  - dark (`Logo variant="dark"`): outline and pupil Gebroken wit, water #4FB3C9, highlight Rivierblauw. Since P10e (§9) the slim page footer is Rivierblauw but has no logo, so the 40 px use is gone and nothing renders this variant today.
- **Lockup on the site:** the mark, then the name as live HTML text in Bricolage Grotesque (two colours), the subtitle under it in Source Sans 3. No outlined lockup SVG and no DM Sans are needed on the site; the mark is decorative (`aria-hidden`), the text is the name.
- **Favicon:** `/favicon.svg` only, linked from the four HTML shells, served by Caddy's `@file` with `no-cache`. There is no `/favicon.ico` (it stays a bare 404, as `routes.spec.ts` and verify-prod assert).
- **Not yet:** the app-icon PNGs and a web manifest (add them when home-screen install is wanted), the outlined lockup exports (owner).
- **Do:** the light variant on the off-white (the bar), the dark one on Rivierblauw; the mark only on a solid background. **Don't:** Waterblauw for small text; the name in one colour; stretch the mark or add shadows; the mark straight on the map.

## 5. Signal set

Signal colours are for notices, errors, states and alert levels. They are never brand colours (`brand.test.ts`).

| Where | Colours | Use |
|---|---|---|
| `base.css` `--signal-caution-bg` / `-ink` / `-edge` | #FFF3CD / #4A3B00 / #B8860B | the beta banner, the degraded banner, the notices: caution, not alarm |
| `base.css` `--signal-error-ink` | #8A1C1C | error text (the timebar) |
| `features/legend/palette.ts` | the class palette (PuOr/BrBG), the Δh palette, `Q_COLOUR`, the LHP colours | the map's classes and trends (CVD-checked, `cvd.spec.ts`) |
| `lib/labels/labels-index.gen.ts` | the agencies' own warning colours | warnings as the agency publishes them |
| `features/map/stationLayer.ts`, `features/station/chart.ts` | greys for stale and forecast, #01665E for a measured series, #6A3D9A for the owner ring | data states |

The map colours were not changed by P10c (owner, 2026-10-06): they are CVD-checked and stay. The brand's teal-blues and the map's BrBG teals are close in hue; a future dark mode or map redesign should keep them apart.

## 6. Typography

| Use | Typeface | Weight | Details |
|---|---|---|---|
| The name, h1–h3 | Bricolage Grotesque | 700 | line height 1.15; the name −2 % letter spacing |
| Body, interface | Source Sans 3 | 400 | 16 px, line height 1.5 |
| h4–h6, `strong` | Source Sans 3 | 600 | |
| Tables and measurements | Source Sans 3 | 400 | `font-variant-numeric: tabular-nums` (set on `:root`, so every column of figures aligns) |

The fallback behind both is `system-ui, sans-serif`.

**Files.** `apps/web/src/styles/fonts/`: the latin and latin-ext subsets (`unicode-range` as Fontsource sets them) of Bricolage Grotesque 700 and Source Sans 3 400 and 600, six woff2 files (136 KB), from the npm tarballs `@fontsource/bricolage-grotesque@5.3.0` and `@fontsource/source-sans-3@5.3.0` (published 2026-07-19; the tarballs matched the registry's sha512 integrity on 2026-10-06), copied by hand, not installed: no npm dependency and no BOM row. `SHA256SUMS` pins every file; `brand.test.ts` checks it. The OFL-1.1 texts are beside them (`OFL-*.txt`, as Fontsource ships them; the Source Sans 3 one names "Google Inc." where upstream names Adobe) and `third-party-notices.txt` carries both (`apps/web/notices.ts`, `FONTS`).

**Deviation from the document:** it puts the files under `apps/web/public/fonts/`. They are imported from `base.css` instead, so Vite gives them hashed names under `/assets/`, which Caddy serves immutable; `public/` files keep their names and are revalidated on every use. To update a font: download the new tarball, check its integrity against the registry, copy the six files and the licence, regenerate `SHA256SUMS`, bump `FONTS_VERSION` in `notices.ts`.

## 8. Viewer layout (P10d)

The station panel, the map legend and the timebar follow the layout patterns of waterinfo.rws.nl (issue #96), in these tokens. Only patterns are taken: no RWS logo, icon, font, CSS or text; the icons are our own simple SVG shapes and the words are our own, in Paraglide.

- **Station panel:** a header band in `--line` with `--ink` text and a round close button (`--paper` with an `--ink` border); the body on `--paper`. Grafiek|Tabel is a segmented control of two radios: the checked segment is `--accent` with `--accent-ink` text, the other `--paper` with an `--accent` border and text. The legend boxes (Reeksen, Grenswaarden) and the neighbour rows are bordered with `--line`; secondary text is `--muted`. `--water` is not used for text in the panel.
- **Chart colours:** the data colours stay the colour-blind checked ones of the map (`features/station/colours.ts`): measured is teal `#01665e` and solid, a forecast is purple `#542788` and dashed, an estimate dotted. Threshold zones use the state palette of the map (`features/legend/palette.ts`) at 15 % opacity, never a brand colour.
- **Map legend:** `--paper` with a `--line` border, over the bottom-right corner of the map and above MapLibre's attribution button, collapsed at the start (KG-251); the summary has a CSS chevron in `--ink`.
- **Timebar:** `--paper` with a `--line` top border, docked at the bottom in a window at least 48rem wide and 32rem high. The handle is `--ink`, the track `--muted` (3:1 on `--paper`, WCAG 1.4.11); notes and day labels are `--muted`. `--water` is not used.
- No token was added.

## 9. Full-screen layout (P10e)

The map is the page: a sticky top bar, then the viewer fills the rest of the window (issue #101). The elements are the existing tokens; no token was added, and no colour is written outside `base.css`.

- **Top bar:** 3.5rem tall, `--paper` with a `--line` bottom border, sticky. The light logo at 32 px, then the name in Bricolage Grotesque 700 at 1.5rem (24 px): large text, so "kijker" stays `--water` (§3). Below 40rem the name is 1.1rem and "kijker" takes `--accent` instead, the colour allowed for small text (a deliberate exception to the two-colour name of §4). The subtitle shows only from 100rem; the nine links and the subtitle do not fit earlier (the first note said about 64rem). The nine page links are a row from 80rem and behind a "Menu" button below it (a `--paper` button with an `--ink` border, `--ink` with `--paper` text when open); the current page is marked with bold text and a `--water` edge. The compact "bèta" link uses the signal-caution set of §5.
- **Owner strip:** the owner banner is a slim strip under the bar in the caution set; its terms scroll inside 30dvh.
- **Slim footer:** only on the pages and the 404 page, `--ink` with `--paper` text and `--name-dark` links, no logo. The map has none; the credits are in the "Bronnen" disclosure (bottom right, `--paper` with a `--line` border, above MapLibre's attribution row).
- **Station panel:** a right drawer of 26rem from 48rem, with the map keeping its size; a full-width sheet below 48rem that ends above the timebar.
- **Timebar:** a card over the bottom centre of the view (at most 46rem, clear of the drawer), full width below 48rem; collapsed by default, with "Tijdopties" for the rest (§8 for its colours).
- **Disclosures:** the mode ("Kaart: Toestand") and the view ("Weergave: Kaart") are `<details>` over the top left, and the legend a collapsed one in the bottom-right stack; all three in `--paper` with a `--line` border and an `--ink` chevron, as the legend of §8. Focus rings follow §3.
- **Search:** a magnifier button in the bar; opened, a field with a listbox below it in the same `--paper` and `--line`.

## 7. Open items (owner)

Tracked in `docs/known-gaps.md` (P10c): the domains rivierkijker.nl/.com/.eu and the BOIP register; the repository's About text; the outlined lockups and the app-icon PNGs; the LU stations on production after the KG-133 replays.
