#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
# SPDX-License-Identifier: MIT
#
# No references to Woodpatch's private work in public text. A PR may not add one: not in
# the lines it adds, its commit messages (merges included), or its title and body. Two
# shapes are refused:
# - a tracker number of four or more digits (`#` then 4+ digits). This repository's own
#   issues and PRs are two-digit; raise the floor here if they ever reach four digits;
# - a link into another repository of the organisation (all private), or to an issue or
#   PR numbered in the thousands. The private repositories are deliberately not named
#   here: this file is public.
# Hits print where (commit and file, or "PR title/body"), never the matched text.
#
# Usage: check-private-refs.sh <base-sha> <head-sha>   the PR's commits, and its text
#        check-private-refs.sh                         only the PR's title and body
# The title and body are read from the event payload ($GITHUB_EVENT_PATH), if any.
set -euo pipefail

fail=0
here=$(dirname "$0")

# Reads "where<TAB>text" lines; prints each `where` whose text leaks, once. The rules,
# and why a bare number needs context in a G-code repository, are in private-refs.mjs.
leaks() { node "$here/private-refs.mjs"; }

if [ $# -ge 2 ]; then
  base="$1"
  head="$2"
  # Merges too: their messages, and against their first parent, whatever the merge
  # itself brought in (conflict resolutions included).
  for sha in $(git rev-list "${base}..${head}"); do
    hits=$(
      git show --format='%B' --no-color -m --first-parent -p "$sha" |
        awk -v c="${sha:0:10}" '
          /^diff --git / { f = $4; sub(/^b\//, "", f); next }
          /^\+\+\+ / || /^--- / { next }
          /^\+/ { print c " " f "\t" substr($0, 2); next }
          f == "" { print c " (message)\t" $0 }
        ' | leaks
    )
    if [ -n "$hits" ]; then
      while IFS= read -r where; do
        echo "::error::a reference to private work is added in ${where}"
      done <<<"$hits"
      fail=1
    fi
  done
fi

if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -r "$GITHUB_EVENT_PATH" ]; then
  for field in title body; do
    hits=$(
      node -e '
        const e = JSON.parse(require("fs").readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
        const t = (e.pull_request && e.pull_request[process.argv[1]]) || "";
        for (const line of t.split(/\r?\n/)) console.log("PR " + process.argv[1] + "\t" + line);
      ' "$field" | leaks
    )
    if [ -n "$hits" ]; then
      echo "::error::a reference to private work is in the ${hits}"
      fail=1
    fi
  done
fi

[ "$fail" -eq 0 ] && echo "no references to private work"
exit "$fail"
