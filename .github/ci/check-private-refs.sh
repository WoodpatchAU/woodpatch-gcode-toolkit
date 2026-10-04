#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
# SPDX-License-Identifier: MIT
#
# No references to Woodpatch's private work in public text. A PR may not add one: not in
# the lines it adds, the paths it adds them to, its commit messages (merges included), or
# its title and body. What counts as a reference (links, and tracker numbers told apart
# from G-code parameters by context, with the digit floor to raise if this repository's
# own numbers ever reach four digits) is in private-refs.mjs, beside this script.
# Hits print where (commit and file, or "PR title/body"), never the matched text.
#
# Usage: check-private-refs.sh <base-sha> <head-sha>   the PR's commits, and its text
#        check-private-refs.sh                         only the PR's title and body
# The title and body are read from the event payload ($GITHUB_EVENT_PATH), if any.
set -euo pipefail

fail=0
here=$(dirname "$0")
# The matcher beside this script. CI copies both from the BASE branch first, so a PR
# can't loosen the check that judges it.
matcher="$here/private-refs.mjs"

# Reads "where<TAB>text" lines; prints each `where` whose text leaks, once. The rules,
# and why a bare number needs context in a G-code repository, are in private-refs.mjs.
leaks() { node "$matcher"; }

if [ $# -ge 2 ]; then
  base="$1"
  head="$2"
  # A bad range must fail, not scan nothing (set -e stops on the assignment).
  shas=$(git rev-list "${base}..${head}")
  for sha in $shas; do
    hits=$(
      {
        # The message, then the diff: read apart, so a message line that looks like a
        # diff header can't hide. Merges too, against their first parent (whatever the
        # merge itself brought in). --text and no textconv: binaries and files marked
        # -diff are scanned as they are.
        git log -1 --format='%B' "$sha" | awk -v c="${sha:0:10}" '{ print c " (message)\t" $0 }'
        git show --format= --no-color --text --no-textconv --no-ext-diff -m --first-parent -p "$sha" |
          awk -v c="${sha:0:10}" '
            # A file header runs from "diff --git" to its first "@@": only there are
            # ---/+++ lines headers. In a hunk, an added "++ …" line is content.
            # The path is scanned too: a file can be named with a reference.
            /^diff --git / { f = $4; sub(/^b\//, "", f); head = 1; print c " " f " (path)\t" f; next }
            /^@@/ { head = 0; next }
            head && (/^\+\+\+ / || /^--- /) { next }
            !head && /^\+/ { print c " " f "\t" substr($0, 2) }
          '
      } | leaks
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
