#!/usr/bin/env bash
# Builds the two uploadable zips of the badge app into dist/:
#   pop-bin.zip             the real app (talks to https://pop-bin.vercel.app)
#   pop-bin-local-demo.zip  DEMO_LOCAL = true: a simulated world, no server or sign-in needed
set -euo pipefail
cd "$(dirname "$0")/.."

grep -q '^local DEMO_LOCAL = false' badge/main.lua || { echo "badge/main.lua must have DEMO_LOCAL = false" >&2; exit 1; }
for f in $(find badge -name '*.lua'); do luac -p "$f"; done
lua tools/badge_sim.lua >/dev/null

rm -rf dist && mkdir -p dist/local
(cd badge && zip -qr ../dist/pop-bin.zip . -x '.*')
cp -R badge/. dist/local/
sed -i.bak 's/^local DEMO_LOCAL = false/local DEMO_LOCAL = true/' dist/local/main.lua && rm dist/local/main.lua.bak
(cd dist/local && zip -qr ../pop-bin-local-demo.zip . -x '.*')
rm -rf dist/local
ls -l dist
