#!/usr/bin/env bash
# Zero Factory precommit script for zero-share (Astro + Svelte + TypeScript).
#
# Runs the project's own tooling (see package.json scripts):
#   format  -> prettier --write . && eslint . --fix
#   build   -> tsc --noEmit && astro build
#   test    -> no test suite is defined for this repository
#
# Usage:
#   ./.zerofactory/precommit.sh            run all phases
#   ./.zerofactory/precommit.sh format     formatting & lint auto-fix only
#   ./.zerofactory/precommit.sh build      typecheck & build only
#   ./.zerofactory/precommit.sh test       test suite (informational: none)
#   ./.zerofactory/precommit.sh install-hook
#       link .git/hooks/pre-commit to this script for developers

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Ensure node_modules is present (idempotent; no-op when installed).
if [ ! -d node_modules ]; then
  echo "==> node_modules missing, running npm install..."
  npm install
fi

run_format() {
  echo "==> [format] prettier --write ."
  npx prettier --write .
  echo "==> [format] eslint . --fix"
  npx eslint . --fix
}

run_build() {
  echo "==> [build] tsc --noEmit (typecheck)"
  npx tsc --noEmit
  echo "==> [build] astro build"
  npm run build
}

run_test() {
  echo "==> [test] no test suite is defined for this repository (no test script in package.json) — skipping."
}

install_hook() {
  HOOK_DIR="$(git rev-parse --git-path hooks 2>/dev/null || echo ".git/hooks")"
  mkdir -p "$HOOK_DIR"
  ln -sf "../../.zerofactory/precommit.sh" "$HOOK_DIR/pre-commit"
  chmod +x "$HOOK_DIR/pre-commit"
  echo "✓ Linked .zerofactory/precommit.sh -> $HOOK_DIR/pre-commit"
}

case "${1:-all}" in
  format)       run_format ;;
  build)        run_build ;;
  test)         run_test ;;
  install-hook) install_hook ;;
  all|*)
    run_format
    run_build
    run_test
    ;;
esac

echo "✓ Zero Factory precommit checks passed!"
