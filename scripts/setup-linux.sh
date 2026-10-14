#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: bash scripts/setup-linux.sh [--archive-only | --help]' \
    'Check the Linux toolchain and repository, install the root workspace from its lockfile,' \
    'then fetch and verify the fixed DSH source. --archive-only skips source extraction.'
}

if (( $# > 1 )); then
  usage >&2
  exit 2
fi
fetch_args=()
case "${1-}" in
  '') ;;
  --help) usage; exit 0 ;;
  --archive-only) fetch_args+=(--archive-only) ;;
  *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac

for tool in bash git node pnpm tar uname dirname; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required tool is missing from PATH: %s\n' "$tool" >&2
    exit 1
  fi
done
if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'This script requires Linux; use the documented Node commands on Windows.' >&2
  exit 1
fi
bash --version >/dev/null
git --version >/dev/null
tar --version >/dev/null

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$repo_root"

required_pnpm="$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const product = JSON.parse(readFileSync(process.argv[1], "utf8"));
const requiredNode = product.engines?.node;
const manager = /^pnpm@(\d+\.\d+\.\d+)$/.exec(product.packageManager ?? "");
if (!/^\d+\.\d+\.\d+$/.test(requiredNode ?? "") || !manager) {
  console.error("package.json must declare exact Node and pnpm versions.");
  process.exit(1);
}
if (process.versions.node !== requiredNode) {
  console.error(`Node ${requiredNode} required; actual ${process.versions.node}`);
  process.exit(1);
}
console.log(manager[1]);
' "$repo_root/package.json")"
actual_pnpm="$(pnpm --version)"
if [[ "$actual_pnpm" != "$required_pnpm" ]]; then
  printf 'pnpm %s required; actual %s\n' "$required_pnpm" "$actual_pnpm" >&2
  exit 1
fi

node scripts/check-repository.mjs
pnpm install --frozen-lockfile --ignore-scripts
node scripts/fetch-dsh.mjs "${fetch_args[@]}"
