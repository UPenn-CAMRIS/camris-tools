#!/usr/bin/env bash
# PreToolUse(Bash) hook: refuse `git commit` / `git push` while on `main`.
#
# This project lands every change on `main` through a reviewed PR (see
# CLAUDE.md). The hook is a guard rail, not a lock: to handle a genuine
# exception, run the git command yourself in a terminal.
set -euo pipefail

input="$(cat)"

# Ignore any Bash command that is not a git commit / push.
case "$input" in
  *"git commit"* | *"git push"*) ;;
  *) exit 0 ;;
esac

repo_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
branch="$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

if [ "$branch" = "main" ]; then
  cat >&2 <<'EOF'
Blocked: this project requires every change to land on `main` via a
reviewed PR, so `git commit` and `git push` are not allowed on `main`.

  git checkout -b <type>/<short-description>   # feature | fix | docs | chore
  # commit on the branch, push, open a PR against main

See CLAUDE.md ("Branch and PR workflow"). For a deliberate exception, run
the git command yourself in a terminal.
EOF
  exit 2
fi

exit 0
