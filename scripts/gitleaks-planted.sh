#!/usr/bin/env bash
# Proves .gitleaks.toml still catches real-looking secrets: plant freshly
# generated fake secrets in scratch repositories (never in this one) and require
# gitleaks to fail every time:
#   - an AWS access key in a new file;
#   - an AWS access key inside a file the allowlist names;
#   - a generic-api-key-shaped secret inside a file the allowlist names (the
#     allowlist entries target exactly that rule, so this proves they stay narrow).
# Usage: scripts/gitleaks-planted.sh (needs gitleaks)
set -euo pipefail

config=$(cd "$(dirname "$0")/.." && pwd)/.gitleaks.toml
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Random strings generated here and never stored anywhere.
random() {
  local alphabet=$1 length=$2 out=''
  for ((i = 0; i < length; i++)); do out+=${alphabet:RANDOM%${#alphabet}:1}; done
  printf '%s' "$out"
}
aws="AKIA$(random ABCDEFGHIJKLMNOPQRSTUVWXYZ234567 16)"
generic=$(random ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 40)

plant() {
  local path=$1 repo=$tmp/$2 line=$3
  git init -q "$repo"
  mkdir -p "$repo/$(dirname "$path")"
  printf '%s\n' "$line" >"$repo/$path"
  git -C "$repo" add -A
  git -C "$repo" -c user.name=planted -c user.email=planted@example.invalid commit -qm planted
  local code=0
  gitleaks git --no-banner --redact --config "$config" "$repo" >/dev/null 2>&1 || code=$?
  if [[ $code -ne 1 ]]; then
    echo "gitleaks-planted: a planted secret in $path ($2) was NOT caught (exit $code)" >&2
    exit 1
  fi
  echo "gitleaks-planted: planted secret in $path ($2) caught (exit 1)"
}

plant planted/leak.txt aws-new-file "aws_access_key_id = $aws"
plant docs/sources/SOURCE-CATALOGUE.md aws-allowlisted-file "aws_access_key_id = $aws"
plant docs/sources/SOURCE-CATALOGUE.md generic-allowlisted-file "api_key = \"$generic\""
