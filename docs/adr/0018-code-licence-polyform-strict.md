# ADR-0018: Code licence: PolyForm Strict 1.0.0

- **Status:** Accepted (owner, 2026-10-06)
- **Date:** 2026-10-06
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (written in P10b; the plan is the source of truth)

## Context

The repository is public (D7: CodeQL, the security scans and open review), but until P10b it had no licence, so a
reader could not tell what they may do with the code. The colophon (P10b, issue #25) must state the licence of the
site's own code and, separately, of the ODbL river graph. The licence covers our code only: the measurements stay
under each provider's terms (catalogue §1b, §0.7, §0.8), the river graph is derived from OpenStreetMap and stays
under the ODbL (ADR-0012), and the bundled third-party packages keep their own licences
(`/third-party-notices.txt`).

## Decision

- The code is licensed under the **PolyForm Strict License 1.0.0**: the root `LICENSE` holds the official text from
  the PolyForm Project unchanged, and the root `package.json` says `"license": "SEE LICENSE IN LICENSE"`. The licence
  allows reading and use for any noncommercial purpose (personal use, research, testing, and use by charitable,
  educational, public research, public safety or health, environmental and government organisations); it grants no
  right to distribute the software or to make changes or new works based on it.
- The licence names no licensor in the file (no "Required Notice" line; PolyForm Strict has no notice clause): the
  operator's name stays out of git (it is runtime configuration, `RWS_OPERATOR_NAME`).
- The site never calls its code "open source". The colophon says "broncode inzichtelijk onder de PolyForm Strict
  License 1.0.0: lezen en niet-commercieel gebruik, geen herdistributie of wijzigingen" / "source available under the
  PolyForm Strict License 1.0.0: reading and non-commercial use, no redistribution or changes", with a link to
  https://polyformproject.org/licenses/strict/1.0.0.
- The river graph stays ODbL with its download, and the station measurements are a separate collective database
  outside the ODbL (the existing footer and colophon text).

## Consequences

- The code is source-available, not open source in the OSI sense: no one may host a modified copy of the site or
  redistribute the code without the owner's separate written permission, and an outside contribution (a change) needs
  that permission too. Agents and the owner keep working in the repository as before; the review rule for outside PRs
  in `CLAUDE.md` is unchanged.
- The build still bundles third-party code and assets under their own licences; serving that bundle is the owner's
  distribution of their own site under those licences, whose notices are in `/third-party-notices.txt`
  (`apps/web/notices.ts`). PolyForm Strict covers only the code this repository adds.
- The licensor can grant other licences later (for example to a partner, or a more open licence for a future version)
  without changing this one; a change of licence is a reviewed change of `LICENSE`, this ADR and the colophon text.
- This is not legal advice: the choice follows the owner's decision; enforceability was not assessed.
