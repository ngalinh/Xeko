#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install server dependencies
cd "$CLAUDE_PROJECT_DIR/server"
npm install

# Restore data files from git and ensure directory exists
cd "$CLAUDE_PROJECT_DIR"
git pull origin HEAD --ff-only --quiet 2>/dev/null || true
mkdir -p data
