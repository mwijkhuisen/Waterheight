#!/usr/bin/env bash
# Install the pinned pnpm native binary without corepack and without running
# any downloaded script (used by CI and .claude/hooks/session-start.sh).
#
# pnpm 12 is a native executable; the plain `pnpm` npm package only wraps it and
# may download the binary at run time. This script fetches the platform package
# @pnpm/exe.<platform> from the npm registry and checks its sha512 against the
# pin below (the same integrity pnpm-lock.yaml records) before unpacking it.
#
# Usage: scripts/install-pnpm.sh <prefix>   -> <prefix>/bin/pnpm
# Idempotent: exits early when <prefix>/bin/pnpm is already this version.
set -euo pipefail

readonly VERSION=12.5.1
declare -A SHA512=(
  [x64]=dcf914058a39cf8760b659d3348163ed01a9703500baa5f3f561958a03c309e71c127846891916980e75d364e66091edc093f72df984f9917d3c6796867f29f5
  [arm64]=ea16cc596dbf790a356f9c2f40f7bf9dd2c75531fcf116afe8df9f7c3e3f87a22e14c8d60a06ac15862c16fd06aefa6a444031dd2c26652be58bed0d157a9bc4
)

(($# == 1)) || { echo "usage: $0 <prefix>" >&2; exit 2; }
prefix=$1

case $(uname -m) in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "install-pnpm: unsupported machine $(uname -m)" >&2; exit 1 ;;
esac

bin=$prefix/bin/pnpm
if [[ -x $bin ]] && [[ $("$bin" --version 2>/dev/null) == "$VERSION" ]]; then
  echo "install-pnpm: pnpm $VERSION already installed at $bin"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
url="https://registry.npmjs.org/@pnpm/exe.linux-$arch/-/exe.linux-$arch-$VERSION.tgz"
curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$tmp/pnpm.tgz" "$url"
echo "${SHA512[$arch]}  $tmp/pnpm.tgz" | sha512sum -c --quiet -
tar -xzf "$tmp/pnpm.tgz" -C "$tmp" package/pnpm

dest=$prefix/pnpm-$VERSION
mkdir -p "$dest" "$prefix/bin"
install -m 0755 "$tmp/package/pnpm" "$dest/pnpm"
ln -sfn "$dest/pnpm" "$bin"
echo "install-pnpm: installed pnpm $("$bin" --version) at $bin"
