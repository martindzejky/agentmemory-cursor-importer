#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTFILES="${HOME}/.agentfiles"

if [ ! -d "$AGENTFILES/.git" ]; then
  echo "agentfiles not found at $AGENTFILES" >&2
  exit 1
fi

git -C "$AGENTFILES" fetch origin master
git -C "$AGENTFILES" checkout -B master origin/master
HOME="$HOME" "$AGENTFILES/install"

. "$NVM_DIR/nvm.sh"
corepack enable

cd "$ROOT"
nvm install
corepack prepare --activate
pnpm install --frozen-lockfile
