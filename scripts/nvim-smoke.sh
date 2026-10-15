#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NVIM="${NVIM:-nvim}"
ROOT_ARGS=()
if [[ $# -gt 0 ]]; then
  ROOT_ARGS=(--root "$1")
fi

if ! command -v "$NVIM" >/dev/null 2>&1; then
  echo "SKIP: $NVIM not found; vehicle.nvim smoke not run"
  exit 0
fi

cargo run --manifest-path "$HERE/Cargo.toml" -- nvim-smoke --nvim "$NVIM" "${ROOT_ARGS[@]}"
cargo run --manifest-path "$HERE/Cargo.toml" -- nvim-bridge-smoke --nvim "$NVIM"
cargo run --manifest-path "$HERE/Cargo.toml" -- nvim-live-bridge-smoke --nvim "$NVIM"
