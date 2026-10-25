#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
# SPDX-License-Identifier: MIT
#
# Installs Node, pnpm and shellcheck for CI without any third-party GitHub Action.
#
# Why not actions/setup-node or pnpm/action-setup: this CI uses no actions at all,
# not even GitHub's own (ADR-0006), and the repository's Actions policy blocks
# third-party ones. A plain download, checked against a pinned hash, is a smaller
# supply-chain surface than an action we would have to trust on every run.
#
# Every download is checked against a hash PINNED IN THIS FILE, not against a
# checksum fetched from the same server, so a compromised mirror or registry
# cannot substitute a binary. Bumping a version means bumping its hash here too.
set -euo pipefail

NODE_VERSION=22.23.4
NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce # node-v22.23.4-linux-x64.tar.xz

PNPM_VERSION=12.4.2 # must match "packageManager" in package.json
PNPM_SHA512=CK3GYTGAJ1x8ntraOdzwjJxhrU5+rzMKTzRh8QKw+QdCNFTRF/mOctR/7wYWBwZE17/8lzpqV/UJCm18NosHyQ==

# For the estimate server's tripwire (ADR-0046). Approved by the operator for CI only,
# 2026-10-25, pinned and hash-checked like Node. The hash matches GitHub's published
# digest for the release asset.
SHELLCHECK_VERSION=0.11.0
SHELLCHECK_SHA256=8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198 # the v0.11.0 linux.x86_64 .tar.xz

tools="${RUNNER_TEMP:-/tmp}/toolchain"
mkdir -p "$tools"
cd "$tools"

# ── Node ──────────────────────────────────────────────────────────────────
node_tar="node-v${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLo "$node_tar" "https://nodejs.org/dist/v${NODE_VERSION}/${node_tar}"
echo "${NODE_SHA256}  ${node_tar}" | sha256sum -c --quiet -
tar -xJf "$node_tar"
node_bin="$tools/node-v${NODE_VERSION}-linux-x64/bin"
export PATH="$node_bin:$PATH"

# ── pnpm ──────────────────────────────────────────────────────────────────
# Fetch the tarball, check it against the pinned npm integrity (sha512, base64),
# then install from the verified local file with lifecycle scripts disabled.
# pnpm runs through Node when its native-binary install script is skipped.
curl -fsSLo pnpm.tgz "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz"
actual="$(openssl dgst -sha512 -binary pnpm.tgz | base64 -w0)"
if [[ "$actual" != "$PNPM_SHA512" ]]; then
  echo "::error::pnpm ${PNPM_VERSION} tarball integrity mismatch" >&2
  exit 1
fi
npm install -g --ignore-scripts --no-fund --no-audit ./pnpm.tgz >/dev/null

# ── shellcheck ────────────────────────────────────────────────────────────
sc_tar="shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz"
curl -fsSLo "$sc_tar" \
  "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/${sc_tar}"
echo "${SHELLCHECK_SHA256}  ${sc_tar}" | sha256sum -c --quiet -
tar -xJf "$sc_tar"
sc_bin="$tools/shellcheck-v${SHELLCHECK_VERSION}"

# Make them visible to later steps.
echo "$node_bin" >> "${GITHUB_PATH:-/dev/null}"
echo "$sc_bin" >> "${GITHUB_PATH:-/dev/null}"
echo "node $(node --version), pnpm $(pnpm --version), shellcheck $("$sc_bin/shellcheck" --version | sed -n 's/^version: //p')"
