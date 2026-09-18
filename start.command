#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install || exit 1
fi
if [ ! -d "$HOME/Library/Caches/ms-playwright" ] && [ ! -d "$HOME/.cache/ms-playwright" ]; then
  echo "Installing Playwright Chromium..."
  npx playwright install chromium || exit 1
fi
npm start
