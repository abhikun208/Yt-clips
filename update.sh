#!/bin/sh
# Safe update: keeps .env and data/ (untracked), parks any local edits to tracked files (saved in `git stash`), pulls, runs the checks.
#   sh update.sh      (or: npm run update)
cd "$(dirname "$0")" || exit 1
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "local edits found -> saved with: git stash (restore later: git stash pop)"; git stash push -q -m "auto-stash before update $(date +%F-%H%M)"; fi
git pull --rebase -q origin main || { echo "pull failed: send this output"; exit 1; }
node --disable-warning=ExperimentalWarning src/cli.ts doctor --check 2>&1 | tail -12
echo "updated to $(git log --oneline | head -1). Restart the server (npm start)."
