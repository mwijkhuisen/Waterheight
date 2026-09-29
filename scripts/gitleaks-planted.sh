#!/usr/bin/env bash
# Proves .gitleaks.toml still catches a real-looking key: plant a freshly
# generated fake AWS access key in a scratch repository (never in this one),
# once in a new file and once inside a file the allowlist names, and require
# gitleaks to fail both times. Usage: scripts/gitleaks-planted.sh (needs gitleaks)
set -euo pipefail

config=$(cd "$(dirname "$0")/.." && pwd)/.gitleaks.toml
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 16 random characters from the AWS key alphabet; generated here, never stored.
alphabet=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567
fake=AKIA
for _ in {1..16}; do fake+=${alphabet:RANDOM%32:1}; done

plant() {
  local path=$1 repo=$tmp/$2
  git init -q "$repo"
  mkdir -p "$repo/$(dirname "$path")"
  printf 'aws_access_key_id = %s\n' "$fake" >"$repo/$path"
  git -C "$repo" add -A
  git -C "$repo" -c user.name=planted -c user.email=planted@example.invalid commit -qm planted
  local code=0
  gitleaks git --no-banner --redact --config "$config" "$repo" >/dev/null 2>&1 || code=$?
  if [[ $code -ne 1 ]]; then
    echo "gitleaks-planted: a planted key in $path was NOT caught (exit $code)" >&2
    exit 1
  fi
  echo "gitleaks-planted: planted key in $path caught (exit 1)"
}

plant planted/leak.txt new-file
plant docs/sources/SOURCE-CATALOGUE.md allowlisted-file
