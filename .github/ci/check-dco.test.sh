#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
# SPDX-License-Identifier: MIT
#
# Tests for check-dco.sh, the Dependabot exemption above all: every condition must be
# needed. A fake `curl` first on PATH answers the verification lookup, so the script
# under test has no test hook of its own.
#
# Usage: check-dco.test.sh [path/to/check-dco.sh]
set -euo pipefail

script="$(realpath "${1:-$(dirname "$0")/check-dco.sh}")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir "$tmp/bin"
cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf '{"commit":{"verification":{"verified":%s}}}' "${FAKE_VERIFIED:-false}"
FAKE
chmod +x "$tmp/bin/curl"

repo="$tmp/repo"
git init -q "$repo"
commit() { # commit <name> <email> [message-extra]
  git -C "$repo" -c user.name="$1" -c user.email="$2" commit -q --allow-empty -m "change${3:+

$3}"
}
commit base base@invalid
base="$(git -C "$repo" rev-parse HEAD)"

event() { printf '{"pull_request":{"user":{"login":"%s"}}}' "$1" >"$tmp/event.json"; }

failures=0
expect() { # expect pass|fail <description>
  local want="$1" desc="$2" got
  if (cd "$repo" && PATH="$tmp/bin:$PATH" GITHUB_EVENT_PATH="$tmp/event.json" \
    GITHUB_REPOSITORY=o/r GH_TOKEN=t bash "$script" "$base" HEAD >/dev/null 2>&1); then
    got=pass
  else
    got=fail
  fi
  if [[ "$got" == "$want" ]]; then
    echo "ok   $desc"
  else
    echo "FAIL $desc (expected $want, got $got)"
    failures=$((failures + 1))
  fi
  git -C "$repo" reset -q --hard "$base"
}

BOT_NAME='dependabot[bot]'
BOT_MAIL='49699333+dependabot[bot]@users.noreply.github.com'

event someone
commit Ann ann@invalid 'Signed-off-by: Ann <ann@invalid>'
expect pass 'a signed-off human commit'

event someone
commit Ann ann@invalid
expect fail 'a human commit without sign-off'

event dependabot[bot]
commit "$BOT_NAME" "$BOT_MAIL"
FAKE_VERIFIED=true expect pass 'Dependabot: its PR, its author, verified'

event dependabot[bot]
commit "$BOT_NAME" "$BOT_MAIL"
FAKE_VERIFIED=false expect fail 'Dependabot commit, not verified'

event someone
commit "$BOT_NAME" "$BOT_MAIL"
FAKE_VERIFIED=true expect fail "Dependabot's author on a PR someone else opened"

event dependabot[bot]
commit Ann ann@invalid
FAKE_VERIFIED=true expect fail "a human's unsigned commit on Dependabot's PR"

event dependabot[bot]
commit "$BOT_NAME" "1+dependabot[bot]@users.noreply.github.com"
FAKE_VERIFIED=true expect fail 'a look-alike author address'

event dependabot[bot]
commit "$BOT_NAME" "$BOT_MAIL"
commit Ann ann@invalid
FAKE_VERIFIED=true expect fail "a human's unsigned fix-up after Dependabot's commit"

if [[ "$failures" -gt 0 ]]; then
  echo "::error::check-dco.sh: $failures test(s) failed"
  exit 1
fi
