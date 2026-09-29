# ADR-0012: River graph from OSM, built in CI

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Bifurcations are needed; the agent sandbox cannot reach Geofabrik or Overpass (research/map-rivers.md).

## Decision

OSM relations → osmium export → TypeScript graph → tippecanoe, run in `geo.yml`. Outputs are release assets, and the derived graph is published under ODbL. Agents develop against a committed fixture PBF. Station chainage comes from official river-km.

## Consequences

A monthly workflow and an ODbL download page.
