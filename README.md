<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# Woodpatch G-code Toolkit

A G-code parser, visualiser and machining-time estimator for CNC routers, written in
TypeScript. It aims to handle real-world CAM output without silent errors, estimate
cut time from calibrated machine parameters, and edit programs (translate, rotate,
mirror, scale, unit conversion, feed override) while leaving untouched lines
byte-for-byte identical.

> **Status: early development, not yet released.** The core (parser, interpreter,
> diagnostics and transforms), the viewer, the editor mode and the Svelte components
> work, and the playground puts them together. Nothing is published to npm yet, and the
> APIs may still change. The time estimator, the server and the machine database are
> still to come.

## Acknowledgements

This project is a fork of **[webgcode](https://github.com/nraynaud/webgcode) by
Nicolas Raynaud**, and it starts from his work. From webgcode it inherits the
G-code parser and its grbl-derived arc maths, the trapezoidal speed planner behind
the time estimate, and the design of the 2D/3D path viewer with editor-line
highlighting. Those are being **rewritten** here in TypeScript, with a line model,
diagnostics and a modern three.js/CodeMirror stack. The original code is kept
unchanged under [`legacy/`](legacy/), with its full history. See
[`legacy/README.upstream.md`](legacy/README.upstream.md) for the upstream project's
own README.

webgcode is offered by its author under a choice of MIT **or** AGPL-3.0. This
toolkit is distributed under the **MIT** option. Upstream's own licence file is
preserved unmodified as [`LICENSE.txt`](LICENSE.txt), this project's licence is in
[`LICENSE`](LICENSE), and [`NOTICE`](NOTICE) has the full attribution.

**Fork point:** upstream `gh-pages` at `d315a359` ("add visucam link", 2025-09-18),
tagged here as `upstream-2025-09-18`. Upstream's `gh-pages` and `master` branches
are kept exactly as upstream left them.

## Layout

| Path                 | What                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`      | `@woodpatch/gcode-core`: parser, interpreter, diagnostics, transforms (no deps); estimator to come                                                                                                   |
| `packages/viewer`    | `@woodpatch/gcode-viewer`: 3D/2D path view (three.js)                                                                                                                                                |
| `packages/editor`    | `@woodpatch/gcode-editor`: CodeMirror 6 G-code mode, with diagnostics                                                                                                                                |
| `packages/svelte`    | `@woodpatch/gcode-svelte`: Svelte 5 components, shipped as source                                                                                                                                    |
| `packages/server`    | `@woodpatch/gcode-server`: HTTP analyse/transform/estimate _(placeholder)_                                                                                                                           |
| `packages/db-schema` | `@woodpatch/gcode-db`: machine/tool/material schema _(placeholder)_                                                                                                                                  |
| `apps/playground`    | The playground: open a file, see its path and diagnostics, transform it                                                                                                                              |
| `tools/`             | Dev tooling: the legacy-parser harness, golden generator, benchmarks and licence generator                                                                                                           |
| `legacy/`            | Upstream webgcode, parked: not built, linted or shipped                                                                                                                                              |
| `fixtures/`          | Test corpus and characterisation goldens ([`fixtures/README.md`](fixtures/README.md))                                                                                                                |
| `docs/`              | [`DECISIONS.md`](docs/DECISIONS.md) (decision records), [`ANALYSIS.md`](docs/ANALYSIS.md) (how upstream behaves), [`legacy-libraries.md`](docs/legacy-libraries.md) (licences of vendored libraries) |

## Development

Requires Node 22+ and pnpm 12 (the exact version is pinned in `package.json`).

```sh
pnpm install
pnpm lint        # ESLint + Prettier
pnpm typecheck
pnpm test
pnpm build
pnpm licence:packages   # MIT notice present in every built package and minified bundle
reuse lint              # every file carries copyright + licence information
```

Contributions need a DCO sign-off; see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

MIT; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). If you bundle these packages,
keep legal comments in your minifier output (for example esbuild
`legalComments: 'inline'` or `'eof'`). Each package's built entry carries the MIT
notice as a `/*! … */` banner, and MIT requires it to travel with copies of the
software, minified ones included.
