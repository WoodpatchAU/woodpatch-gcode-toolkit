<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# Architecture decision records

One entry per decision: context, the decision, and its consequences. Entries are
never deleted. A reversed decision gets a new entry that supersedes the old one, and
the old one is marked as superseded.

Status values: **Accepted** · **Pending** (proceeding on a stated default, isolated so
it can be reversed) · **Superseded by ADR-NNNN**.

---

## ADR-0001: Licence: elect the MIT arm of upstream's dual licence

**Status:** Accepted, 2026-09-22.

**Context.** Upstream webgcode is offered by Nicolas Raynaud under **MIT or AGPL-3.0**,
in a single licence file. Under a dual licence the recipient chooses. An earlier draft
of the programme plan assumed AGPL-3.0, with a separate MIT arrangement for internal
use. That split turned out to be unnecessary once the licence file was read directly.

**Decision.** Distribute this project under **MIT**.

- `LICENSE`: the MIT text verbatim, carrying both copyright lines (Nicolas Raynaud
  2016; this project 2026). The election is explained in `NOTICE`, never inside the
  permission notice.
- `LICENSE.txt`: upstream's own dual-licence file, **byte-identical and at its
  original path**. It arrived with the fork's history. A second copy (a planned
  `LICENSE.upstream`) was deliberately not added, because two files would give two
  answers to "which one is upstream's?". CI checks its SHA-256.
- `NOTICE`: upstream, author, fork point, the election, and the built-artefact rule
  (ADR-0009).

**Consequences.** There is no copyleft and no network-use source-offer obligation. A
visible "Based on webgcode by Nicolas Raynaud" credit is courtesy rather than a
requirement, and `@woodpatch/gcode-core` exports it as `ATTRIBUTION` so every surface
uses the same wording. The obligation that does remain is MIT's notice condition,
which ADR-0009 enforces mechanically. No CLA is needed (ADR-0008).

## ADR-0002: Copyright holder

**Status:** Accepted, 2026-09-24.

**Decision.** New work is `Copyright (c) <year> Promotional Notions Pty Ltd trading as
Woodpatch House & Garden`, which is the legal entity followed by its trading name. It
appears in `LICENSE`, `NOTICE` and each file's `SPDX-FileCopyrightText`. Upstream
files keep `Nicolas Raynaud`.

## ADR-0003: Stack

**Status:** Pending (proceeding on the default).

**Default.** pnpm workspace monorepo; TypeScript in strict mode; `core` has zero
runtime dependencies and runs in Node, browsers and workers; viewer on current
three.js; editor on CodeMirror 6; Svelte 5 components for host apps; a small Node HTTP
service for server-side estimates; Vitest; esbuild for package builds; Changesets for
releases.

**Isolation.** Host frameworks sit at the edge. `core`, `viewer` and `editor` are
framework-free, and only `svelte` depends on Svelte, so changing the host framework
replaces one thin package.

## ADR-0004: Repository name and home

**Status:** Accepted, 2026-09-22.

**Decision.** `chrisgrulau/woodpatch-gcode-toolkit`, a GitHub **fork** of
`nraynaud/webgcode`, so that the "forked from" relationship and the full upstream
history carry through. `main` is cut from upstream `gh-pages` HEAD (`d315a359`), tagged
`upstream-2025-09-18`. Upstream's `gh-pages` and `master` are left untouched.
`upstream` is kept as a git remote. History is never force-pushed.

_Moved 2026-09-27:_ the repository now lives at `WoodpatchAU/woodpatch-gcode-toolkit`, a
GitHub organization, after an owner transfer. It is still a fork of `nraynaud/webgcode`,
with its history intact. Old URLs redirect for git, but not for GitHub Pages: the
playground moved with it, to https://woodpatchau.github.io/woodpatch-gcode-toolkit/.

## ADR-0005: Park upstream under `legacy/`; licensing scope for it

**Status:** Accepted, 2026-09-24.

**Context.** Only about 1,000 lines of upstream (the parser, planner and viewer core)
matter to this project, and they are being rewritten rather than ported. The rest is
CAM, USB machine control and STM32 firmware. Upstream also vendors about 218 files of
third-party libraries in `webapp/libs/`, and about 70 of them carry no licence header.

**Decision.**

- The whole upstream tree moves under `legacy/` via `git mv` in one PR with no content
  edits, so `git log --follow` keeps working. `legacy/` keeps its internal layout, so
  the old simulator's relative paths and the Phase 1 harness still work.
- `legacy/` is **never built, linted, bundled, published or served**. It stays for
  one release as a reference and is then deleted. Git history and the
  `upstream-2025-09-18` tag preserve it regardless.
- **Licensing records** (`REUSE.toml`): upstream's own files are annotated
  `MIT OR AGPL-3.0-only`, © 2016 Nicolas Raynaud. The vendored libraries in
  `legacy/webapp/libs/**` are redistributed as received, each under its own licence.
  _Amended 2026-09-25:_ the Phase 0 placeholder `LicenseRef-legacy-vendored` is
  retired. A per-library audit ([`docs/legacy-libraries.md`](legacy-libraries.md): 38
  top-level entries grouped into 34 rows) records each library's real SPDX identifier:
  MIT, BSD-2-Clause, BSD-3-Clause, BSL-1.0, ISC, OFL-1.1, and MIT-or-BSD-3-Clause for
  RequireJS.
  - **Four Ace modes were removed**: `mode-r`, `mode-rdoc`, `mode-rhtml` and `mode-tex`.
    They are RStudio's contributions to Ace, under **AGPL-3.0-only** with no
    permissive alternative. Nothing loads them; the only mode upstream sets is
    `javascript`. This is a deliberate, recorded deviation from "as received". The
    files remain in history and at the upstream tag.
  - Flot's resize plugin is dual MIT/GPL, and **MIT is elected**. That's recorded as an
    election in the table.
  - With those two handled, every file in the tree is under a permissive licence.
  - One file can't be pinned down: `yenc.js`, whose author declared only "BSD" and
    shipped no text (`LicenseRef-yenc-BSD-unspecified`).

  The audit table is the single source (`tools/data/legacy-libs.json`). A generator
  writes both `REUSE.toml` and the doc, and CI fails if either drifts from the table.
  **The same check reads every covered file's header** and fails on a GPL-family
  notice that the table doesn't account for. That is how the four Ace modes should
  have been caught the first time, and it's mutation-tested. Nothing may be copied from
  `libs/` into the toolkit's packages without first checking that library's entry.

- The one planned consumer is `tools/legacy-harness.cjs`. It loads
  `libs/jsparse.js` (Chris Double, BSD-style licence per its header) at test time
  only.

**Alternative rejected.** Deleting `libs/` apart from `jsparse.js` now. That would
make the licensing trivially clean, but it breaks the legacy simulator, which Phase 1
needs to benchmark upstream rendering.

## ADR-0006: CI on GitHub-hosted runners, with no third-party actions

**Status:** Accepted, 2026-09-24.

**Context.** The repository's Actions policy permits only actions defined in the
owner's own repositories, pinned to full commit SHAs, so `actions/checkout` and
`actions/setup-node` are unavailable. The repository is public.

**Decision.**

- **GitHub-hosted runners only.** A self-hosted runner on a public repository would
  execute arbitrary fork-PR code on our own infrastructure.
- **No `uses:` steps.** Checkout is a few lines of `git`. Node and pnpm are downloaded
  by `.github/ci/setup-toolchain.sh` and verified against hashes **pinned in that
  file** (not against checksums fetched from the same server). Bumping a tool
  version means bumping its hash in the same commit.
- `permissions: contents: read`. Event values reach shell through `env`, never
  through `${{ }}` interpolation into script text.
- One tool is version-pinned but not hash-pinned: `reuse`, run via
  `pipx run 'reuse==6.2.0'`. That is accepted because its blast radius is its own
  job, which has `contents: read`, no secrets and no artefact output. Hash-pin it
  (`--require-hashes`) if that job ever gains write access or produces output
  anything else consumes.
- The jobs (`checks`, `reuse`, `provenance`) are the required status checks on `main`.
  Renaming a job means updating branch protection.

_Policy changed 2026-09-27:_ since the move to the WoodpatchAU organization, the Actions
policy also allows actions created by GitHub (still SHA-pinned, and third-party
actions are still blocked), so `actions/checkout` and `actions/setup-node` would now be
permitted. The decision stands, but **no actions is now a choice, not a constraint**:
plain `git` and hash-pinned downloads keep the trust surface to files we can read and
hashes we pin, and they don't depend on the policy staying as it is. The CodeQL default
setup GitHub runs on this repository is GitHub's own, not part of this CI.

## ADR-0007: Dependency supply-chain safeguards

**Status:** Accepted, 2026-09-24.

**Decision.**

- `minimumReleaseAge: 10080` in `pnpm-workspace.yaml`: no dependency version younger
  than 7 days is resolved. Most malicious npm releases are detected and pulled within
  that window.
- Dependency install scripts are blocked (pnpm's default). Each exception is listed
  in `allowBuilds` with the reason. The only one so far is `esbuild: false`: its
  script only swaps in a native binary for startup speed, and esbuild works without
  it.
- Exact tool versions: pnpm via `packageManager`, and reuse pinned in CI. The
  lockfile is always installed `--frozen-lockfile`.
- TypeScript is pinned to `~6.0` because `typescript-eslint` does not yet support
  TypeScript 7. Revisit when it does.

## ADR-0008: DCO sign-off instead of a CLA

**Status:** Accepted, 2026-09-24.

**Context.** A CLA was planned under the AGPL assumption, so that contributions could
be relicensed for internal use. Under MIT (ADR-0001), inbound and outbound licences
are the same.

**Decision.** Every PR commit carries `Signed-off-by:` matching its author
([DCO](https://developercertificate.org)). `.github/ci/check-dco.sh` enforces it in
the `provenance` job.

## ADR-0009: MIT's notice travels with built artefacts, enforced in CI

**Status:** Accepted, 2026-09-24.

**Context.** MIT's single condition is that its copyright and permission notice be
included in "all copies or substantial portions of the Software". For a browser
toolkit, the realistic way to break that is a bundler or minifier stripping the
header. The GitHub "forked from" badge is attribution, not a notice.

**Decision.**

- `scripts/build-package.mjs` prepends a `/*! … */` legal banner to every package's
  built entry. It is **generated from `LICENSE` itself**, so it cannot drift, and
  carries both copyright lines, the permission notice and the upstream credit.
- Every publishable package declares `"license": "MIT"` and ships `LICENSE` and
  `NOTICE`, copied from the root at build time.
- `scripts/check-package-licences.mjs` (CI, `checks` job) fails unless all of the
  following hold:
  - the manifest is right;
  - the copies are byte-identical to the root;
  - `npm pack` would include them;
  - the built entry starts with the banner;
  - the banner survives a **minified consumer bundle** under both of esbuild's
    legal-comment-preserving modes.
- The check requires the permission-notice text, not only the name "Nicolas
  Raynaud". The name also appears in `ATTRIBUTION`'s data, so a bare name grep would
  pass even with the notice stripped. A negative test confirmed this.

**Consequences for consumers.** Vite's production build drops legal comments by
default. Any app that bundles these packages must opt in (for example esbuild
`legalComments: 'inline'` or `'eof'`) and should grep its own build output the same
way.

## ADR-0010: The workspace root is not an ES-module package

**Status:** Accepted, 2026-09-24.

**Context.** With `"type": "module"` in the root `package.json`, Node loads
upstream's CommonJS/AMD files under `legacy/` as ES modules. `require()` then returns
a frozen module namespace, and the legacy harness fails when jsparse tries to set
`memoize`.

**Decision.** The root `package.json` has no `"type"`. Root-level ESM files use
`.mjs`, and CommonJS tooling uses `.cjs`. Packages under `packages/` declare
`"type": "module"` themselves.

## ADR-0011: The programme plan is not kept in this repository

**Status:** Accepted, 2026-09-24; ratified by the operator, 2026-09-26.

**Context.** The original plan asked for a copy of itself in the repo as
`docs/PLAN.md`. That plan is an internal document: it describes internal
infrastructure, business systems and commercial processes. This repository is public.

**Decision.** The plan stays internal and is **not** kept here. This file (the ADR log)
is the public record of decisions and their reasons, and the README describes status
and layout. The same rule applies to everything else committed here: package
descriptions, comments and docs name no internal hosts, systems or customers, and
refer to consumers only as "consuming applications". Customer G-code never enters
this repository or its history.

## ADR-0012: Characterisation goldens: what they record, and how big they may be

**Status:** Accepted, 2026-09-25 (operator chose "option C").

**Context.** Phase 2 rewrites upstream's parser. To show that every behaviour change is
deliberate, upstream's own output (bugs included) is recorded first, as _goldens_. A full
path for the large upstream samples would be about 46 MB (aztec alone is 34 MB), and
git keeps every version forever.

**Decision.**

- `tools/golden-legacy.cjs` runs upstream's parser and simulator (via
  `tools/legacy-harness.cjs`) over `fixtures/synthetic/` and `fixtures/upstream/`, and
  writes `fixtures/golden/legacy/**.json`. Each golden records:
  - the outcome (ok, or the thrown error's class);
  - upstream's reported errors;
  - its console output;
  - the simulator's bounding box and time;
  - the path, as compact tuples.
- **Size policy (option C).** A path of at most 10,000 segments is stored in full.
  Above that, the golden stores the summary, the first and last 200 segments, and a
  SHA-256 of the full canonical path. Any change to any segment is detected, and
  `--full <file>` prints the whole path locally for diagnosis. Total size is about
  590 KB, against about 46 MB for full paths.
- Numbers are rounded to 6 decimals and `-0` is normalised. NaN and ±Infinity are
  stored as strings, because upstream really produces them (R2).
- The worker `$` (what the live simulator ran) is the primary record. For synthetic
  cases, the jQuery-faithful `$` is also run and recorded only where it differs. Today
  that is R1 with `SIN`, exactly the root cause the plan identified.
- **CI regenerates every golden and fails on any difference**, so goldens change only
  through the reviewed generator. `tools/legacy-reference.test.cjs` checks the goldens
  against independently published reference measurements (error counts, bounding
  boxes, times) for all four upstream samples.

**Consequences.** Where upstream was right, Phase 2 must match these goldens; where it
was wrong, it must differ, and each difference is listed. Deleting or regenerating a
golden to make a test pass defeats the purpose, so the generator is the only writer.

## ADR-0013: Commit identity

**Status:** Accepted, 2026-09-25.

**Decision.** Keep the current commit identity. Squash-merges on `main` are authored by
the automation bot's GitHub no-reply address, and the branch commits' `Signed-off-by:`
lines keep the contributing role's address. Past history is not rewritten.

## ADR-0014: Phase 2 performance target is parse + interpret

**Status:** Accepted, 2026-09-26 (operator).

**Context.** The original target was "the 224k-line aztec sample parses in ≤ 2 s in
Node". Upstream already parses it in 1.4 s (ANALYSIS §9), so parse-only is barely a bar.

**Decision.** The target is **parse + interpret ≤ 2 s** for aztec_calendar.ngc on the
reference machine and pinned Node. After parcel 2a, the lossless tokenizer alone takes
about 0.84 s (872,824 tokens, 0 diagnostics), which leaves about 1.1 s for the
interpreter.

**Enforced in CI** (amended 2026-09-26, reviewer, toolkit #10). Absolute times on a CI
runner can't be compared with a target set on the reference machine, so CI checks a
**ratio**: core parse + interpret of aztec, divided by upstream's own parse of aztec, both
measured on the same runner in the same job (`node tools/bench-core.mjs --ci`). On the
reference machine the target is 2000 / 1379 ms = **1.45×**. After parcel 2c-1 the ratio is
about 1.3×, so the remaining budget is visible, and spending it fails the build.

_Measurement amended 2026-09-26 (toolkit 2c-2)._ The core's own time varies about ±10%
between measurements, because parsing aztec allocates about 2.6 million small objects and
the garbage collector's timing varies. Upstream's time is steady. So the gate:

- times each side in its own block, core first, with a forced collection before every
  run (`node --expose-gc`), keeping the minimum;
- retries a measurement that comes out over budget, up to 3 attempts, and fails only
  if all are over.

A real regression fails every attempt; noise rarely does. Every attempt is printed. The
lasting cure is fewer allocations: the path model (2d) avoids per-segment objects, and a
leaner token representation is the next lever if the budget stays tight.

_Ratcheted 2026-09-26 (reviewer, toolkit #11)._ The fast path never ran in 2c-2's first
cut: the G letter was missing from its table. The fix (203eab0) roughly halved the core's
time. The measurements:

| Where           | Before the fix | After       |
| --------------- | -------------- | ----------- |
| Locally (aztec) | about 1.6 s    | about 0.8 s |
| Locally (ratio) | —              | about 0.65× |
| CI (ratio)      | 1.38×          | 0.74–1.04×  |

The CI range is for near-identical code on different runners: upstream's own parse
alone ranged from 486 to 943 ms. So the ratio is less machine-independent than assumed
above.

The limit is now **1.2×**. That protects most of the gain and catches a slide back
towards the old 1.4×, without failing on runner variation. The cost is that on a
slow-ratio runner, a regression of up to about 15% can still pass.

A pass that needed a retry now prints a `::warning::` annotation, so creep shows on the
PR's checks and not only in a log nobody reads. The 2 s absolute target on the reference
machine is unchanged, and now has about 60% headroom.

## ADR-0015: Primary dialect is Masso G3, firmware v5.13

**Status:** Accepted, 2026-09-26 (operator).

**Decision.** The `masso-g3` dialect profile is built from Masso's published G-code
reference for **firmware v5.13**, the version in use. Every code on that list is either
implemented or produces a diagnostic, and none is silently ignored. A `generic` profile
sits alongside it. Masso differs from the LinuxCNC-style model in ways the core must
handle per dialect, not globally:

- Fanuc-style `M98`/`M99` subprograms rather than O-word `sub`/`call`;
- canned cycles G73 and G81–G83 only;
- G68/G69 coordinate rotation, G38.x probing and G54.1 extended offsets;
- machine-specific M-codes.

## ADR-0016: Cutter compensation is drawn uncompensated, with a warning

**Status:** Accepted, 2026-09-26 (operator).

**Decision.** In Phase 2, G41/G42 are recognised and tracked in the modal state, and
the path is drawn **uncompensated**. A warning on the G41/G42 line says so, and names
the D offset that was not applied. Real offset-path compensation goes on the roadmap.
CAM output rarely relies on controller compensation, and a clearly-labelled
uncompensated path is honest where a half-right offset would not be.

## ADR-0017: The lossless line model

**Status:** Accepted, 2026-09-26.

**Decision.** The syntax layer (`packages/core/src/syntax/`) keeps each line's exact
text and line ending. Tokens hold only spans into that text.

- `write(parse(x)) === x` for **any** input. It is property-tested on arbitrary
  unicode and on every fixture.
- Edits splice text into spans (`editLine`), so every untouched byte survives.
- Spans are UTF-16 code-unit offsets (what JavaScript strings and CodeMirror use).
- Lines are numbered from **1**. Upstream's golden files use 0-based `lineNo`, and the
  parity ledger (parcel 2f) maps between them.
- LF, CRLF and bare CR are all line breaks, and each line records its own. A leading
  BOM is recorded and stripped. The final line always exists, even when it's empty,
  which matches editors.
- The syntax layer is **letter-agnostic**. `A`, `D` and `E` are simply words, and
  whether they mean anything is for the dialect and the interpreter. A bad character
  or an unterminated comment is reported and skipped, and the rest of the line is
  still read. Upstream dropped the whole line (R7).
- Whitespace outside comments is insignificant, including inside a number, per
  RS274/NGC. Upstream did the same. `X1 0` reads as `X10`, with an info diagnostic
  because it's unusual.
- `X1e3` reads as `X1` then an `E3` word, as in RS274, with a warning that
  G-code has no exponent notation (R6).
- Parsing never throws. `editLine` throws only on programming errors (overlapping
  edits, or an inserted line break).

## ADR-0018: Expression rules are per-dialect data; LinuxCNC is the verified default

**Status:** Accepted, 2026-09-26.

**Context.** Controllers disagree about how expressions evaluate, and upstream matched
none of them on several points (ANALYSIS §3, N13–N15).

**Decision.** `packages/core/src/expr/` parses and evaluates expressions under an
`ExpressionRules` object, so each dialect profile (parcel 2e) picks its rules instead of
the core hard-coding them. The rules cover:

- precedence levels;
- equality tolerance;
- angle unit;
- MOD sign;
- ROUND halves;
- undefined named parameters;
- the maximum parameter number;
- the maximum nesting depth.

`LINUXCNC_RULES` is the default. **Each of its values was checked against LinuxCNC's
interpreter source, not recalled:**

| Rule                      | Value                                                         | Source                                                         |
| ------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Precedence                | `**` · `* / MOD` · `+ -` · `EQ NE GT GE LT LE` · `AND OR XOR` | LinuxCNC G-code overview, "Operators Precedence"               |
| Equality tolerance        | 1e-6, applied to **EQ, NE, GE and LE only**                   | `TOLERANCE_EQUAL` (`interp_internal.hh:89`); `execute_binary2` |
| GT and LT                 | **plain** `l > r` and `l < r`, with no tolerance              | `interp_execute.cc:156`, `:175`                                |
| Angle unit                | degrees                                                       | `sin(x·π/180)`, `asin(x)·180/π`                                |
| MOD                       | always positive                                               | `interp_execute.cc`: "always calculates a positive answer"     |
| ROUND                     | half away from zero                                           | `(int)(x ± 0.5)`                                               |
| Undefined named parameter | error                                                         | `interp_namedparams.cc:192`                                    |
| Numbered parameters       | 1–5601                                                        | `RS274NGC_MAX_PARAMETERS = 5602` is an array size              |
| Unary +/−                 | before any value                                              | `read_real_value`, `interp_read.cc`                            |
| NaN / ±∞ result           | error                                                         | `read_real_value`                                              |

A consequence worth knowing: for two values within the tolerance of each other but not
equal (say l = r + 5e-7), `EQ`, `GE`, `LE` **and** `GT` are all 1. That looks
inconsistent, but it's what LinuxCNC does. A tidier rule would not be faithful to the
controller, so a test pins the corner (reviewer, toolkit #9).

Evaluation never throws. Division by zero, domain errors, undefined or non-integer
parameters and non-finite results are diagnostics pointing at the responsible
sub-expression. Nesting beyond `maxDepth` (64) is a diagnostic rather than a stack
overflow, which fixes R1: its own example `[SIN[0]+10]` now simply evaluates to 10.

## ADR-0019: The interpreter's contract

**Status:** Accepted, 2026-09-26.

**Decision.** `packages/core/src/interp/` turns a parsed program into an ordered list of
`Step`s: linear moves, arcs, dwells, tool changes, spindle, coolant, pauses and the
program end.

- **Order of execution** within a line follows RS274/NGC as LinuxCNC documents it
  ("Order of Execution"), not the order the words are written. That includes **F
  before G20/G21**: `G20 G1 X1 F10` from G21 feeds at 10 mm/min, as in LinuxCNC
  (`execute_block` runs `convert_feed_rate` before `convert_length_units`). Controllers
  disagree on this line, so it's **dialect data** (`InterpreterRules.feedUnits`:
  `at-feed-step`, the LinuxCNC default, or `end-of-line`), and a line that changes units
  alongside an F word gets a **warning** either way. A redundant G21 in a CAM header
  doesn't warn. A feed set on an earlier line stays physically the same across a unit
  change, as in LinuxCNC. _Amended 2026-09-26 (reviewer, toolkit #10): the first draft
  used end-of-line units as the default, which is the opposite of LinuxCNC. Masso's
  behaviour is not yet known; see ADR-0015._
- **Positions are machine coordinates in millimetres.** Every move also carries the
  total work offset in force (coordinate system + G92/G52), so work coordinates are
  `position − offset`. G53, G10, G92 and coordinate-system changes then compose
  exactly, and a viewer can still draw in work coordinates.
- **Offsets live in LinuxCNC's parameter layout**, verified against its "Numbered
  Parameters" documentation. Programs that read or write them (`#5221` and so on) see
  consistent values:
  - G28 home #5161; G30 home #5181;
  - G92/G52 flag #5210 and offsets #5211;
  - active coordinate system #5220;
  - coordinate system _n_ at #5221 + 20(n−1).

  Values are stored in millimetres.

- **A line that can't be executed is reported, and its motion is skipped**, so the tool
  stays where it was (plan §4.2 item 4). That covers:
  - an unknown or not-yet-interpreted code;
  - two codes from one modal group;
  - a repeated word (N3);
  - a letter the dialect doesn't have (E: R6);
  - a syntax or evaluation error;
  - a feed move with no feed rate (upstream silently used 200 mm/min, N10);
  - axis words claimed by both a group-0 code and an explicit motion code.

  Upstream reported such lines and then moved anyway (N5, N6).

- **Words with no effect** on their line (`G1 X1 R5`) are a _warning_, and the line
  still runs. LinuxCNC treats this as an error. We're deliberately lenient, because the
  line's meaning is unambiguous.
- **G28/G30** rapid to the optional intermediate point, then to the stored position,
  for the named axes or for all of them. A program can't know the machine's real stored
  positions, so when it never set them (G28.1/G30.1) the machine origin is used, with
  an info diagnostic saying so.
- **Arcs are described, not resolved.** Each arc step carries its plane, direction, an
  I/J/K centre (absolute, machine coordinates) or a signed R, and P turns. Resolving
  the R-format centre and rejecting impossible arcs is the geometry layer's job
  (parcel 2d: R2). A centre-format full circle with no axis words is legal and runs,
  fixing R3.
- **Not simulated, and said so:**
  - cutter compensation (a warning; ADR-0016);
  - tool length offsets (info; no tool table);
  - coordinate-system rotation (a warning);
  - machine I/O M-codes (a warning).
- **Program end:** M2, M30 or a second `%` ends the program. Later lines aren't run, and
  one info diagnostic says how many were skipped (R8). The block-delete switch
  defaults to **on**, as on most controllers.
- **Diagnostics:** the interpreter reports its own findings (including expression
  errors). Syntax findings stay on the `Program`.
- **Recognised but deferred**, with an error that names the parcel:
  - canned cycles G73 and G81–G89 (2c-2), so a canned cycle is no longer drawn as a
    rapid plunge (R4);
  - O-words and M98/M99 (2c-3).

  Controller-specific tables are for the dialect profiles (2e).

**Performance.** aztec_calendar (224k lines) parses and interprets in about 1.68 s,
the minimum of 10 runs on the reference machine via `node tools/bench-core.mjs`,
against ADR-0014's 2 s target. The geometry layer (2d) has to fit in the remaining
headroom, so it will build its path model without per-segment objects.

## ADR-0020: Canned cycles follow LinuxCNC's source, with the dialect differences as data

**Status:** Accepted, 2026-09-26.

**Reference version: LinuxCNC 2.9.x** (stable, v2.9.10), per the reviewer on toolkit #11.
All of this ADR holds on the 2.9 branch and on master, except the peck distances below.

**Decision.** G73, G81, G82 and G83 (XY plane) are interpreted as LinuxCNC's
interpreter does them, from `interp_cycles.cc` (`convert_cycle_xy`, `CYCLE_MACRO`,
`convert_cycle_g73/g81/g82/g83`) rather than its prose docs. The docs say G73 ends at R;
the source retracts to the clearance plane.

- **Preliminary motion:** starting below R, Z rises to R once. Each repeat traverses XY
  (at the current height on the first repeat if above R, otherwise at the clearance
  plane), then rapids down to R.
- **Clearance plane:** R under G99. Under G98, the level when the run of cycles began
  (LinuxCNC `cycle_il`), raised to R if it was below. That level resets whenever an
  ordinary motion runs.
- **G90:** R and Z are work Z levels. **G91:** R is relative to that initial level, and
  Z is relative to R; X/Y step from the current position.
- **G81:** feed to Z, then rapid to clear. **G82:** the same, with a dwell. **G83:** feed
  Q, rapid out to R, then rapid down to `clearance` above the last depth, and repeat.
  **G73:** feed Q, then back off by `retract`, and repeat. Depths are counted from R.
- **Sticky values:** Z, R, Q and P carry over while the same cycle stays active. The
  first line of a cycle must have them.
- **Errors** (the line doesn't run): no R, Z, Q or P on a cycle's first line; R below Z;
  Q ≤ 0; zero feed; inverse-time feed; cutter compensation on; a plane other than XY;
  rotary axis words; a repeat count that isn't a positive integer.
- **G84–G89** are recognised and reported as not implemented. LinuxCNC has them; Masso
  doesn't.

LinuxCNC's two worked G81 examples (absolute, and incremental with L3) are tests,
checked move for move against its documentation.

**Controller differences are `InterpreterRules`** (the dialect profiles in 2e pick them):

| Rule                        | LinuxCNC (default)          | Masso G3 (docs and the 2026-09-26 machine test) |
| --------------------------- | --------------------------- | ----------------------------------------------- |
| `dwellUnits` (G4 and G82 P) | seconds                     | **milliseconds**                                |
| `cycleRepeat`               | `L`, stepping X/Y under G91 | **`K`, at the same position**                   |
| `g73Retract`                | 0.254 mm (0.010 in)         | **1.0 mm**                                      |
| `g83Clearance`              | 0.254 mm                    | not documented; the default applies             |

The machine test confirmed Masso's G83 retracts to R between pecks and ends at the
initial Z under G98, as modelled.

**LinuxCNC 2.10 differs on the peck distances.** In 2.9, `G83_RAPID_DELTA` (0.010 in,
0.254 mm under G21) is used for both G73 and G83. On master (2.10; commits c9759fc1b1
and 6dd181d7be):

- the defaults become 1 mm on a metric machine and 0.050 in on an inch one
  (`rs274ngc_pre.cc`);
- they can be set by INI `G73_PECK_CLEARANCE` / `G83_PECK_CLEARANCE`;
- they can be set per block by a **D word**.

A 2.10 profile must set `g73Retract`/`g83Clearance` itself rather than inherit 0.254.
It also needs D read as the peck distance on G73/G83; today D there is an unused word.

---

## ADR-0021: Subprograms and program flow

**Status:** Accepted, 2026-09-26.

**Reference version: LinuxCNC 2.9.x.** The 2.9 branch was checked against master.

- They agree on everything this ADR relies on: control-flow labels scoped per sub
  (`sub#label` in `read_o`), #1–#30 handling, and named-parameter scoping.
- The call limit is the same 9. 2.9 increments `call_level` and then refuses at 10;
  master checks `call_level + 1 >= 10` before incrementing.
- Master adds checks this doesn't depend on: stricter nested-definition errors inside a
  called file, and no forward-seek in a called file.

**Decision.** LinuxCNC's O-word flow and Masso's M98/M99 subprogram files are both
interpreted. They follow LinuxCNC's `interp_o_word.cc` and `interp_read.cc` where the
source and the docs (`o-code.adoc`) differ. Which one a controller has is dialect data.

**O-words (LinuxCNC).** `sub`/`endsub`/`return`/`call`, `if`/`elseif`/`else`/`endif`,
`while`/`endwhile`, `do`/`while`, `repeat`/`endrepeat`, `break`/`continue`.

- **Structure is matched once, up front** (`buildFlowIndex`), not by seeking through the
  file at run time as LinuxCNC does. The index is built the first time the interpreter
  meets an O-word, so a program without O-words pays nothing.
- **Scope:** subroutine labels are global across all loaded files. Control-flow labels
  are local to the subroutine body, or the main program, they're in. Labels are
  normalised: `o0100` is `o100`, and `<My Sub>` is `<mysub>`.
- **Calls:** up to 30 arguments go into #1–#30, and **the unpassed ones are zeroed**.
  2.9's `read_o` says "zero the remaining params", and `execute_call` copies all 30, so
  `o<sub> if [#3 EQ 0]` reliably detects a missing argument. The caller's #1–#30 are
  restored on return. Parameters above #30 are global. _Corrected in review: the first
  cut kept the caller's values (reviewer, toolkit #12)._
- **Named parameters** are local to a call unless their name starts with `_`. That was
  already true of the main program.
- **Return values:** `endsub [v]` or `return [v]` sets `#<_value>` to v and
  `#<_value_returned>` to 1. With no value, both are set to 0 (2.9 `read_o`). They are
  not cleared at a call. Both are predefined (0 before any call) and read-only.
- **Truth:** a condition is true when non-zero. An `elseif` is evaluated whenever
  it's reached, even after an earlier branch ran: `read_o` skips evaluation only for
  other labels, so `[1/0]` there stops the run. A do loop's closing `while` is still
  evaluated after `break`.
- **A `repeat` count rounds half to even** (`round_to_int` is `nearbyint`), so
  `[2.5]` is 2 passes. 0 or less skips the body.
- **Forward calls:** a sub may be called before its definition in the main program. The
  docs forbid it; the source allows it (`control_back_to` step 3).
- **Definitions are skipped** in normal flow and run only when called. Flow reaching a
  definition already recorded is an error, and the run stops. That covers a definition
  after a forward call to it, or one inside a loop: 2.9's `control_save_offset` gives
  "sub … found in illegal location".
- **Other words on an O-word line are an error,** and the run stops. 2.9's `read_o`
  allows "nothing … except comments": "Unexpected character after O-word".
- **A failed call stops the run,** because 2.9 aborts: a subroutine that can't be
  found, a call nested too deep, more than 30 arguments, or an argument that can't be
  evaluated. Drawing on would show a path the machine won't take. _Corrected in review;
  the first cut skipped the call and carried on._
- **Structure errors stop the run.** Carrying on would run code that should be
  skipped, or skip code that should run. The errors are nested definitions, unmatched
  or reused labels, `else` after `else`, unclosed blocks, and `break`/`continue` outside
  a while or do loop. So does a missing or unevaluable condition, and an M99 ending an
  O-word sub.
- **Where we're stricter than 2.9:** it lets some of these pass, such as `else` after
  `else`, an unclosed `if` whose branch is true, and a `return` with the wrong label. A
  preview that flags them is on the safe side.
- **Not yet interpreted:** `o[expr]` label indirection, which the tokenizer doesn't
  read, and Python O-word subs.

**Subprogram files.** The core never reads files. The caller passes
`resolveProgram({ kind, name })`, which returns the file's text or `undefined`.

- The call is synchronous: an async caller fetches first.
- Each file is asked for once and parsed once.
- LinuxCNC `o<name> call` asks for `o-word:<name>` and runs that file's `o<name> sub`.
- Masso `M98 P<n>` asks for `m98:<n>`: the number with no leading zeros, which is the
  Masso rule for file names.
- A missing file, or a resolver that throws, is reported, and the run stops. That's
  what a failed call does on both controllers; Masso "enters Feed Hold".
- Steps and diagnostics from a file carry `file` (the resolver's name) and that file's
  own line numbers. `file` is absent for the main program, so existing consumers see no
  change.

**M98/M99 (Masso).** `M98 P<n> [L<runs>]` runs file n, L times (default once; `L0`
doesn't run it). #1–#30 are shared with the caller, not saved; named locals start
fresh, as in 2.9. The call runs after the rest of its line. M99 returns. A file that
ends without M99 returns with a warning. `%` is tracked per file, so a `%`-wrapped
subprogram file doesn't end the program.

- In the main program, M99 ends the drawing with a warning. LinuxCNC ends there unless
  configured to loop; Masso is untested.
- Under LinuxCNC rules, `M98 P<n>` means a numbered `O<n>` block in the same file (Fanuc
  style). That's reported as not interpreted yet, and the line is not run.

**Two kinds of limit, reported differently:**

| Limit                      | Whose            | Value                                         | Message                       |
| -------------------------- | ---------------- | --------------------------------------------- | ----------------------------- |
| `subprograms.maxCallDepth` | the controller's | LinuxCNC 9, Masso 5                           | stopped: fails on the machine |
| `limits.maxCallDepth`      | ours (resource)  | 64                                            | stopped: too large to process |
| `limits.maxLoopIterations` | ours             | 1,000,000 (while, do, repeat, M98 L)          | stopped                       |
| `limits.maxBlocks`         | ours             | 20,000,000 (each canned-cycle repeat counts)  | stopped                       |
| `limits.maxSteps`          | ours             | 2,000,000 steps: this is what bounds memory   | stopped                       |
| `limits.maxDiagnostics`    | ours             | 10,000; beyond that they're counted, not kept | a closing note                |
| `limits.maxPecks`          | ours             | 10,000 per G73/G83 hole                       | line refused                  |

- **LinuxCNC's 9:** `INTERP_SUB_ROUTINE_LEVELS` is 10, but it counts the main program.
  `enter_context` refuses when `call_level + 1 >= 10`. A test runs 9 levels and refuses
  a 10th.
- **Masso's 5** is from its manual ("up to 5 levels of sub-program nesting"). It isn't
  tested on the machine yet, so it goes on the next machine test sheet.
- The resource limits are `InterpretOptions.limits`, so a server can tighten them.
- Canned-cycle repeats (`L`/`K`) now count against `maxBlocks` before any motion is
  built, so `G81 … L1000000000` can't exhaust memory.
- **The G73/G83 peck loop could fail to terminate** (reviewer, toolkit #12; the code
  came from #11). With a Q below the float resolution of the depth, `d -= Q` stops
  changing d. The peck count, ceil(depth / Q), is now worked out up front. Over
  `maxPecks` the line is refused, the loop in `cycles.ts` is also bounded by the count,
  and the line's steps are checked against `maxSteps` before any are built.
- `maxSteps` and `maxDiagnostics` close the remaining memory route. A loop body of 19
  lines over a million iterations would otherwise exhaust memory long before
  `maxBlocks` tripped.

**Found on the way: a sign before a parameter, bracket or function.** `X-#1`, `X-[…]`,
`X+SIN[…]` and `X--#1` are values in LinuxCNC (`read_real_value` negates what follows).
The 2a tokenizer rejected them, and subroutine code uses them constantly. The tokenizer
now reads them as an expression whose span includes the sign; the expression parser
already handled a leading sign. The lossless property is unaffected.

**The R8 O-word fixtures** now differ from upstream deliberately.
`r8-o-word-sub.ngc` draws its move to X10 with no diagnostics; upstream gave three
"did not understand line" errors and drew nothing. `r8-program-number.ngc` reads its
`O1000` without complaint. Tests pin both against the legacy goldens.

---

## ADR-0022: Arcs are resolved and validated as LinuxCNC does; the path model

**Status:** Accepted, 2026-09-26.

**Reference version: LinuxCNC 2.9.x.** The logic of `arc_data_ijk`, `arc_data_r` and
`find_turn`, and the tolerance constants, are the same on the 2.9 branch and on master.
Several function signatures moved to enum classes on master; the substance didn't
change.

**Decision: arcs.** Every G2/G3 is resolved to a centre, a start radius, an end
radius and a signed sweep. The code is `interp/arcs.ts`, transcribed from
`interp_arc.cc` (`arc_data_ijk`, `arc_data_r`) and `interp_find.cc` (`find_turn`). An
arc the controller would refuse is reported, and the line doesn't run: the tool stays
where it was.

- **R format.** The centre is on the chord's perpendicular bisector, and a negative R
  takes the major arc.
  - A radius that can't reach the end point is an error (R2: upstream drew nothing and
    said nothing). There's a 0.00005 in (0.00127 mm) allowance, and a near-semicircle is
    snapped.
  - An end point equal to the start is an error.
  - An arc with no in-plane axis word is an error: a full circle can't be given by R.
- **Centre format.** An arc with no axis words is a full circle (R3: upstream dropped
  it). A centre on the start or end point is an error.
- **Radius mismatch** between start and end, as `arc_data_ijk` judges it:
  - over 100× the tolerance is always an error;
  - over 1× the tolerance is an error only if the mismatch also exceeds 0.1% of the
    radius.
  - The tolerance is 0.0283 mm, or 0.00283 in for inch programs. Units are the
    program's, as in LinuxCNC.
  - An accepted mismatch is a spiral: the radius changes evenly with angle, which is
    how LinuxCNC's planner moves.
- **Sweep: the path the machine cuts** (corrected in review, toolkit #14). The first
  cut used the interpreter's `find_turn`. In 2.9 that only feeds arc length and inverse
  time. The motion planner's `pmCircleInit` (`_posemath.c`) decides the path cut, so
  `motionSweep` transcribes it:
  - the angle between the start radius and the end radius, projected and scaled, taken
    the long way round when (rTan × rEnd)·normal < `CART_FUZZ` (1e-8);
  - **a FULL circle when the start and end, projected onto the plane, are within
    1e-8**. That's the case after incremental moves that return to the start with
    rounding noise, where `find_turn` gave a sweep of zero and drew nothing;
  - `CIRCLE_FUZZ`/2 for an angle of exactly zero;
  - 2π for each extra turn.
- **One deliberate numerical difference:** the angle is computed as
  atan2(|cross|, dot), not acos(dot / r²). They're the same angle, but acos rounds to 0
  for a 10 mm chord at radius 1e14, which would make it a 50 km arc. `find_turn` is kept
  and exported; away from the fuzz a test holds the two equal.
- Positive sweep is counter-clockwise from the plane's first axis to its second (XY, ZX,
  YZ). P within 0.001 of a whole number is accepted and rounded (2.9 `interp_check`).
- **Word checks from 2.9's `convert_arc`,** each refusing the line:
  - a centre word for another plane (K in G17);
  - a missing centre word under G90.1 (under G91.1 it's 0);
  - a G2/G3 with no I/J/K/R, even with no axis words.
- **Fail-closed, and finite.** Every tolerance check asks "is it within?", so a NaN
  refuses the line. Non-finite values (e.g. a G20 overflow of x25.4) are refused, for
  arcs (`SEMANTIC_ARC_NOT_FINITE`) and straight moves (`SEMANTIC_NOT_FINITE`).
- **R0,** or any R below the radius tolerance, is refused. 2.9 takes asin(0/0) and
  moves on a NaN arc; that would break the no-silent-NaN rule.

**The step shape changed** (pre-1.0; see the changeset). An arc step now always has
`centre`, and adds `radius`, `endRadius` and `sweep`. The old `centre: null` and signed
R radius are gone. Consumers get resolved geometry and never redo the maths.

**The tolerance is dialect data** (`InterpreterRules.arcTolerance`), because
controllers differ a lot. LinuxCNC refuses a 0.5 mm mismatch on a 10 mm radius, but
Masso accepted exactly that in the 2026-09-26 machine test. Masso's real limit is
unknown and is on the machine-test backlog. Parcel 2e sets it.

**Decision: the path model** (`path/`). The plan's typed arrays turned out to be a
derived view, not a replacement for steps.

- **Why steps stay.** The budget problem was a fast-path bug (the G letter was missing),
  not per-step allocation. With it fixed, parse + interpret of aztec takes about 0.8 s
  locally, and the CI ratio is about 0.65× against the 1.45× limit.
- **`tessellate(steps, { chordTolerance })`** gives the whole path as ONE polyline:
  - Float64 x/y/z per vertex, plus each vertex's step index and kind (rapid, feed or
    arc), ready for a GPU buffer.
  - It's continuous by construction, because a line that can't run doesn't move the
    tool.
  - Chords stay within the tolerance of the true arc (default 1 µm, as upstream),
    including helices and spirals.
  - **Budgets, counted before anything is allocated** (corrected in review: one legal
    line, `G2 I-5 P126000`, allocated 574 MB):
    - `maxChordsPerArc` (100,000) coarsens any single arc over it;
    - `maxVertices` (2,000,000, about 58 MB) coarsens all arcs together to fit;
    - only a program with more MOVES than the budget is truncated.
    - The result reports `coarsened` and `truncated`.
  - **The chord count uses 4 asin(√(tol / 2r)).** It stays accurate at huge radii, where
    the earlier 2 acos(1 − tol/r) rounded to zero, the count became infinite, and
    everything after the arc was dropped.
  - Arrays are sized in one counting pass, then filled. That's 11 ms on aztec (226k
    vertices).
- **`pathBounds(steps)`** gives the exact box for all moves, and separately for feed
  moves and for rapids.
  - It comes from the geometry, not the chords: each arc's end points, plus the first
    and last point where it faces each cardinal direction. Only those two matter,
    because the radius changes evenly.
  - For a spiral the true extreme is a hair off the cardinal angle; the error is under
    1 µm at any tolerance a controller accepts.
  - Also 11 ms on aztec.
- **Positions are machine coordinates.** Showing work coordinates (subtracting each
  step's `offset`) is the viewer's call, in Phase 3.

**Evidence:**

- **Property tests:** every chord of random arcs is within tolerance, across all planes,
  both directions, 1–3 turns, helices, and tolerances of 1 µm to 0.1 mm. The exact box
  contains the tessellation and is within the tolerance of its box.
- **Mutation checks:** halving the chord count, or dropping the relative mismatch test,
  turns a test red.
- **Parity:** the exact bounding box matches upstream's recorded box on all four upstream
  files, to the golden's 4 decimal places. Upstream was right there, so we agree.

---

## ADR-0023: Dialect profiles, and what the Masso G3 profile is made of

**Status:** Accepted, 2026-09-26. Parcel 2e-1; 2e-2 completes the Masso profile.

**Decision.** A `Dialect` gathers everything that differs between controllers:
expression rules plus `InterpreterRules`. You pass `interpret(program, { dialect })`,
and `rules` / `interpreterRules` still override its parts.

- **Three profiles:**
  - `MASSO_G3`: v5.13, Woodpatch's router, the primary one.
  - `LINUXCNC`: 2.9, the verified reference.
  - `GENERIC`: LinuxCNC semantics, accepting every code known here. It's for a program
    whose controller is unknown.
- **The default stays LinuxCNC,** so the core's behaviour doesn't depend on which
  machine Woodpatch owns. Apps choose Masso explicitly.

**New `InterpreterRules`** (each is data, and each has a source):

| Rule           | LinuxCNC 2.9            | Masso G3 v5.13                                                       | Evidence                   |
| -------------- | ----------------------- | -------------------------------------------------------------------- | -------------------------- |
| `codes`        | its own list            | the docs' supported G/M lists; G10/G28/G30 held for 2e-2             | docs; T8                   |
| `parameters`   | yes                     | **no**: `#`, `[ ]` and functions make the line not run               | T10–T14                    |
| `blockDelete`  | the switch decides      | **ignored**: a `/` line runs                                         | T7                         |
| `messages`     | `(MSG, …)` comments     | **`MSG` lines** (MSG, MSG_S, MSG_W, MSG_SW)                          | docs                       |
| `missingFeed`  | error                   | **runs at the machine's rate**; feed `{ mode: 'unspecified' }`       | T1                         |
| `afterG80`     | axis words are an error | **G0**                                                               | docs; T9                   |
| `cycleSwitch`  | allowed                 | **warning**: the docs require G80 first; the consequence is untested | docs                       |
| `arcTolerance` | 0.028 mm, and relative  | **up to 0.5 mm**                                                     | T17; the limit is untested |

These come from parcels 2c-2 and 2c-3 (ADR-0020, ADR-0021):

| Rule          | LinuxCNC 2.9 | Masso G3 v5.13          |
| ------------- | ------------ | ----------------------- |
| `dwellUnits`  | seconds      | **milliseconds**        |
| `cycleRepeat` | L            | **K**, same place       |
| `g73Retract`  | 0.254 mm     | **1 mm**                |
| `subprograms` | O-words      | **M98 files**, 5 levels |

**Why a code outside the list refuses the whole line.** Masso's docs say "the entire
line is ignored", and T8 showed it: `G64 G0 X20` didn't move. That matters for CAM
posts written for other controllers. `G0 G43 Z15 H1` doesn't move on a Masso, and the
Masso profile shows exactly that. A preview that quietly ran the Z move would be wrong
in the dangerous direction.

**MSG lines are syntax, not G-code.** `MSG text` is recognised by the tokenizer at the
start of a line, or after its N word, for every dialect. Read as words, it would be
letter soup: `M`, `S`, `G` and the text as garbage. The Masso profile turns it into a
`message` step. Other profiles warn that it's Masso syntax. LinuxCNC's own
`(MSG, text)` comments become `message` steps too.

**The evidence is replayed as a test.** The machine-test program is stored byte for
byte in `fixtures/machine/`. Under `MASSO_G3`, every stop from T1 to T17 lands where the
DRO read on the machine, to within 0.01 mm (the DRO steps in about 0.005 mm). T18
retracts to R and ends at the initial Z. Mutating the G80 rule or the `/` rule turns
the replay red.

**Held for 2e-2,** because Masso's meanings differ from LinuxCNC's:

- G10 L2.1 and L20: on Masso, L20 sets the extended offsets G54.1 P1–P100.
- G28: machine home, Z first, via an intermediate point in work coordinates.
- G30: the parking table, Z first.
- G54.1 itself, M6.1, and M66 waits.
- The M6 ordering warnings: T before M6, and M5 before M6.
- The spindle-speed advice (operator, 2026-09-26).
- A warning band for the arc limit that's not yet measured.

Until then those codes are reported as not interpreted yet, and the line doesn't run:
a stated gap rather than a guess.

---

## ADR-0024: The Masso profile's positions, waits and advice

**Status:** Accepted, 2026-09-26. Parcel 2e-2 completes the Masso profile (ADR-0023).

**Decision.** Five more `InterpreterRules`, each set for Masso from its docs (v5.13),
and one tolerance option.

| Rule                  | LinuxCNC 2.9                                | Masso G3 v5.13                                                                                       |
| --------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `g10`                 | L2 sets; L20 = current position reads value | L2 sets; **L2.1 = active offset + value**; **L20/L20.1 = the same for G54.1 P1–P100**                |
| `homing`              | G28/G30 to #5161/#5181, all axes together   | **G28 to machine home, G30 to the parking position; Z first, then the rest**                         |
| `m66`                 | machine I/O, ignored                        | **a `wait` step**: P input, Q timeout (ms), S = lines skipped if met                                 |
| `toolChangeChecks`    | off                                         | **warn** if T follows M06 on the line, or the spindle is running at M06                              |
| `spindleSettleAdvice` | off                                         | **info**: a speed change while running, then a feed move with no dwell between                       |
| `arcTolerance.beyond` | `error`                                     | **`warn`**: from the tested 0.5 mm up to 100× it (50 mm), drawn with a warning; beyond that, refused |

**G54.1 P1–P100** (Masso's extended offsets, modal group 12) are coordinate systems
101–200, stored with the others. `ModalState.coordinateSystem` reports them that way.

**Machine positions are the caller's data.** `InterpretOptions.machine.home` and
`.park` hold machine coordinates.

- **Home defaults to the machine origin.** This router's home is all zeros (its setup
  screen, 2026-09-26).
- **An unknown parking position** is reported, and the G30 move isn't drawn. Guessing a
  position would draw a path the machine won't take. These values belong to the Phase 5
  machine profile, which will pass them in.

**G28 with axis words.** It rapids to the named point first: work coordinates under
G90, incremental under G91 (the docs' `G91 G28 Z8`). Then only the named axes go home,
Z first. Moves that don't change anything aren't drawn.

**M66's S is not a spindle speed on Masso.** It's the number of lines to skip. The
preview draws those lines, as if the input condition wasn't met, and warns.

**Two readings of ambiguous docs** are on the machine-test backlog:

- G10 L2.1 reads as "active offset + value".
- The G28 intermediate move is one combined rapid.

---

## ADR-0025: The parity ledger, and Phase 2's acceptance evidence

**Status:** Accepted, 2026-09-26. Parcel 2f.

**Decision.** `tools/parity.mjs` compares the core's path with upstream's on every
fixture, line by line. Every difference must be explained by a rule in
`tools/data/parity-ledger.json`, which names the upstream defect (ANALYSIS R/N) or the
decision behind it. CI runs `--check`, which fails in three cases:

- a difference no rule explains;
- a rule that no longer explains anything;
- `docs/PARITY.md` (generated) out of date.

**How it compares:**

- **Upstream's full path is regenerated** with the golden harness, not read from the
  golden. Large goldens store only a sample. Each regeneration is checked against the
  golden's SHA-256, so the comparison covers all 307,313 upstream segments.
- **The core** runs the LinuxCNC 2.9 dialect.
- **Per line,** each move is compared on:
  - its kind (rapid, feed or arc);
  - its end point, to 0.1 µm;
  - its feed, including the feed mode;
  - for arcs, the centre and the signed sweep, to 1 µrad.
- **Each difference is tagged** from what the two sides said on that line:
  `upstream-threw`, `zero-length`, `core:<diagnostic codes>`, `upstream-error` or
  `other`.
- **Rules match on a file glob and a tag.** They're tried in order, and the first match
  wins.

**Result:**

- **97 of 307,388 lines with motion differ, and all 97 are explained.**
- **The four upstream sample programs** differ ONLY where upstream dropped a
  zero-length move (R9): 59 lines across 307k.
- **Every other difference is in a fixture written to show a defect** (R1–R9, N3, N4,
  N6, N10, N12), and it's exactly the defect that fixture was written for.
- **Every arc upstream drew correctly matches in centre and direction,** as well as end
  point. That includes aztec's 235 arcs.
- **Mutation check:** reversing the core's arc direction leaves 249 differences
  unexplained, and the check fails.

**One deviation from the ANALYSIS fix table (R9: "keep every move; flag degenerate
ones").** Moves are kept, but a zero-length move is not flagged. A move to where the
tool already is, such as `G0 X0 Y0` at the start, is routine in CAM output: 54 of them
in one sample file. A diagnostic on each would bury real ones. The estimator gives
them no length.

**Phase 2 acceptance (plan §5), with the evidence for each:**

| Criterion                                                                          | Evidence                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every §2.2 defect covered by failing-then-passing tests                            | R1–R9: upstream's behaviour is pinned in `tools/legacy-findings.test.cjs` and the goldens; the core's is in its tests; this ledger ties each to the line where it shows. R10–R14 are the estimator (Phase 5), display (Phase 3), tests and stack. |
| `parse(write(parse(x))) == parse(x)` on the whole corpus                           | `syntax/program.test.ts`, on every fixture plus a fast-check property                                                                                                                                                                             |
| aztec parses in ≤ 2 s in Node                                                      | Parse + interpret takes about 0.8 s locally (target 2 s). CI enforces it as a ratio, ≤ 1.2× upstream's parse (ADR-0014).                                                                                                                          |
| 100% of the Masso reference's codes implemented or reported, none silently ignored | A test runs every code in the Masso profile's list: none is refused as unknown, and each code not yet modelled (G68/G69, G38.x, G32, G96/G97, G200) says so                                                                                       |

---

## ADR-0026: The 3D viewer: framework-free, worker-backed, three.js as a peer

**Status:** Accepted, 2026-09-26. Parcel 3a.

**Decision.** `@woodpatch/gcode-viewer` draws a program in 3D with three.js, as a
framework-free class. Svelte wrapping comes later (3e).

- **three.js is a peer dependency** (`>=0.186.0 <0.187.0`). The host provides it, and
  the build keeps every dependency and peer EXTERNAL, so a page never ships two copies
  (plan §4.1). `scripts/build-package.mjs` now takes `woodpatch.entries` and externalises
  `dependencies` and `peerDependencies`.
- **Version and cooldown:** 0.186.0 was chosen under the 7-day release cooldown
  (0.186.1 was a day old). three.js makes breaking changes between 0.x minors, so the peer
  range is a single minor, widened as each new one is tested.
- **The pipeline is one function, `loadProgram(text, { dialect })`:** parse → interpret →
  tessellate → bounds. It returns only typed arrays and cloneable data. Each vertex is
  tied to its source line; vertices from a subprogram FILE get line 0, since they belong
  to another file's lines.
- **Worker:** `@woodpatch/gcode-viewer/worker` runs `loadProgram` and transfers the arrays
  back, without copying. `ProgramLoader` allows one load at a time. A newer load, an
  abort, or the **time budget** (`timeoutMs`, default 30 s, 0 = off) TERMINATES the busy
  worker. That's the only way to stop a parse mid-way (plan §4.8, "time budget with
  cancellation").
  - Each load owns its abort listener and timer. They're removed when it settles, and
    they only cancel their own load. _Corrected in review (toolkit #20): the listener
    outlived its load, cancelling a newer one and piling up on a shared signal._
  - `/worker` is declared in `sideEffects`, so a bundler can't drop a bare
    `import '…/worker'`.
- **Real line widths:** `LineSegments2` and `LineMaterial` in screen pixels. That fixes R12,
  where upstream's `linewidth: 1.5` was ignored and everything drew at 1 px.
- **Precision:** positions go to the GPU as Float32 RELATIVE TO THE PATH'S CENTRE. Every
  path includes the move from home, so a 4 m bed resolves about 0.12 µm, well below what
  can be seen. A test holds every vertex within 0.25 µm.
- **Upstream's colour language is kept, and is configurable (`palette`):** white cuts,
  red rapids, a yellow highlight, an orange grid.
- **Grid and view:** the grid sits on the machine's Z0 plane, sized in 1/2/5 × 10ⁿ mm
  cells. Z is up; the views are iso, top, front and right, fitted to the path.
- **Line ↔ path:** `buildLineIndex` maps each line to its RUNS of segments (a subroutine
  called twice owns two runs) and each segment back to its line. `highlightLine(n)` draws
  them on top. A click that isn't a drag picks the nearest segment within `pickRadius` px
  and reports its line.
- **Rendering on demand:** a frame is drawn after a change, not on a loop, so an idle
  view uses no GPU.
- **Lifecycle:** `dispose()` also calls `forceContextLoss()`, because browsers cap live
  WebGL contexts at about 16, and it frees the grid's material. Calls after dispose are
  ignored, and a cancelled gesture clears the pick state.
- **Implausible coordinates:** a path spanning more than 100 m gets a
  `VIEW_SPAN_IMPLAUSIBLE` warning. Scene coordinates are clamped to ±1e9 mm, so values
  finite in Float64 but beyond Float32 never reach the GPU as Infinity.
- **Diagnostics quote G-code:** the README tells hosts to render them as text, never
  HTML.

**The operator's Phase 3 decisions, as they apply here:**

- WebGL2 only; WebGPU is deferred.
- The 60 fps target is measured on a real machine. CI gates proxies instead.
- The first proxies, on aztec (226k vertices):
  - GPU buffers: about 12 ms;
  - the line index: about 44 ms;
  - one draw call for the whole path (plus the highlight and the grid).
- Loading takes about 1.2 s, in the worker.

**Testing.** The pure parts run in Node:

- `loadProgram`: all five reference files, dialects, diagnostics;
- the geometry: centring, colours, Float32 precision;
- the line index: repeated runs;
- the worker protocol;
- `ProgramLoader`: a superseding load terminates the worker; stale replies, aborts, and a
  worker failure then recovery.

The WebGL class itself is exercised in a real browser by the playground's Playwright
tests (parcels 3c and 3f), on the CI runner's preinstalled Chrome.

---

## ADR-0027: The editor: CodeMirror 6, highlighted by the core's own tokenizer

**Status:** Accepted, 2026-09-26. Parcel 3b.

**Decision.** `@woodpatch/gcode-editor` is a set of CodeMirror 6 extensions (`gcode()`),
not a finished editor. The host brings CodeMirror (a peer dependency) and its own
setup (keys, history, search).

- **Highlighting uses the core's `tokenizeLine`,** not a separate grammar, so the editor
  colours exactly what the interpreter reads. A word's colour says its role: motion (G),
  machine (M), positions, arc centres, feed/speed, tool, line numbers, parameters.
  Comments recede, and expressions are underlined as computed. O-words, assignments,
  Masso `MSG` lines, `/`, `%` and checksums each have their own style.
- **Only the visible lines are decorated** (a view plugin over `visibleRanges`), so a
  224k-line file costs what the screen shows.
  - Each line is styled ONCE, even when CodeMirror splits a long line into several
    visible ranges. Styling it twice added ranges out of order, `RangeSetBuilder`
    threw, and CodeMirror disabled the plugin for the session. _Corrected in review,
    toolkit #21._
  - Only the first 2,000 characters of a line are styled (`MAX_STYLED_CHARS`), and a
    tokenizer failure styles nothing rather than throwing. A pathological line can't
    stall typing, or take out highlighting and folding. The core's own recursion and
    super-linear rescans on such lines are a tracked follow-up (tokenizer hardening).
  - Line 1's byte-order mark is skipped, as the core skips it.
- **Diagnostics:** `showDiagnostics(view, diagnostics)` maps the core's line and span to
  document offsets for the lint gutter:
  - the span when there is one, the whole line otherwise;
  - line 0 (whole-program notes) goes on line 1;
  - offsets are shifted past a byte-order mark on line 1, which the core's line text
    doesn't include;
  - spans are clamped to the line, and a reversed span or a non-finite line is tolerated,
    not thrown on (it's a public function).
    Diagnostics from a subprogram FILE belong to another file's lines. They're counted
    (returned), not shown.
- **Folding:** O-word blocks (`sub`, `if`, `while`, `do` → `while`, `repeat`) fold to the
  line before their closer, so the closer stays visible.
  - Blocks are paired from a ONE-PASS index of the document, cached per document version
    (a `WeakMap` on the immutable `Text`).
  - Pairing uses a stack per label: a `while` closes an open `do` with its label, and
    otherwise opens a while loop. Same-label blocks nest.
  - Labels are normalised by the core's own `normaliseLabel`, now exported, so the two
    can't drift.
  - Only lines that could hold an O-word are tokenized, and only their first 1,000
    characters.
  - _Corrected in review (toolkit #21):_ the first cut scanned up to 20k lines ahead per
    visible line and per update, about 2.8 s with 150 unclosed openers on screen. The
    index answers each line from a map.
- **Line ↔ path** (upstream's UX, kept per plan §2.3):
  - `onCursorLine` reports the cursor's line when it changes.
  - `showPathLine(view, n)` marks the viewer's picked line and scrolls to it WITHOUT
    moving the cursor, so a viewer click can't bounce back as a cursor move. Only whole
    line numbers are marked.
  - The mark follows its line through edits above it.
- **Build:** the same externalising build as the viewer (ADR-0026), so the bundle is
  9.8 KB and imports CodeMirror and the core. The peers were chosen under the 7-day
  cooldown: state 6.7.5, view 6.43.12, language 6.12.4, lint 6.9.7.

**Testing.** 12 tests run on CodeMirror's `EditorState` in Node:

- span classes and never throwing;
- diagnostic offsets (BOM, clamping, line 0, subprogram files), checked against a real
  program;
- folds (every block kind, labels, nesting, no closer, empty body);
- the path-line field (set, move, clear, following edits);
- the cursor line.

Mutation-checked on the BOM shift and the do→while pairing. View-level behaviour
(scrolling, the gutter, hover) gets real-browser tests with the playground (3c/3f).

---

## ADR-0028: The playground: a static site of the viewer and editor, published from `site`

**Status:** Accepted, 2026-09-27. Parcel 3c.

**Decision.** `apps/playground` is the public demo that replaces upstream's simulator
page. It's a private Vite app in plain TypeScript, with no framework.

- **Layout:** the editor and the 3D view side by side, with diagnostics and stats below.
- **Opening programs:** drop a file anywhere, open one, paste or type, or pick one of
  the five reference programs.
- **Re-reading:** edits are re-read 400 ms after typing stops, in the worker. A newer
  read cancels the old one.
- **Controller:** GENERIC by default, with Masso and LinuxCNC one click away
  (operator, Phase 3).
- **Line ↔ path both ways:** the cursor highlights its path; clicking the path marks its
  line; clicking a diagnostic moves the editor to its line.
- **Nothing is uploaded.** Public input is capped at 20 MB (plan §4.8) on every path in:
  opened and dropped files by size, before they're read, and paste, text drops and
  typing by the document's length (an edit that would pass it is refused). A file dropped
  on the editor is caught before CodeMirror's own drop handler, which would read it
  uncapped. Diagnostics and file names reach the page only through `textContent`, never
  as HTML.
- **CSP:** `default-src 'self'`, no inline script and no `eval`. The worker is a
  same-origin file (`worker-src 'self'`, no `blob:`). `style-src` allows inline styles,
  which CodeMirror's style injection needs.
- **The MIT notice in the built site** (ADR-0009):
  - Vite 8 (rolldown) drops legal comments by default. The config keeps them
    (`output.comments.legal`, for the page and the worker).
  - `scripts/check-notice.mjs` fails the build unless EVERY chunk containing toolkit code
    carries the notice in a `/*!` comment. A string that merely mentions the author
    doesn't count.
  - Mutation-checked: turning legal comments off fails the build and names both chunks.
  - The footer credits webgcode and links the licences. The samples ship with a NOTICE
    for upstream's four programs, which are MIT OR AGPL.
- **Worker:** the app's `src/worker.ts` is a bare `import '@woodpatch/gcode-viewer/worker'`.
  That exercises the viewer's `sideEffects` declaration for real.

**Publishing** (operator, Phase 3):

- CI's `deploy-playground` job runs only on pushes to `main`, after `checks`, `reuse` and
  `provenance` pass. It's the only job with `contents: write`.
- It rebuilds and runs `.github/ci/deploy-site.sh`, which commits the built site on top
  of the `site` branch with plain git: never a force-push, and no third-party actions.
  Only visible files are published (no dotfiles, no source maps at any depth; the maps
  are built `hidden`, so no bundle points at one), and `.nojekyll` is added. A failure
  to read `site` from the remote fails the deploy; only a branch that doesn't exist yet
  starts a new one.
- `gh-pages` stays untouched as upstream's fork reference.
- Pages serving `site` is enabled in repository settings, and `site` has a ruleset
  blocking force-pushes and deletion, set up before the first deploy.
- **Accepted risk: the deploy token shares a job with the build.** Install and Build run
  the locked dependencies in the same job as the push, so a compromised dependency
  could reach the token (through the job's environment files, `PATH`, or the workspace
  copy of the script) and publish script on the site's origin. A separate build job
  would need to pass the build as an artifact, which the no-`uses:` policy rules out
  (ADR-0006). The frozen lockfile, blocked install scripts and the 7-day release age make
  it unlikely, and the `site` ruleset limits it to adding commits.
- The script was tested against a
  local bare repository: the first deploy creates the branch, an unchanged build is
  skipped, a change adds a commit, and a missing build fails clearly.

**Testing:** Playwright drives the CI runner's preinstalled Chrome (`channel: 'chrome'`),
with no browser download (operator, Phase 3). There's no Chrome on the development box,
so these run in CI only. The smoke tests cover:

- the default sample loads, the stats appear, and the 3D view draws (its screenshot
  differs clearly from the empty view's);
- the Masso sample's diagnostics appear, and clicking one moves the editor's active line;
- typing a program re-reads it, with the extent checked, arc top included;
- no page errors or console errors (so no CSP violations) in any test.

Visual-regression screenshots, Lighthouse, the size budget and the 60 fps proxy come
with 3f.

**Size:** the page is about 258 KB gzipped (three.js, CodeMirror and the toolkit) and the
worker about 71 KB, inside the plan's 600 KB island budget.

---

## Pending decisions

Each proceeds on its default and is listed in every PR that touches it.

| Decision                                          | Default until decided                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Stack (ADR-0003)                                  | As ADR-0003                                                                   |
| Where the estimate service runs                   | A private container beside the consuming backend; never public                |
| Source of truth for machine/tool/material records | Held by the consuming systems; the toolkit depends only on the schema         |
| Machine parameter values                          | Placeholders flagged `TODO(calibrate)`; uncalibrated is a representable state |
| Time-estimate accuracy target                     | ±5% after calibration                                                         |

## ADR-0029: The 2D plan view: Canvas 2D, in the viewer package

**Status:** Accepted, 2026-09-27. Parcel 3d.

**Decision.** `GcodeView2D`, in `@woodpatch/gcode-viewer`, draws a program from above
(machine X/Y) on a Canvas 2D. It takes the same `LoadedProgram` as the 3D view, with
the same palette, highlight and pick, so a host can offer both.

- **Canvas 2D, not an orthographic three.js camera.** A plan is 2D: Canvas 2D needs no
  WebGL context (browsers cap them, and some machines lack them), and it has crisp
  lines at any width and text for grid labels. It doesn't import three.js, so a bundler
  drops the 3D view from an app that only uses the plan.
- **In the viewer package, not a new one.** It shares the loaded program, the palette,
  the line index and the pick event. A separate package would duplicate them or depend
  on this one anyway.
- **The maths is pure and tested apart from the canvas** (`plane.ts`): the transform,
  fit, zoom about the pointer, pan, the grid spacing and nearest-segment picking.
  Property tests check that zoom keeps the point under the pointer fixed, and that the
  grid is always 1, 2 or 5 × 10ⁿ mm and at least 40 px apart.
- **Drawing:** one path per colour (rapid, arc, feed), so the whole program is three
  strokes. Rendering happens on demand, after a change. The canvas is sized for the
  device pixel ratio and follows the container with a `ResizeObserver`.
- **Picking** is a linear scan for the nearest segment in plan, only on a click. It
  takes a few milliseconds on the largest fixture. Where segments overlap in plan (a
  pocket's depth passes), the later one wins.
- **Hidden and shown:** a host may keep the view hidden (the playground puts it over the
  3D view and toggles it). A program set while it's hidden is fitted when it first gets
  a size; after that, hiding and showing keeps the user's pan and zoom. In the
  playground, the "2D" button shows it, and a second click re-frames the path.
- **Not yet:** other planes (XZ, YZ), and a Z colour ramp for depth. Both are small
  additions to `plane.ts` if the playground or the apps want them.
- **Browser tests** (the playground's Playwright suite): the plan draws, a click picks a
  line that the editor then marks, the zoom survives a switch to 3D and back, and a
  second "2D" click re-frames.

## ADR-0030: The Svelte components: source, lazy, floor-tested

**Status:** Accepted, 2026-09-27. Parcel 3e.

**Decision.** `@woodpatch/gcode-svelte` ships three Svelte 5 components as PLAIN SOURCE:
`GcodeWorkbench` (the editor and viewer in sync, reading in a worker), `GcodeViewer` (3D
or 2D plan) and `GcodeEditor`. Svelte is a peer dependency (operator, 2026-09-24). The
consuming applications build with different Vite majors, and a pre-built bundle would
tie them to one toolchain. The review's three conditions are enforced mechanically:

- **The peer floor is what's tested.** The peer range is `^5.56.4`, the lowest Svelte
  any consuming application resolves today (all are on 5.56.x). The package's dev dependency is pinned
  to exactly that version, so svelte-check and every test run on the floor. A test
  fails if the pin and the floor ever disagree, or if the installed Svelte isn't the
  floor. Newer 5.x minors are exercised by the apps themselves, which pin exact versions.
- **No built output, by construction.** No `build`, `prepare` or `prepack` script, no
  `dist`, and every `exports`/`svelte`/`sideEffects` path points into `src`, which may
  hold only `.svelte`, `.js` and hand-written `.d.ts` files. Each is a test. The root
  build skips the package (`--if-present`).
- **The MIT notice in each file.** A source package has no build to prepend the banner,
  so every source file (`.svelte` and `.js`) carries it, generated from LICENSE (`scripts/licence-banner.mjs`,
  now shared with the build; `scripts/stamp-source-banners.mjs` writes it).
  - **Where it sits in a `.svelte` file was found by testing, not assumed.**
    - Svelte 5.56 drops comments in `<script module>`.
    - A bundler keeps a comment only with the statement that follows it. At the top of
      the instance script, the banner came before a declaration that Vite 6's Rollup
      tree-shook, and the notice went with it.
    - So the banner sits directly on each component's `onMount(…)` call, which no
      bundler removes. A test checks that placement in the compiled output.
  - The package's tests compile every component for both client and server; the CI
    licence check compiles for the client (what browsers get). Both then minify it
    (esbuild `inline` and `eof`) and require the notice to survive.
  - **Checked by hand on the real components:**
    - A Vite 6.4.3 build with its default settings keeps all three banners.
    - Vite 8.3.0 keeps them with `output.comments.legal` and drops them without. That's
      the same rule as the other packages, so a consuming application on Vite 8 must
      set it.
    - Consuming applications should grep their chunks in CI (README).
  - `worker.js` carries the banner too, but a bundler may drop it: the file is a bare
    import with no statement of its own to keep the comment. No notice is lost. The
    worker it imports is the viewer package's built entry, whose own banner survives
    (the viewer's licence check).
  - The package's LICENSE and NOTICE copies are committed, since there's no build to copy
    them. The licence check fails if they differ from the root's.

**Loading.** three.js, CodeMirror and the toolkit's packages are imported DYNAMICALLY,
on mount (plan §4.9). Importing the package loads none of them, server rendering never
runs them, and a prerendered page pays for the island only when it hydrates. A test
compiles each component and fails on any static import other than `svelte` and sibling
components, and another counts the viewer package's imports around a mount.

**The worker is the host's.** A package can't make its bundler build a worker, so
`GcodeWorkbench` takes `createWorker`, and the package exports a `./worker` entry. The
host's worker file is `import '@woodpatch/gcode-svelte/worker'` (declared in
`sideEffects`, so bundlers keep it).

**Behaviour**, each tested in jsdom (fakes stand in for WebGL and Canvas 2D; CodeMirror
is real):

- Each view is created the first time its mode is shown. Each gets the program
  separately, so showing the 2D plan doesn't reset the 3D camera. Both get highlights.
- The editor's `value` is bindable. Outside changes replace the document.
- **The size cap** (`maxLength`, 20 Mi characters: UTF-16 code units, not bytes) holds on
  every path:
  - an edit past it (paste, drop, typing) is refused;
  - a longer `value` from the host is refused too, and `value` is set back to what the
    editor shows, so the two never disagree (and a host parsing `value` never parses
    text nobody can see);
  - an over-long first value starts the editor empty;
  - each refusal calls `ontoolarge`.
    The host's own replacements bypass the edit filter (`filter: false`) and are checked
    explicitly. Before review, the filter silently ate an oversized host value while
    `value` moved on.
- `readonly` and `dark` follow their props after mount (CodeMirror compartments).
  `extensions` and the view options are read once, as documented.
- **Load failures:** a lazy import that fails (a chunk error, a CSP block) goes to
  `onerror` on each component, and the workbench forwards its children's. No unhandled
  rejection, and no silently blank box.
- **Unmounting before the imports settle** creates nothing. Tests unmount while each
  component's import is in flight: no editor (counted by a plugin, since a late one
  would leave no trace in the DOM yet never be destroyed), no loader, no views.
- The workbench re-reads `delay` ms after the last edit or dialect change. A superseded
  read is quiet; a real failure goes to `onerror`. It disposes its worker on unmount. It
  passes `readonly`, `dark`, `maxLength` and `ontoolarge` through to its editor.
- A loaded program is large (typed arrays): hosts should bind it to `$state.raw`, not
  `$state`, which would deep-proxy it (README).

**Not yet.** Prettier doesn't check `.svelte` files (that needs `prettier-plugin-svelte`,
one more dependency). Browser tests of the components come with their first real host
app, not a fixture app here.

## ADR-0031: Phase 3 acceptance gates

**Status:** Accepted, 2026-09-27. Parcel 3f. Operator decisions of 2026-09-27.

Phase 3's acceptance: the playground renders all five reference files with editor sync,
the 224k-line file orbits at 60 fps, Lighthouse performance is at least 90, and the
bundle budget is met. Each is now a gate or a recorded measurement:

- **Bundle budget, in the playground build:** page at most 300 kB and worker at most
  40 kB, gzipped (`scripts/check-budget.mjs`; 257.8 + 24.0 kB at the time). Real growth
  has to be a deliberate budget change in the same PR.
- **Visual checks are structural, not pixel baselines.** A pixel baseline breaks when
  the runner's GPU, driver or browser changes, with nothing wrong. So for each of the
  five samples, in 3D and in the 2D plan, the test decodes a screenshot in the page and
  checks:
  - the path is framed: its pixels' box is centred (within 20%) and fills enough of the
    view (at least 0.3 in 3D, 0.6 in 2D; measured 0.36 to 0.68 and 0.89 to 0.90);
  - feed (white) and rapid (red) colours are present. A plan shows no red for Tux, whose
    only rapids are vertical;
  - editor and path are in sync. Moving the cursor to an early X/Y cut highlights it
    (yellow) in both views. For the largest file, a click on a drawn cut marks its line
    in the editor instead: 149 cursor moves, each re-rendering 226k segments in the
    runner's software GL, took minutes.
- **The checks found a real bug on their first run.** The 2D plan drew rapids first and
  feeds over them, so every traverse across the cut area vanished: test_pycam's
  8,430 mm of rapids showed no red at all. From above, rapids (at a safe height) are on
  top, so the plan now draws them last.
- **Performance proxies, on `aztec_calendar.ngc`** (223,857 lines, 226,632 vertices).
  The runner's figures on 2026-09-27: worker read 474 to 551 ms, 3D geometry build 61
  to 68 ms, 2 draw calls. The gates are about 10x those (read under 5 s, build under
  1 s, at most 4 draw calls), plus "the view draws while orbiting". They catch a
  regression of kind (a quadratic step, a draw call per segment), not noise.
- **60 fps is measured by a person.** The CI runner renders in software, so its frame
  rate says nothing about a real GPU. The playground's `?stats` overlay shows the
  frames drawn in the last second while orbiting, the render call's CPU time, the draw
  calls, and the read and build times. It's built on the viewer's new `onRender` hook.
  The operator orbited the Aztec sample on their own machine: 99 to 109 fps (below).
- **Lighthouse performance of at least 90 (parcel 3f-2).** CI runs the `lighthouse`
  package (13.5.0, exact-pinned; about 105 packages of dev dependencies, none with
  install scripts):
  - against the built playground, served by `vite preview` as it will be deployed;
  - on the runner's preinstalled Chrome;
  - three times, gating the median. One run is noisy.
    Lighthouse's defaults are used (mobile emulation, simulated throttling), which is what
    PageSpeed Insights reports. Accessibility and best practices are printed, not gated.
    The keyless PageSpeed API was ruled out: its shared quota was already exhausted.
  - **First run: 87, three times.** The page shifted as late content arrived
    (cumulative layout shift 0.149): the status, the stats line, the info panel, and
    the controller list (filled by script, so its select grew and re-wrapped the
    header on a phone-width screen). They now have reserved sizes, and the gate prints
    the elements that shifted.
  - **Now: 94, three times** (2026-09-27, layout shift 0.009, total blocking time
    about 300 ms). Accessibility 97, best practices 100.
  - What's left is the blocking time from evaluating the one page bundle at load. If
    the score slips, the lever is loading the 3D viewer (three.js) lazily, after the
    editor.

**60 fps measurement:** the operator measured **99 to 109 fps** orbiting the Aztec sample
(223,857 lines, 226,631 segments) on the deployed playground with `?stats`,
2026-09-27. The target was 60. Met.

## ADR-0032: The program summary

**Status:** Accepted, 2026-09-27. Operator request, taken ahead of Phase 4a.

**Decision.** `summarise(steps)` in the core reports a program at a glance, from the
interpreter's steps:

- min/max per axis, for cutting and rapid moves separately (exact for arcs);
- cutting and plunge feeds, and the distance fed at each feed;
- spindle speeds and directions, and the distance cut at each speed;
- **cutting with the spindle off** (with its first line);
- tools, and the distance cut with each;
- cut, plunge and rapid distances, move counts, the Z levels cut at, dwells, stops and
  coolant.

The viewer computes it in the worker (`LoadedProgram.summary`), and the playground
shows it in a box above the code, always in view (operator request, 2026-09-28; it started
as a tab beside the diagnostics). The box has a fixed height and scrolls inside, so filling it
in after load can't shift the layout.

- **Work coordinates and millimetres, always.** The interpreter keeps machine
  coordinates and the work offset in force (ADR-0019). The summary reports what the
  program says, in the frame each move was commanded in. Feeds are in mm/min,
  whatever units the program uses.
- **Extents separate rapids from cuts honestly** (corrected in review):
  - Z counts only where moves END, plus an arc's extremes. Counting starts made every
    rapid reach the cut depth (a retract starts there) and every cut reach clearance
    (a plunge starts there). That hid exactly the case a summary should show, a rapid
    at depth: Aztec's rapids appeared to reach −12.885 mm, but they never go below
    5.08.
  - Cuts count X/Y over their whole path, so a ramp's start counts. Rapids count end
    points only.
  - The interpreter's assumed start, before the first move, is never counted. The
    program never commanded it, and under a work offset it showed as a phantom point.
- **The spindle:** S0 counts as off. M3 with no S is "on, speed not programmed" (a router
  set by hand), not "never on". Cutting and plunge feeds are tallied separately, so the
  most-used cutting feed is never a plunge feed.
- **A plunge** is a feed move straight down (no X/Y travel). Its feed is reported apart
  from cutting feeds, because it's usually deliberately slower. **A Z level** is the
  height of a level cutting move (horizontal, or an XY-plane arc without a helix). The
  50 highest are listed and the rest counted.
- **Speed.** A summary of the 224k-line sample takes about 50 ms warm (130 ms cold) in
  the worker. That's after caching each total's current entry (the key rarely changes
  between moves) and plain square roots instead of `Math.hypot`, which is several
  times slower in V8. It started at 200 to 330 ms.
- **Not here:** time estimates (Phase 5), and concern checks beyond the spindle-off one
  (plan §4.5).

## ADR-0033: Transforms: translate, rotate, mirror, scale

**Status:** Accepted, 2026-09-28. Parcel 4a. Operator decisions of 2026-09-27.

**Decision.** `transform(program, ops)` in the core applies a recipe of operations, in
order, by editing the program's words in place (`editLine` span edits, ADR-0017):

- `translate {x, y, z}`
- `rotate {degrees, about}`: counter-clockwise, about any point
- `mirror {axis: 'x' | 'y', about}`
- `scale {x, y, z, about}`: y defaults to x; z defaults to 1, so depths are kept

Lengths in ops are millimetres, converted to each line's units. Every line the
transform doesn't change stays byte-for-byte, and so does every part of a changed line
it doesn't touch. A transform that can't be done faithfully is **refused**: the result
is the original program, with an error naming each line that stopped it. It's never an
approximation.

- **Each op is an affine map** of XY (x' = a·x + b·y + tx, y' = c·x + d·y + ty) and Z.
  - Translations, mirrors, scales and rotations by multiples of 90° are **axis-aligned**:
    each output axis takes exactly one input axis, so each word maps to one word with
    no position needed.
  - On a quarter turn, a line with both X and Y keeps each letter where it is and swaps
    the values (`X-8 Y98`, not `Y98 X-8`); a line with one of them renames it.
  - Rotations by multiples of 90° use exact 0/±1 entries. So rotating four times gives
    the file back byte-for-byte, and so does mirroring twice about an axis through the
    origin. Both are tested on every fixture.
- **Other angles** need both X and Y on every line. The transform tracks the commanded
  position and inserts the missing word after its partner. An absent component of an
  incremental move is 0, never the absolute position (corrected in review).
- **Incremental words carry their rounding.** Each is written as the exact transformed
  total so far minus what the earlier incremental words on that output axis have
  already written. 10,000 steps of 0.1 mm rotated 10° end within a micrometre, not 6 mm
  off (review of #33). An absolute word resets the carry. A canned cycle repeated in
  G91 multiplies its step only where the controller does (LinuxCNC L; Masso's K repeats
  in place).
- **Only modelled codes.** An allowlist of G codes whose words the transform
  understands; any other G code refuses the op. Refused as a result: G5.x, G7/8,
  G15/16, G33, G38.x, G43.1, G50/51, G68/69, G76, G87/88. G52 and G92.x refuse as
  offsets. G10 L20 refuses except on Masso, where L20 means something else.
- **Control flow refuses every op:** O-word subs, calls and loops, M98 and M99. A line
  may run many times, out of order, or from another file, so transforming text in order
  is wrong (review of #33). A bare O-number program line is fine.
- **G53, G28 and G30 lines are left as written.** The machine's home can't move, and a
  quarter turn must not rename the axis being homed. Each axis they move becomes
  _untransformed_: a later move while an axis the op changes is still untransformed
  (not yet given again in G90) is refused. A Z-only retract taints only Z, so the usual
  tool-change retract doesn't stop an XY transform. After a Z-only retract, **rapids with no Z word are allowed**: they travel at the
  retract height in both programs, which is what's intended (review of #33; strict
  refusal made Z translation unusable, since every real job retracts for tool changes).
  A feed move, a canned cycle (whose Z is the hole bottom, not a new height) or any Z
  word before Z is given again absolutely is still refused.
  - It's refused where the position is unknown (before the first X/Y, or after a G53 or
    G28 move).
- **Which words are coordinates** follows each line's modal state:
  - X/Y/Z are points under G90 and vectors under G91 (translation doesn't apply to
    vectors). Not on G10, G53, G28 or G30 lines, which are left as written.
  - I/J/K are arc centres only under G2/G3, including a full circle with no axis words.
    They're vectors under G91.1 and points under G90.1. Masso's K is a canned-cycle
    repeat count, so it's left alone.
  - R is the arc radius (scaled with the plane) under G2/G3, and the retract height (a
    Z) in canned cycles. Q is the peck depth.
- **Arcs:**
  - G2/G3 flip wherever the arc's plane is mirrored (XY if the map reverses
    orientation; ZX if X is negated; YZ if Y is).
  - An arc that inherits its G2/G3 from another plane needing different handling is
    refused.
  - XZ/YZ arcs are refused under any rotation but 0° or 180° (a quarter turn would move
    them into another plane).
  - Uneven scaling of an arc's plane is refused: it would make an ellipse.
  - G41 and G42 swap in a mirror image.
- **Also refused:** an expression or parameter in a word the op would change (operator
  decision: rewritten expressions can't be trusted); a line that repeats a coordinate
  word, which the controller rejects anyway; an op with a missing, misspelt or extra
  field (it's never read as zero).
- **Left alone, with a warning:**
  - G53, G10, G28 and G30 lines (machine terms and homes);
  - rotary axes;
  - a program that moves incrementally before any absolute X/Y: that part is placed by
    where the machine starts, so it transforms about that point, and translation can't
    move it.
  - **A mirror always warns** that climb milling becomes conventional and vice versa.
    Reversing contours to keep the cut direction comes later, with §4.4's contour
    detection.
- **Numbers** keep their source decimals when the result is exact at them, and
  otherwise get at least 3 (mm) or 4 (inch). No negative zero. An unchanged word is left
  exactly as written.

**Evidence.**

- A corpus property: for every fixture and eight ops, the transform is either refused
  with the file untouched, or every step of the result lands where the map sends the
  original's (endpoints, arc centres, and arc direction flipped exactly when it should
  be). Axes whose position the program never commanded are excluded, since no transform
  can move them. The large fixtures run in separate test files, in parallel.
- **The operator's four BB variants** (private fixtures) are reproduced **exactly** from
  `bb-horizontal.nc`: geometrically, and byte-for-byte apart from one file's final
  newline. The two "swapped" variants are a quarter turn followed by a mirror, and carry
  the cut-direction warning. The fixtures repo's CI will pin this check once it's merged.
- **The first review found six ways a transform came back ok with a wrong toolpath**
  (the fixes above), by interpreting both programs and comparing positions. Each is now
  a unit test. Accepted fixtures in `packages/core/test/fixtures/transform/` exercise
  them in the corpus property: absolute then incremental with arcs, tool-change
  retracts, and a Masso job with cycles and K repeats. Lines left as written are checked
  against the original's machine positions (the axes they name).
- The corpus found three bugs before the first review:
  - a full-circle arc (`G2 I5`) had its centre left untransformed;
  - an unchanged `Z-0.0000` was rewritten as `Z0.0000`;
  - a repeated word was guessed at instead of refused.

**Performance.** 2.2 s for a quarter turn of the 224k-line sample, mostly re-tokenizing
217k changed lines. It's acceptable in a worker for now; a later parcel can avoid the
re-tokenizing.

**Corrected after review (out-of-range results).** `invalidOp` checked that each
number was finite but not its size. So a scale of 1e308 wrote `X1e+308 YInfinity`,
and a scale of 1e20 wrote 21-digit numbers, both with ok=true. Now:

- any result that is non-finite, or beyond ±1,000,000 (`MAX_WRITTEN`: 1 km in mm, far
  past any machine) is refused as `TRANSFORM_OUT_OF_RANGE`, naming the line;
- the formatter throws rather than write an exponent or "Infinity", as a backstop.

A fast-check property over huge scales, moves and rotation centres checks that every
result either refuses or writes only plain numbers in range.

## ADR-0034: Units conversion, and the units preference

**Status:** Accepted, 2026-09-28. Parcel 4b. Operator decisions of 2026-09-28.

**Decision.** A `units` op in the transform recipe, `{ op: 'units', to, assume }`,
converts a program between millimetres and inches. Nothing moves: interpreting the
result gives the same toolpath.

- **What converts.** Every length the program writes: X/Y/Z, arc centres (I/J/K) and
  radii (R), canned-cycle retract heights and peck depths (R, Q), and G64's
  tolerances. Also feeds in per-minute and per-revolution modes.
  - Offsets (G10, G52, G92), machine positions (G53) and homes (G28/G30) convert too.
    Unlike a geometric transform, which leaves them alone, a unit conversion must
    convert them: the controller reads them in the program's units.
  - Not converted: dwell times (G4 P), turns (G2 P), spindle speeds, tool numbers,
    Masso's canned-cycle repeat count (K), and inverse-time feeds (a rate).
- **Line by line, from its own units.** A program that switches units part way comes
  out in one. Every G20/G21 word is rewritten to the target. F on a line that also
  changes units converts from the units the dialect reads it in.
- **Precision** (operator decision): values are rounded to 5 decimals in inches
  (0.00001 in, about 0.25 µm) or 3 in millimetres, then trailing zeros are dropped.
  25.4 mm is written 1.0 in; 10 mm is 0.3937 in; 254 mm/min is 10 in/min.
  - The source's own decimal places aren't kept (unlike a geometric transform): they
    mean nothing across units.
  - mm → inch → mm lands within 1 µm on every fixture (the plan's acceptance).
    Transforms keep their 4 inch decimals.
- **The units preference** (operator decision). The user sets a units preference,
  default mm, stored persistently: a secure cookie or equivalent in the playground, and per user in a
  consuming application.
  - A program that moves before stating its units is READ in the preference: the
    interpreter takes a `units` option, and warns (SEMANTIC_UNITS_ASSUMED) when it's
    given and relied on.
  - It's CONVERTED from the preference (`assume`): the conversion inserts an explicit
    G20/G21 at the first line of G-code, and warns (TRANSFORM_UNITS_ASSUMED).
  - "Convert units" converts TO the preference, with an info note saying what was
    converted. The UI for both comes in parcel 4e.
- **Refused:**
  - an expression or parameter in a length word;
  - a G code whose words aren't all lengths or aren't modelled (G68's R is an angle);
  - M98 calling another file, which would stay in the old units;
  - O-word subroutines or loops in a program that switches units, since a subroutine
    runs in its caller's units.

  O-word control flow in a single-unit program is fine: each word converts the same
  wherever it runs.

**Corrected in review (toolkit #37). The rule is now: the only safe failure is a
refusal.** The first cut returned wrong G-code as success in several ways. Now:

- **The units go on a line of their own,** before the first line the main program runs
  (outside any O-word subroutine; after %, the program number and leading comments).
  The first line keeps its own units word only if it's a clean statement: a G20/G21,
  no F, and not block-deletable.
  - On the same line, an F was read by at-feed-step controllers in the units BEFORE the
    line, the controller's default, 25.4× off.
  - The old placement also put the units inside a subroutine, onto a block-delete line,
    or ahead of the N-number.
- **Every word must be KNOWN to be a length, a feed or not a length, in its context;
  anything else refuses.**
  - X/Y/Z always.
  - I/J/K only on arc lines. Masso's cycle K is a repeat count.
  - R only as an arc radius or on a line that runs a canned cycle.
  - Q only on a line that runs a cycle, or with G64 (M66's Q is a timeout).
  - P only with G64. F unless inverse time.
  - G10 only as a work offset (L2/L20, and Masso's L2.1/L20.1), and never with R (a
    rotation).
  - Refused: G41.1/G42.1 (D is a diameter), G43.1 and G38.3–5 (not modelled), G96
    (surface speed), and U/V/W/E words.
- **G91 drift.** Each incremental X/Y/Z absorbs the rounding carried along its axis, so
  a long incremental program ends where the exact conversion would, within one rounding
  step. Where an increment would repeat (a loop, a subroutine, a stepping L-repeat),
  a carry can't work, so an inexact increment there refuses.
- **Parameters and expressions refuse anywhere,** loop conditions included: a condition
  like `[#5422 GT -10]` compares a position with a number in the old units.
- **M98/M99 count as control flow,** alongside O-words.
- **The units-assumed warning is exact.** The interpreter records when a G20/G21 first
  RUNS, so a G21 in a subroutine called before the first move counts, and one in a
  skipped branch or on a block-deleted line doesn't. The conversion uses the same rule
  for its own warning.

**Corrected in the second review.** The conversion reads each line's modes (units,
distance mode, feed mode, motion) from the text above it. Two cases ran a line in other
modes, and it came out converted for the wrong ones:

- **A block-deleted line that changes a mode** (`/G20`, `/G93`, `/G91`). On LinuxCNC
  and generic, `/` is a switch, so whether the line runs is the operator's choice. Masso
  runs it, so it's fine there.
- **A subroutine body runs in its CALLER's modes**, not those of the text above it:
  feed mode, distance mode and the modal motion a body line relies on.

The general guard: the interpreter's new `onBlock` hook reports the modal state each
executed block RUNS under. The conversion runs the program with block delete off (every
line runs, so a difference is control flow) and on (a new difference comes from a
skipped `/` line), and refuses any line of this file whose run-time units, distance
mode, feed mode or relied-on motion differ from the text's. The message names the
cause. A sub called in the modes its text says still converts.

**Corrected in the third review.** The run-time guard sees only lines the interpreter
RUNS, and compares only what it models. So:

- **Relied-on motion the text doesn't know counts as different:** none yet, G80, or a
  motion the interpreter doesn't model. A body line `X1 Y1 Q0.2`, read with no motion
  but run under the caller's G83, had its Q (a peck depth) left unconverted.
- **Subprograms the preview doesn't run are refused:** in-file (Fanuc-style) M98/M99 on
  LinuxCNC, and a call to a subroutine not defined in this file, which stays in the old
  units.
- **A run that stops before the end is refused.** The lines after the stop were never
  checked.
- **Only the modes a line reads are compared:**
  - units, for a length or a feed;
  - distance mode, for X/Y/Z/R;
  - feed mode, for F;
  - motion, where the line relies on it.

  A code that takes some of the line's words for itself leaves only those out of the
  motion check: G4 takes P, G64 P and Q, and G10/G28/G30/G52/G92 their axes. So a body of
  `M9` and `G4 P1`, called under G91 or G93, converts. (Round 3 had G4 take the whole
  line, which let `G4 P0.1 X1 Y1 Q0.2` under a caller's G83 through with its peck Q
  unconverted. The fourth review caught it.)

- **Block-deletable incremental lines carry their rounding in a chain of their own.**
  The lines that always run sum exactly whether the `/` lines run or not, and so do the
  `/` lines. With 1,000 of each, the end is within about one output quantum either way (0.25 µm in
  inches; 0.02–0.05 µm measured, depending on the values). One shared chain
  was 0.23 µm off with block delete on. Isolating the `/` lines instead would have been
  94 µm off with it off.
- **One cause names its first 20 lines, then counts the rest.**
- **Not changed:** a file with its subroutines at the top, stating G21 when the
  preference is inch, is still refused. Its body text reads in the preference, but runs
  after the G21. Converting each line under its run-time state would accept it. That's a
  bigger change, which the text-order refusal keeps safe for now.

**Corrected in the fourth review.**

- The G4 regression above.
- **O-words on a controller without them (Masso) are refused.** The controller skips
  those lines and runs a `sub` body in place, before the units line the conversion adds.
- **Subprogram files are refused:**
  - a Masso file with M99, which runs in its caller's units, where an added units line
    would carry back into the caller;
  - a LinuxCNC library (an `o<name> sub` never called in the file), whose body runs in
    other programs' modes.
- **A nonzero F, Q, or G64 P that would round to zero is refused.** Zero means
  something else: no feed, an endless peck, no blending.
- Per-line subroutine refusals are capped like the mode ones (20 named, then counted).

**Evidence.** On every fixture, converting to inches and to mm, with both unit
assumptions, moves nothing: every step lands where it did (within 2 µm) at the same feed
(within 0.01 mm/min), with arc directions unchanged. A fast-check property converts long
random G91 programs without drift, and each of the review's probes is a unit test. mm → inch → mm is
within 1 µm. 39 of the 47 fixtures convert. The rest are refused: for expressions,
for G87/G88, or for an exponent's E word. The run-time mode guard refuses none of them.

## ADR-0035: Whole-job checks

**Status:** Accepted, 2026-09-28. Operator request.

**Decision.** `programChecks(program, result, dialect)` in the core reports what a
controller needs to run a job start to finish, as warnings:

- `PROGRAM_END`: the job doesn't end the way the controller needs.
  - **Masso finishes a job only on M30.** Without it, the job never finishes (the
    operator, on the machine), and M2 is warned about too.
  - LinuxCNC and generic accept M2 or M30.
- `PROGRAM_SPINDLE_ON_AT_END`: the spindle is still on when the job ends. Masso expects
  M5 before M30.
- `PROGRAM_SPINDLE_NO_SPEED`: M3/M4 with no S programmed yet, or at S0. All controllers.
  The message notes that a router whose speed is set by hand will expect this.
- `PROGRAM_CUT_SPINDLE_OFF`: the job cuts (a feed move or arc) with the spindle never
  started, or stopped. All controllers. Rapids don't count. The message allows that an
  air cut or test may intend it.

The checks are **dialect data** (`InterpreterRules.programChecks`: which end code,
whether M5 must come first, whether a tool change stops the spindle, whether to check
speeds and the spindle while cutting). So they vary by controller, and a
custom controller (roadmap) will set them.

- **Separate from `interpret`.** The interpreter reports what each line does; these
  judge a whole job. So the viewer's `loadProgram`, which loads jobs, runs them, and
  the playground shows them with the other diagnostics. A snippet (a test, a transform,
  a parity check) isn't told it lacks an M30.
- **On real jobs:** the operator's BB and MillMage programs (ending `M5`, then `M30`)
  raise nothing. The Masso machine-test air cut and upstream's Tux, neither of which
  starts the spindle, are flagged.
- **Still to confirm on the machine:** what Masso does with M2, and with no end code,
  and whether it stops the spindle itself at M30. Masso's documentation describes M30
  as "end the program and rewind" (with L repeats) and M02 as "program end", and says
  nothing more.

**Corrected in review.** The first version missed the two ways a job actually cuts
with the spindle stopped, and gave a false end warning. Fixed:

- **A tool change stops the spindle.** LinuxCNC's M6: "When the tool change is
  complete: The spindle will be stopped." That's `toolChangeStopsSpindle`: true for
  LinuxCNC, and for Masso too. Masso's docs ask for M5 before M6, and what it does
  without one is unconfirmed, so it's assumed to stop (the safe way round). This is on
  the machine-test list.
- **The checks follow the run into subprogram files.** A Masso M98 is always a file, so
  skipping them skipped Masso's subprograms entirely. A warning raised in a file names
  it.
- **A run cut short skips the end checks.** When the interpreter stopped early (a
  subprogram the host didn't supply, a safety limit), it never reached the end. So
  `InterpretResult.completed` is new, and the end checks run only when it's true. The
  error that stopped the run already says why.
- **The cut warning re-arms** on every M3/M4, M5 and tool change. So a harmless early
  move can't use it up and hide a plunge after the next tool change. The speed warning
  is still once per job.
- **Fewer false alarms.** A feed move that only raises Z isn't a cut, and neither is a
  G53 move in the main program (machine positioning). A file ending at a closing `%` on
  LinuxCNC gets its own message: that ends the run, but doesn't reset the machine. An
  M99 ending gets its own message too. An empty file raises nothing.
- A dialect without `programChecks` (built before it existed) gets LinuxCNC's.
- **Known limit:** a plasma or laser on Masso runs M3 without S. It gets
  `PROGRAM_SPINDLE_NO_SPEED`, and the message says that's expected there. A custom
  controller (roadmap) can turn the check off.

## ADR-0038: The playground's transform panel

**Status:** Accepted, 2026-09-28. Parcel 4e-1.

**Decision.** The playground gets a Transform panel for the 4a operations: move,
rotate, mirror and scale. Each transform applied goes on a history, with undo and redo,
a recipe that can be saved and applied to another file, and the original drawn faintly
behind the result. The units preference, the convert-units action, and the override
and arc-to-line controls follow when their core parcels merge (4e-2).

- **Transforms run in a worker**, so a big file doesn't freeze the page. There's one
  worker script, which answers both the viewer's load requests and transform requests.
  So the core is bundled once, and the budget grows by the transform code only (worker
  26.6 → 31.7 kB, page 259.1 → 262.4 kB gzipped, of 40 and 300). The page runs three
  instances: the loader, the transforms, and the original's loader. A long transform
  never holds up reading the program. It is stopped after two minutes.
- **The history means "these ops, applied to the original, give the text on
  screen".** That's the recipe, and a test checks it against the core. An edit by
  hand therefore starts the history again, with the edited text as the new original:
  a recipe that no longer reproduced the screen would be worse than none. The page
  says so when it happens. Opening a file starts again too.
- **A refused transform changes nothing.** Its reasons are listed with their lines, as
  diagnostics are. A result for text that was typed into while the transform ran is
  discarded, not applied.
- **The panel has its own status line.** Each transform is followed by a re-read,
  which writes the page's status ("Read in … ms"). So an outcome posted there flashed
  past unseen (found by the browser tests).
- **Changing the controller starts the history again**, as an edit by hand does: the
  steps were worked out for the old one, and a recipe saved afterwards would claim the
  new one.
- **Recipes** are a small JSON file (`woodpatch-gcode-recipe`, version 1: the ops and
  the controller they were made for). On the way in, every op is checked as the core
  checks it, so a misspelt field is refused, naming the step, never read as zero. The
  ops are applied one at a time, so each can be undone, stopping at the first refusal.
  A recipe made for another controller applies to the current one, and says so. A recipe has at most 256 steps: each is a transform, a re-read and a copy of the
  text, so a shared file of tens of thousands could hang the tab.
- **The original is drawn faintly, not diffed.** The viewer gained `setGhost` on both
  views: one muted colour under the path, never pickable. Framing takes both in, so a
  move of 100 mm keeps both in view. It can be hidden.
- **Saving** is a download of the editor's text (`name-transformed.ext` when
  transforms are in effect) or of the recipe (`name.recipe.json`). Nothing is uploaded.
- **Layout:** the panel is a closed `<details>` above the code, one line tall, so it
  can't shift the page on load (the Lighthouse gate, ADR-0031). Opened, it scrolls
  within 40% of the height.

**Tests.** Unit tests for the history and recipes (the playground's first; vitest,
`src/` only), viewer tests for the combined framing, and browser tests:

- apply, undo and redo;
- the original drawn and hidden;
- a refusal listed with nothing changed;
- an edit by hand resetting the history;
- the recipe and G-code downloads, and a saved recipe applied to another file;
- a misspelt recipe refused.
