#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
# SPDX-License-Identifier: MIT
#
# Developer Certificate of Origin: every non-merge commit in a PR must carry a
# `Signed-off-by:` trailer matching its author (ADR-0008). This takes the place
# of a CLA: the project is MIT in and MIT out, so contributors only need to
# certify they have the right to submit the work (https://developercertificate.org).
#
# One narrow exemption (ADR-0039, operator ruling 2026-10-05): a dependency bump by
# Dependabot. The DCO certifies a human's contribution; for a bot's bump the approving
# reviewer is the gate. A commit is exempt only if ALL of these hold:
#   - the PR was opened by dependabot[bot] (from the event payload, read as data);
#   - the commit's author is Dependabot's noreply address;
#   - the commit was signed by GitHub on Dependabot's behalf: GitHub reports the
#     signature valid AND the committer is GitHub's web-flow. (verified alone isn't
#     enough: GitHub checks a signature against the COMMITTER, and the author field is
#     free text, so anyone with write access could sign a commit "authored" by
#     Dependabot with their own key.) Read from the API with the read-only token.
# Any other commit on such a PR, a maintainer's fix-up say, still needs a sign-off.
# CI runs this script from the BASE branch, so a PR can't widen its own exemption.
#
# Usage: check-dco.sh <base-sha> <head-sha>
# Environment (the exemption only): GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN.
set -euo pipefail

base="$1"
head="$2"
fail=0

DEPENDABOT='dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'

pr_author=""
if [[ -n "${GITHUB_EVENT_PATH:-}" && -r "${GITHUB_EVENT_PATH}" ]]; then
  pr_author="$(jq -r '.pull_request.user.login // ""' "$GITHUB_EVENT_PATH")"
fi

# Whether GitHub signed the commit itself, for Dependabot. Fails closed: a failed
# request, an empty or odd body, or a missing field is "no". The token goes in a header
# read from a file descriptor, never on curl's argv (the standing rule for credentials).
signed_by_github() {
  local out
  out="$(curl -fsS --max-time 20 \
    -H @<(printf 'Authorization: Bearer %s\n' "${GH_TOKEN:-}") \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${GITHUB_REPOSITORY:-}/commits/$1" 2>/dev/null)" || return 1
  [[ "$(jq -r '[.commit.verification.verified == true,
                 .commit.verification.reason == "valid",
                 .committer.login == "web-flow"] | all' <<<"$out" 2>/dev/null)" == "true" ]]
}

for sha in $(git rev-list --no-merges "${base}..${head}"); do
  author="$(git log -1 --format='%an <%ae>' "$sha")"
  if git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" | grep -Fqx -- "$author"; then
    echo "ok   ${sha:0:10} $author"
  elif [[ "$pr_author" == "dependabot[bot]" && "$author" == "$DEPENDABOT" ]]; then
    if signed_by_github "$sha"; then
      echo "ok   ${sha:0:10} $author (Dependabot, signed by GitHub: exempt, ADR-0039)"
    else
      echo "::error::${sha:0:10} claims Dependabot as its author, but the exemption could not be verified (not signed by GitHub for Dependabot, or the lookup failed), and it has no sign-off"
      fail=1
    fi
  else
    echo "::error::${sha:0:10} has no 'Signed-off-by: $author' trailer (use git commit -s)"
    fail=1
  fi
done

exit "$fail"
