#!/bin/sh
# Restore the last known-good build. Run if a refactor breaks the server:
#   sh scripts/rollback.sh && (quit and relaunch Claude Desktop)
set -e
cd "$(dirname "$0")/.."
[ -d /tmp/mcp-build-rollback ] || { echo "No rollback copy at /tmp/mcp-build-rollback"; exit 1; }
rm -rf build && cp -R /tmp/mcp-build-rollback build
echo "Restored build from /tmp/mcp-build-rollback. Relaunch Claude Desktop."
