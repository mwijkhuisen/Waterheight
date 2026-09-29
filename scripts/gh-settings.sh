#!/usr/bin/env bash
# GitHub repository settings as code (owner actions B1, B2, B3, B5 in issue #14;
# docs/github-settings.md). Run by the owner with an admin `gh` login.
#
#   scripts/gh-settings.sh            apply B1 and create B2 (idempotent), then --check
#   scripts/gh-settings.sh --dry-run  print every change it would make, change nothing
#   scripts/gh-settings.sh --check    read-only: exit 1 on any drift from B1/B2, and on
#                                     any Actions/Dependabot/environment secret, deploy
#                                     key or webhook (B3, B5)
#
# It only tightens: no bypass actors, no protection turned off. Code-owner review
# stays off on purpose: the owner is the only reviewer and merger, so requiring
# a code-owner approval would deadlock every PR (0 required approvals, B1).
# The token never leaves gh; nothing here prints it.
set -euo pipefail

REPO=${REPO:-mwijkhuisen/Waterheight}
readonly ACTIONS_APP_ID=15368 # the GitHub Actions app: required checks must come from it
readonly CHECKS=(ci security)
# Non-GitHub-owned actions the workflows may use (GitHub-owned ones are allowed as a group).
readonly EXTRA_ACTIONS=('step-security/harden-runner@*')

usage() { echo "usage: $0 [--dry-run|--check]" >&2; exit 2; }
(($# <= 1)) || usage
mode=apply
case ${1:-} in
  '') ;;
  --dry-run) mode=dry-run ;;
  --check) mode=check ;;
  *) usage ;;
esac

owner=${REPO%%/*}
owner_id=$(gh api "users/$owner" --jq .id)

# ---- desired state -------------------------------------------------------------
checks_json=""
for c in "${CHECKS[@]}"; do checks_json+="{\"context\":\"$c\",\"integration_id\":$ACTIONS_APP_ID},"; done
checks_json="[${checks_json%,}]"
patterns_json=$(printf '"%s",' "${EXTRA_ACTIONS[@]}")
patterns_json="[${patterns_json%,}]"

main_ruleset=$(cat <<JSON
{"name":"main","target":"branch","enforcement":"active","bypass_actors":[],
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[
  {"type":"deletion"},
  {"type":"non_fast_forward"},
  {"type":"required_linear_history"},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,
   "require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false,
   "allowed_merge_methods":["squash","rebase"]}},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,
   "do_not_enforce_on_create":false,"required_status_checks":$checks_json}}]}
JSON
)
tag_ruleset=$(cat <<'JSON'
{"name":"legacy-v0","target":"tag","enforcement":"active","bypass_actors":[],
 "conditions":{"ref_name":{"include":["refs/tags/legacy-v0"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"update"},{"type":"non_fast_forward"}]}
JSON
)
environment=$(cat <<JSON
{"wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":$owner_id}],
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
)

# ---- helpers --------------------------------------------------------------------
fail=0
drift() { echo "drift: $*" >&2; fail=1; }
ok() { echo "ok: $*"; }
# Mutating call: printed in dry-run, executed otherwise.
call() {
  local method=$1 path=$2 body=${3:-}
  if [[ $mode == dry-run ]]; then
    echo "would $method $path ${body//$'\n'/ }"
  elif [[ -n $body ]]; then
    gh api --method "$method" "$path" --input - <<<"$body" >/dev/null
    echo "set: $method $path"
  else
    gh api --method "$method" "$path" >/dev/null
    echo "set: $method $path"
  fi
}
# A read-only query; a failure (404, missing scope) yields "<unavailable>",
# which never equals an expected value, so --check fails closed.
q() {
  local out
  if out=$(gh api "$1" --jq "$2" 2>/dev/null); then printf '%s\n' "$out"; else echo "<unavailable>"; fi
}
ruleset_id() { gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$1\") | .id" | head -n1; }
put_ruleset() {
  local name=$1 body=$2 id
  id=$(ruleset_id "$name")
  if [[ -n $id ]]; then call PUT "repos/$REPO/rulesets/$id" "$body"; else call POST "repos/$REPO/rulesets" "$body"; fi
}

# ---- apply ----------------------------------------------------------------------
apply() {
  put_ruleset main "$main_ruleset"
  put_ruleset legacy-v0 "$tag_ruleset"
  call PUT "repos/$REPO/actions/permissions" '{"enabled":true,"allowed_actions":"selected","sha_pinning_required":true}'
  call PUT "repos/$REPO/actions/permissions/selected-actions" \
    "{\"github_owned_allowed\":true,\"verified_allowed\":false,\"patterns_allowed\":$patterns_json}"
  call PUT "repos/$REPO/actions/permissions/workflow" '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}'
  call PATCH "repos/$REPO" \
    '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'
  call PUT "repos/$REPO/private-vulnerability-reporting"
  call PUT "repos/$REPO/vulnerability-alerts"
  call PUT "repos/$REPO/environments/production" "$environment"
  local policies
  policies=$(q "repos/$REPO/environments/production/deployment-branch-policies" '[.branch_policies[].name] | join(",")')
  if [[ ,$policies, != *,main,* ]]; then
    call POST "repos/$REPO/environments/production/deployment-branch-policies" '{"name":"main","type":"branch"}'
  fi
  if [[ $mode == apply ]]; then check; fi
}

# ---- check (read-only) ----------------------------------------------------------
# Compare a canonical JSON projection of the live state with the expected one.
# gh's jq (gojq) prints object keys sorted, so every expected value is sorted too.
expect() {
  local what=$1 want=$2 got=$3
  if [[ $got == "$want" ]]; then ok "$what"; else drift "$what: expected $want, got ${got:-<nothing>}"; fi
}

check() {
  local id
  id=$(ruleset_id main)
  if [[ -z $id ]]; then drift "branch ruleset main is missing"; else
    expect "ruleset main" \
      "{\"bypass\":0,\"checks\":[\"ci@$ACTIONS_APP_ID\",\"security@$ACTIONS_APP_ID\"],\"enforcement\":\"active\",\"include\":[\"~DEFAULT_BRANCH\"],\"pr\":{\"require_code_owner_review\":false,\"required_approving_review_count\":0},\"rules\":[\"deletion\",\"non_fast_forward\",\"pull_request\",\"required_linear_history\",\"required_status_checks\"]}" \
      "$(q "repos/$REPO/rulesets/$id" '{enforcement, bypass: (.bypass_actors | length), include: .conditions.ref_name.include,
          rules: ([.rules[] | .type] | sort),
          pr: ([.rules[] | select(.type == "pull_request") | .parameters | {required_approving_review_count, require_code_owner_review}] | first),
          checks: ([.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | "\(.context)@\(.integration_id)"] | sort)} | tojson')"
  fi
  id=$(ruleset_id legacy-v0)
  if [[ -z $id ]]; then drift "tag ruleset legacy-v0 is missing"; else
    expect "ruleset legacy-v0" \
      '{"bypass":0,"enforcement":"active","include":["refs/tags/legacy-v0"],"rules":["deletion","non_fast_forward","update"]}' \
      "$(q "repos/$REPO/rulesets/$id" '{enforcement, bypass: (.bypass_actors | length), include: .conditions.ref_name.include, rules: ([.rules[] | .type] | sort)} | tojson')"
  fi

  expect "actions permissions" '{"allowed_actions":"selected","enabled":true,"sha_pinning_required":true}' \
    "$(q "repos/$REPO/actions/permissions" '{enabled, allowed_actions, sha_pinning_required} | tojson')"
  expect "allowed actions" "{\"github_owned_allowed\":true,\"patterns_allowed\":$patterns_json,\"verified_allowed\":false}" \
    "$(q "repos/$REPO/actions/permissions/selected-actions" '{github_owned_allowed, verified_allowed, patterns_allowed: (.patterns_allowed | sort)} | tojson')"
  # Every `uses:` in the workflows must be allowed (GitHub-owned or listed).
  local root uses u repo allowed p
  root=$(git rev-parse --show-toplevel)
  uses=$(grep -hoE 'uses:[[:space:]]*[^@[:space:]]+@' "$root"/.github/workflows/*.yml | sed -E 's/uses:[[:space:]]*//; s/@$//' | sort -u)
  while IFS= read -r u; do
    [[ -z $u ]] && continue
    case ${u%%/*} in actions | github) continue ;; esac # GitHub-owned
    repo=$(cut -d/ -f1-2 <<<"$u")
    allowed=0
    for p in "${EXTRA_ACTIONS[@]}"; do [[ $repo == "${p%@*}" ]] && allowed=1; done
    if ((allowed)); then ok "workflow action $u is allowed"; else drift "workflow action $u is not in the allowed-actions list"; fi
  done <<<"$uses"

  expect "default GITHUB_TOKEN" '{"can_approve_pull_request_reviews":false,"default_workflow_permissions":"read"}' \
    "$(q "repos/$REPO/actions/permissions/workflow" '{default_workflow_permissions, can_approve_pull_request_reviews} | tojson')"
  expect "secret scanning + push protection" '{"push_protection":"enabled","secret_scanning":"enabled"}' \
    "$(q "repos/$REPO" '{secret_scanning: .security_and_analysis.secret_scanning.status, push_protection: .security_and_analysis.secret_scanning_push_protection.status} | tojson')"
  expect "private vulnerability reporting" true "$(q "repos/$REPO/private-vulnerability-reporting" .enabled)"
  if gh api "repos/$REPO/vulnerability-alerts" --silent 2>/dev/null; then ok "Dependabot alerts"; else drift "Dependabot alerts are off"; fi

  expect "environment production" "{\"custom\":true,\"reviewers\":[$owner_id]}" \
    "$(q "repos/$REPO/environments/production" '{reviewers: [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[] | .reviewer.id], custom: .deployment_branch_policy.custom_branch_policies} | tojson')"
  expect "production deploys only from main" '["branch:main"]' \
    "$(q "repos/$REPO/environments/production/deployment-branch-policies" '[.branch_policies[] | "\(.type):\(.name)"] | tojson')"
  expect "no environment secrets (B5)" 0 "$(q "repos/$REPO/environments/production/secrets" .total_count)"
  expect "no Actions secrets (B5)" 0 "$(q "repos/$REPO/actions/secrets" .total_count)"
  expect "no Dependabot secrets (B5)" 0 "$(q "repos/$REPO/dependabot/secrets" .total_count)"
  expect "no deploy keys (B3)" 0 "$(q "repos/$REPO/keys" length)"
  expect "no webhooks (B3)" 0 "$(q "repos/$REPO/hooks" length)"

  if ((fail)); then echo "gh-settings --check: DRIFT" >&2; exit 1; fi
  echo "gh-settings --check: OK"
}

case $mode in
  check) check ;;
  *) apply ;;
esac
