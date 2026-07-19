#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SERVER_DIR="${SCRIPT_DIR}/../server"

cd "${SERVER_DIR}"

echo "Checking formatting..."
cargo fmt --all -- --check

echo "Checking compilation..."
cargo check --all-targets --all-features --locked

echo "Running Clippy..."
cargo clippy --all-targets --all-features --locked -- -D warnings

echo "Running tests..."
cargo test --all-targets --all-features --locked

if [[ -f src/lib.rs ]]; then
    echo "Running documentation tests..."
    cargo test --doc --all-features --locked
fi

echo "All checks passed."
