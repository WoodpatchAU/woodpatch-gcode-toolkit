// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The parity ledger (parcel 2f, ADR-0025): every line of every fixture where the core's
// path differs from upstream's, and why. Where upstream was right the core must match
// it; where upstream was wrong the core must differ, and the ledger must say which
// defect (R1-R14, N1-N15 in docs/ANALYSIS.md) or decision explains it. A difference
// no rule explains, or a rule that explains nothing, fails the check.
//
//   node tools/parity.mjs            regenerate docs/PARITY.md
//   node tools/parity.mjs --check    exit 1 if a difference is unexplained, a rule is
//                                    stale, or docs/PARITY.md is out of date (CI)
//   node tools/parity.mjs --explain  print every difference with its tag (for writing rules)
//
// Upstream's FULL path is regenerated with the golden harness and verified against
// the golden's SHA-256, so the comparison covers every segment even where the golden
// stores only a sample. Needs a built core (pnpm build).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { characterise, canonicalPath, sha } = require('./golden-legacy.cjs');
const { workerDollar } = require('./legacy-harness.cjs');
const { cell } = require('./markdown.cjs');
const { parse, interpret, LINUXCNC } = await import(join(root, 'packages/core/dist/index.js'));

const RULES_PATH = join(root, 'tools/data/parity-ledger.json');
const REPORT = join(root, 'docs/PARITY.md');
const CORPORA = ['upstream', 'synthetic'];
const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--explain')
    ? 'explain'
    : 'write';

// ── One move, as both sides can describe it ───────────────────────────────
// Kind, end point and feed, rounded to 0.1 µm and 0.01 mm/min: far finer than any
// real difference, coarser than the goldens' own 1 nm rounding.
const r = (v, k) => (typeof v === 'number' ? Math.round(v * k) / k : v);
const P = 1e4;
function upstreamMove(t) {
  const kind = t[0] === 'A' ? 'arc' : t[2] === 'rapid' ? 'rapid' : 'feed';
  const m = [kind, t[5].map((v) => r(v, P)), kind === 'rapid' ? null : `F${r(t[3], 100)}`];
  // Arcs: also the centre (in plane coordinates) and the signed sweep, so an arc
  // that ends in the right place but goes the wrong way round still differs.
  if (kind === 'arc')
    m.push(
      [t[7][0], t[7][1]].map((v) => r(v, P)),
      r(t[10], 1e6),
    );
  return m;
}
function coreMove(s) {
  const kind = s.kind === 'arc' ? 'arc' : s.rapid ? 'rapid' : 'feed';
  const f = s.feed;
  const feed =
    kind === 'rapid' || !f
      ? null
      : f.mode === 'per-minute'
        ? `F${r(f.mmPerMinute, 100)}`
        : f.mode === 'inverse-time'
          ? `1/${r(f.perMinute, 100)}`
          : f.mode === 'per-revolution'
            ? `F${r(f.mmPerRevolution, 100)}/rev`
            : 'F?';
  const m = [kind, [s.to.X, s.to.Y, s.to.Z].map((v) => r(v, P)), feed];
  if (kind === 'arc') {
    const [a, b] = { XY: ['X', 'Y'], ZX: ['Z', 'X'], YZ: ['Y', 'Z'] }[s.plane];
    m.push(
      [s.centre[a], s.centre[b]].map((v) => r(v, P)),
      r(s.sweep, 1e6),
    );
  }
  return m;
}

/** Every differing line of one fixture, tagged with what the core and upstream said there. */
function compare(dir, name) {
  const text = readFileSync(join(root, 'fixtures', dir, name), 'utf8');
  const up = characterise(text, workerDollar);
  const golden = JSON.parse(
    readFileSync(
      join(root, 'fixtures/golden/legacy', dir, name.replace(/\.(ngc|nc)$/, '.json')),
      'utf8',
    ),
  );
  if (golden.path && golden.path.sha256 !== sha(canonicalPath(up.tuples)))
    throw new Error(`${dir}/${name}: the harness no longer reproduces the golden`);

  const core = interpret(parse(text), { dialect: LINUXCNC });
  const U = new Map();
  const C = new Map();
  const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
  for (const t of up.tuples) push(U, t[1] + 1, upstreamMove(t));
  const startOf = new Map();
  let at = [0, 0, 0];
  for (const s of core.steps) {
    if ((s.kind !== 'linear' && s.kind !== 'arc') || s.file) continue;
    push(C, s.line, coreMove(s));
    if (!startOf.has(s.line))
      startOf.set(
        s.line,
        at.map((v) => r(v, P)),
      );
    at = [s.to.X, s.to.Y, s.to.Z];
  }
  const upErrorLines = new Set(up.result.errors.map((e) => e.lineNo + 1));
  const lines = [...new Set([...U.keys(), ...C.keys()])].sort((a, b) => a - b);
  const diffs = [];
  for (const n of lines) {
    const u = U.get(n) ?? [];
    const c = C.get(n) ?? [];
    if (JSON.stringify(u) === JSON.stringify(c)) continue;
    const codes = [...new Set(core.diagnostics.filter((d) => d.line === n).map((d) => d.code))]
      .sort()
      .join('+');
    let tag;
    if (up.result.outcome !== 'ok') tag = 'upstream-threw';
    else if (
      u.length === 0 &&
      c.length === 1 &&
      c[0][0] !== 'arc' &&
      JSON.stringify(c[0][1]) === JSON.stringify(startOf.get(n))
    )
      tag = 'zero-length';
    else if (codes) tag = `core:${codes}`;
    else if (upErrorLines.has(n)) tag = 'upstream-error';
    else tag = 'other';
    diffs.push({ file: `${dir}/${name}`, line: n, tag, upstream: u, core: c });
  }
  return { file: `${dir}/${name}`, lines: lines.length, segments: up.tuples.length, diffs };
}

// ── Rules ────────────────────────────────────────────────────────────────
const ledger = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
const glob = (pattern, s) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(s);
const matches = (rule, d) =>
  glob(rule.file, d.file) &&
  (rule.tag === undefined || glob(rule.tag, d.tag)) &&
  (rule.lines === undefined || (d.line >= rule.lines[0] && d.line <= rule.lines[1]));

const results = [];
for (const dir of CORPORA)
  for (const f of readdirSync(join(root, 'fixtures', dir))
    .filter((x) => /\.(ngc|nc)$/.test(x))
    .sort())
    results.push(compare(dir, f));

const all = results.flatMap((x) => x.diffs);
const used = new Map(ledger.rules.map((rule) => [rule.id, 0]));
const unexplained = [];
for (const d of all) {
  const rule = ledger.rules.find((x) => matches(x, d));
  if (!rule) unexplained.push(d);
  else {
    d.rule = rule;
    used.set(rule.id, used.get(rule.id) + 1);
  }
}

if (mode === 'explain') {
  for (const d of all)
    console.log(
      `${d.file}:${d.line} [${d.tag}] ${d.rule ? `→ ${d.rule.id}` : 'UNEXPLAINED'}\n  upstream ${JSON.stringify(d.upstream)}\n  core     ${JSON.stringify(d.core)}`,
    );
}

// ── Report ───────────────────────────────────────────────────────────────
const out = [];
// The report's own licence header. REUSE would read these lines as this file's.
// REUSE-IgnoreStart
out.push('<!--');
out.push(
  'SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden',
);
out.push('SPDX-License-Identifier: MIT');
out.push('-->');
// REUSE-IgnoreEnd
out.push('');
out.push('# Parity ledger: the core against upstream');
out.push('');
out.push(
  'Generated by `node tools/parity.mjs` from `tools/data/parity-ledger.json`; CI checks it (ADR-0025). Do not edit by hand.',
);
out.push('');
out.push(
  "Every fixture runs through upstream's own parser (regenerated, and verified against its golden) and through the core (LinuxCNC 2.9 dialect). Their paths are compared line by line: each move's kind, end point (to 0.1 µm) and feed, and for arcs the centre and the signed sweep (to 1 µrad). A line where they differ must be explained by a rule below, which names the upstream defect or the decision behind it. **Everything not listed is identical.**",
);
out.push('');
const moveLines = results.reduce((a, x) => a + x.lines, 0);
const segs = results.reduce((a, x) => a + x.segments, 0);
out.push(
  `**${results.length} fixtures, ${moveLines.toLocaleString('en-AU')} lines with motion, ${segs.toLocaleString('en-AU')} upstream segments. ${all.length} lines differ, ${all.length - unexplained.length} of them explained.**`,
);
out.push('');
out.push('## By fixture');
out.push('');
out.push('| Fixture | Lines with motion | Differ | Why |');
out.push('| --- | ---: | ---: | --- |');
for (const x of results) {
  const why = [...new Set(x.diffs.map((d) => (d.rule ? d.rule.id : 'UNEXPLAINED')))].join(', ');
  out.push(`| \`${x.file}\` | ${x.lines} | ${x.diffs.length} | ${why || 'identical'} |`);
}
out.push('');
out.push('## Rules');
out.push('');
out.push('| Rule | Ref | Lines | Why the core differs |');
out.push('| --- | --- | ---: | --- |');
for (const rule of ledger.rules)
  out.push(`| ${rule.id} | ${rule.ref} | ${used.get(rule.id)} | ${cell(rule.why)} |`);
out.push('');
const report = out.join('\n');

let failed = false;
if (unexplained.length) {
  failed = true;
  console.error(`::error::${unexplained.length} difference(s) from upstream have no ledger rule:`);
  for (const d of unexplained.slice(0, 20))
    console.error(
      `  ${d.file}:${d.line} [${d.tag}]\n    upstream ${JSON.stringify(d.upstream)}\n    core     ${JSON.stringify(d.core)}`,
    );
}
for (const [id, n] of used)
  if (n === 0) {
    failed = true;
    console.error(`::error::ledger rule "${id}" explains nothing any more: remove it`);
  }
if (mode === 'check') {
  let current = '';
  try {
    current = readFileSync(REPORT, 'utf8');
  } catch {
    // missing: reported below
  }
  if (current !== report) {
    failed = true;
    console.error('::error::docs/PARITY.md is out of date: run node tools/parity.mjs');
  }
} else if (mode === 'write') writeFileSync(REPORT, report);
console.log(
  `parity: ${results.length} fixtures, ${all.length} differing lines, ${unexplained.length} unexplained`,
);
process.exitCode = failed ? 1 : 0;
