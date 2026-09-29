---
name: Phase
about: One phase of the plan (docs/plan/PHASES.md), with its Build, Code review and Security review prompts
title: 'Phase <N> — <name>'
labels: []
---

> Part of the roadmap #<roadmap> · Depends on: <issues> · Unblocks: <issues> · Owner prerequisites from #<owner-actions>: <items>

**Window:** <from> → <to>. PRs, in order: <P<N>a …>, <P<N>b …>.

## Goal
<Why this phase exists and what it delivers, from PHASES.md §5.>

## Scope
**In scope**
- **P<N>a <name>**
  - <item>
- **P<N>b <name>**
  - <item>

**Out of scope** (and where it happens instead)
- <item> → P<M>.

## Deliverables
- <deliverable> (P<N>a).

## Acceptance criteria
Every criterion carries exactly one tag: **[CI]**, **[agent-prod]** or **[owner]** (PHASES §2.1).

### P<N>a — <name>
- [ ] [CI] <criterion>
- [ ] [agent-prod] <criterion>
- [ ] [owner] <criterion>

## How to run this phase
1. Make sure the dependencies are merged and the owner prerequisites are done.
2. **Build**: for each PR, in order, start a new Claude Code session on `main`, set the model and effort from the Step 1 table, enter plan mode, paste that PR's Build prompt, review and approve the plan, and let it implement and open the PR.
3. **Code review**: a *new* session on the PR branch, the Step 2 model and command, then the Code-review prompt.
4. **Security review**: another *new* session on the PR branch, the Step 3 model and effort, then the Security-review prompt.
5. **Fix**: the build model at the build effort addresses every finding, pushes and re-runs CI.
6. **Gate and merge**: CI green (`ci`, `security`); every [CI] criterion ticked with evidence; no open High or Critical security finding; Medium findings fixed or accepted in `docs/risk-register.md` (PHASES §2.2). After deploy the agent runs `scripts/verify-prod.sh` and ticks the [agent-prod] items; [owner] items are yours.
7. Repeat for the next PR. Close the issue when every criterion (including soak criteria) is ticked.

**Phase <N> specifics**
- <notes>

## Step 1 — Build
| Model | Effort | Mode |
|---|---|---|
| `/model <build-model>` | `/effort <build-effort>` | `/plan` first |

**Why this model/effort:** <justification>.

### P<N>a — <name>
Branch `claude/p<N>a-<slug>` · PR title `P<N>a: <name>` · PR body says "Part of #<issue>" (the last PR: "Closes #<issue>") · Criteria: the **P<N>a** block above.

```text
<Build prompt: context, what to read first (CLAUDE.md, ARCHITECTURE, PHASES §P<N>, catalogue §refs),
source IDs in scope, the security invariants verbatim, the ordered tasks, the verification to show,
Git and PR rules, what to do when reality differs, "start in plan mode and wait for approval".>
```

## Step 2 — Code review
| Model | Command | Effort |
|---|---|---|
| `/model <review-model>` (a different model from the build) | `/code-review <level> --comment <PR#>` | `/effort <level>` |

**Why:** <justification>.

### P<N>a — <name>
```text
<Code-review prompt: what to read, the phase-specific checks, the evidence to record per criterion,
"post each finding as a PR review comment with a severity; do not push fixes; finish with a verdict".>
```

## Step 3 — Security review
| Model | Effort | Command |
|---|---|---|
| `/model <sec-model>` | `/effort <sec-effort>` | `/security-review` |

**Why:** <justification>.

### P<N>a — <name>
```text
<Security-review prompt: check out the branch, the threats specific to this PR, the invariants to verify,
"classify findings Critical/High/Medium/Low with file:line, exploit scenario and fix; report the
threat-model delta; do not push fixes; verdict passes only with no open High or Critical".>
```

## Definition of done
- [ ] PR(s) merged; the last one says "Closes #<issue>"
- [ ] CI green (`ci`, `security`)
- [ ] Code-review findings addressed or answered
- [ ] Security-review findings: no open High/Critical; Medium/Low addressed or tracked
- [ ] `CLAUDE.md`, runbooks and `docs/threat-model.md` updated where the phase changes them
- [ ] Every [owner] item done
