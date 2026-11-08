<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# Releasing the npm packages

`@woodpatch/gcode-core`, `-viewer`, `-editor` and `-svelte` release together, at one
version, from `main`, by hand. The reasons are in ADR-0051 (`docs/DECISIONS.md`).

## Once: the GitHub environment

Settings › Environments › `npm-release`:

- **Required reviewers:** the operator. Leave "Prevent self-review" off: the person who
  starts a release also approves it.
- **Allow administrators to bypass:** off, so every run stops for approval.
- **Deployment branches and tags:** "Selected branches and tags", with the one rule
  `main`. ("Protected branches only" doesn't see repository rulesets, so it would let
  every branch through.)

Until these are in place, a release run refuses at its first steps: GitHub would
otherwise create the environment on first use with no protection at all.

## Each release

1. **Version PR.** On a branch from `main`, run `pnpm changeset version`. Check the four
   packages moved to the same version and read the changelogs. Then refresh the
   allowlists, in case the version added files (a CHANGELOG.md, say):
   `pnpm build && node scripts/check-pack.mjs --out /tmp/packs --write`.
   Review that difference too. Open the PR; merge it when CI is green.
2. **Dry run.** Actions › `release-npm` › Run workflow, from `main`, with "Dry run"
   ticked. Approve the `publish` job when GitHub asks. Its summary should list the four
   packages as "dry run: would publish" (or "skipped: already published, identical").
3. **Release.** Run it again with "Dry run" unticked, and approve. The summary lists each
   package as published, with provenance.
4. **Check.** Each package's npm page shows the version, with a provenance badge linking
   to the workflow run.

A failed run can be run again: what is already published, byte for byte, is skipped.

## The first release through trusted publishing

npm deletes a trusted-publisher setup 48 hours after it is created unless a publish
through it has validated it: it stays visible on the package page, but does nothing.
So, for the first release after the bootstrap (and whenever a package's trusted
publisher shows as not yet validated, or has expired):

1. Do steps 1 and 2 above as usual.
2. Immediately before step 3, on each package's npm page, Settings › Trusted Publisher ›
   GitHub Actions (delete an expired one first):
   - Organization or user: `WoodpatchAU`
   - Repository: `woodpatch-gcode-toolkit`
   - Workflow filename: `release.yml`
   - Environment name: `npm-release`
3. Run step 3 within 48 hours. Its publish validates the four setups, and binds them to
   this repository for good. If npm refuses the publish, the log points here: the likely
   cause is a setup that wasn't created, or has expired.

## The first release only: the bootstrap

npm attaches a trusted publisher only to a package that already exists, so the first
publish of each package needs a token. Before step 3 of the very first release:

1. On npmjs.com: Access Tokens › Generate New Token › **Granular**. Permissions: **Read
   and write**, packages limited to the `@woodpatch` scope. Expiry: **1 day**. Don't tick
   "bypass two-factor authentication" unless npm refuses the publish without it.
2. Add it as the `npm-release` environment's secret `NPM_BOOTSTRAP_TOKEN` (an environment
   secret, not a repository one).
3. Run step 3. The log warns that the token was used, naming the packages.
4. Delete the `NPM_BOOTSTRAP_TOKEN` secret, and revoke the token on npmjs.com (it would
   expire in a day anyway).
5. On each package's npm page, Settings › Publishing access: **Require two-factor
   authentication and disallow tokens**. No token can publish again.

Don't attach the trusted publishers now: nothing would validate them within 48 hours.
Attach them just before the next release, as in the section above. From then on,
releases need no secret at all.
