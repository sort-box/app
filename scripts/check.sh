#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Typechecking"
bun run typecheck

echo "==> Formatting"
bun run format

echo "==> Linting"
bun run lint

echo "==> Running tests"
bun run test

echo "==> Building"
bun run build

echo "==> All checks passed"
