# Planning bundle: river levels flowing into the Netherlands (fresh start)

This folder and `docs/sources/` hold the planning output from 2026-09-23. It is the basis of the roadmap issue and of the phase issues P0–P14 on GitHub.

This is a **fresh start**. The code on `main` is archived as tag `legacy-v0` and removed in Phase 0 (PR P0a). Phase 0 (PR P0b) then copies this bundle into the new `main` with:

```sh
git fetch origin claude/river-water-level-map-hf7bcz
git checkout origin/claude/river-water-level-map-hf7bcz -- docs/plan docs/sources
```

| File | What it is |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The chosen stack with pins, principles, data model, ingestion design, key queries, API and static files, frontend, one-VPS deployment, security invariants (A§12.1) and ADRs |
| [`PHASES.md`](PHASES.md) | Phases P0–P14: scope, tagged acceptance criteria, risks, review focus and model/effort per step. Also the owner decisions and actions (§6) and the amendments made after the gap check (§9) |
| [`JUDGEMENT.md`](JUDGEMENT.md) | How three independent proposals were scored, and what was taken from each |
| [`proposals/`](proposals/) | The three proposals: data-first, walking skeleton, security & operations first |
| [`../sources/SOURCE-CATALOGUE.md`](../sources/SOURCE-CATALOGUE.md) | Every data source (NL-1 … CH-11), checked live on 2026-09-23: endpoints, units, datums, time zones, cadence, history, licence and attribution, pitfalls, and station shortlists ordered upstream → downstream |
| [`../sources/CATALOGUE-GAPS.md`](../sources/CATALOGUE-GAPS.md) | The completeness check of the catalogue and how each gap was resolved |
| [`../sources/research/`](../sources/research/) | The raw research reports, one per provider or topic |

Where the files disagree, `PHASES.md` §9 and the revised catalogue take precedence over earlier text. Facts marked `[U]` or UNVERIFIED must be checked by the phase that first depends on them.
