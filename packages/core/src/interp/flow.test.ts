// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LINUXCNC_INTERPRETER_RULES,
  interpret,
  parse,
  type InterpretOptions,
  type InterpreterRules,
  type Step,
} from '../index.js';

// Parcel 2c-3 (ADR-0021): O-word program flow (LinuxCNC) and M98/M99 subprogram
// files (Masso). Examples marked "LinuxCNC docs" are from o-code.adoc, move for move.

const run = (src: string, options?: InterpretOptions) => interpret(parse(src), options);
const moves = (steps: readonly Step[]) =>
  steps.flatMap((s) => (s.kind === 'linear' || s.kind === 'arc' ? [s] : []));
const ends = (src: string, options?: InterpretOptions) =>
  moves(run(src, options).steps).map((s) => [s.to.X, s.to.Y, s.to.Z]);
const xs = (src: string, options?: InterpretOptions) =>
  moves(run(src, options).steps).map((s) => s.to.X);
const codes = (src: string, options?: InterpretOptions) =>
  run(src, options).diagnostics.map((d) => d.code);
const errors = (src: string, options?: InterpretOptions) =>
  run(src, options)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.code);
const files =
  (map: Record<string, string>): NonNullable<InterpretOptions['resolveProgram']> =>
  ({ name }) =>
    map[name];

/** The Masso subprogram rules (the full profile arrives in parcel 2e). */
const MASSO_LIKE: InterpreterRules = {
  ...LINUXCNC_INTERPRETER_RULES,
  subprograms: { oWord: false, m98: 'file', maxCallDepth: 5 },
};

describe('conditions', () => {
  it('runs the first true branch of if/elseif/else (LinuxCNC docs)', () => {
    const prog = (v: number) => `#2=${v}
o102 if [#2 GT 5]
  G0 X100
o102 elseif [#2 LT 2]
  G0 X200
o102 else
  G0 X150
o102 endif
G0 Y1`;
    expect(xs(prog(6))).toEqual([100, 100]);
    expect(xs(prog(1))).toEqual([200, 200]);
    expect(xs(prog(3))).toEqual([150, 150]);
    expect(codes(prog(3))).toEqual([]);
  });

  it('skips an if with no else when false, and treats any non-zero value as true', () => {
    expect(xs('o1 if [0]\nG0 X1\no1 endif\nG0 X2')).toEqual([2]);
    expect(xs('o1 if [0.5]\nG0 X1\no1 endif')).toEqual([1]);
    expect(xs('o1 if [-1]\nG0 X1\no1 endif')).toEqual([1]);
  });

  it('evaluates an elseif condition when reached, even after a branch ran (LinuxCNC 2.9)', () => {
    // read_o skips evaluation only for OTHER labels, so after the if branch runs, the
    // elseif's condition is still read: a division by zero there stops the run.
    const src = 'o1 if [1]\nG0 X1\no1 elseif [1/0]\nG0 X2\no1 endif\nG0 X3';
    expect(errors(src)).toContain('SEMANTIC_FLOW_STOPPED');
    expect(xs(src)).toEqual([1]);
    // An elseif that is never reached is never evaluated.
    expect(errors('o1 if [0]\no1 elseif [1]\nG0 X2\no1 else\no1 endif')).toEqual([]);
  });

  it('nests, including the same label in different scopes', () => {
    const src = `o1 if [1]
  o2 if [0]
    G0 X9
  o2 else
    G0 X1
  o2 endif
o1 endif
o5 sub
  o1 if [1]
    G0 X#1
  o1 endif
o5 endsub
o5 call [7]`;
    expect(xs(src)).toEqual([1, 7]);
    expect(codes(src)).toEqual([]);
  });
});

describe('loops', () => {
  it('draws the sawtooth while loop (LinuxCNC docs)', () => {
    const src = `G0 X1 Y0 (move to start position)
#1 = 0 (assign parameter #1 the value of 0)
F25 (set a feed rate)
o101 while [#1 LT 10]
  G1 X0
  G1 Y[#1/10] X1
  #1 = [#1+1] (increment the test counter)
o101 endwhile
M2 (end program)`;
    const e = ends(src);
    expect(e).toHaveLength(21);
    expect(e[1]).toEqual([0, 0, 0]);
    expect(e[20]?.[0]).toBe(1);
    expect(e[20]?.[1]).toBeCloseTo(0.9, 12);
    expect(codes(src)).toEqual([]);
  });

  it('runs a do/while body before testing, and continue re-tests (LinuxCNC docs)', () => {
    const src = `#1 = 0
o100 do
  G0 X#1
  o110 if [#1 EQ 2]
    #1 = 3
    o100 continue
  o110 endif
  #1 = [#1 + 1]
o100 while [#1 LT 3]
G0 Y9`;
    // X0, X1, X2 (then #1 becomes 3 and continue tests the while: false), then Y9.
    expect(xs(src)).toEqual([0, 1, 2, 2]);
    expect(xs('o1 do\nG0 X5\no1 while [0]')).toEqual([5]);
  });

  it('repeats a block a rounded number of times (LinuxCNC docs, diagonal shapes)', () => {
    const src = 'G91\no103 repeat [5]\nG0 X1 Y1\no103 endrepeat\nG90';
    expect(ends(src).map(([x, y]) => [x, y])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
    expect(xs('G91\no1 repeat [2.6]\nG0 X1\no1 endrepeat')).toEqual([1, 2, 3]);
    expect(xs('o1 repeat [0]\nG0 X1\no1 endrepeat\nG0 X2')).toEqual([2]);
    expect(xs('o1 repeat [-3]\nG0 X1\no1 endrepeat\nG0 X2')).toEqual([2]);
  });

  it('restarts a repeat count each time its loop is entered', () => {
    const src = `G91
#1=0
o1 while [#1 LT 2]
  o2 repeat [3]
    G0 X1
  o2 endrepeat
  #1=[#1+1]
o1 endwhile`;
    expect(xs(src)).toHaveLength(6);
  });

  it('leaves the loop on break, from a while or a do', () => {
    const src = (open: string, close: string) => `#1=0
${open}
  #1=[#1+1]
  o2 if [#1 EQ 3]
    o1 break
  o2 endif
  G0 X#1
${close}
G0 Y5`;
    expect(xs(src('o1 while [1]', 'o1 endwhile'))).toEqual([1, 2, 2]);
    expect(xs(src('o1 do', 'o1 while [1]'))).toEqual([1, 2, 2]);
  });
});

describe('subroutines', () => {
  it('skips a definition, and runs it on call (LinuxCNC docs)', () => {
    const src = `o100 sub
  G53 G0 X0 Y0 Z0 (rapid move to machine home)
o100 endsub
G0 X5
o100 call
M2`;
    expect(xs(src)).toEqual([5, 0]);
  });

  it('passes arguments as #1-#30 and restores the caller’s on return', () => {
    const src = `#1=11
#3=33
#31=1
o100 sub
  G0 X#1 Y#2 Z#3
  #1=99
  #31=2
o100 endsub
o100 call [100] [2]
G0 X#1 Y#3 Z#31`;
    // #3 was not passed, so it is ZERO inside the sub (LinuxCNC 2.9 read_o: "zero the
    // remaining params"). After return, #1 and #3 are the caller's again; #31 (above
    // #30) changed globally.
    expect(ends(src)).toEqual([
      [100, 2, 0],
      [11, 33, 2],
    ]);
  });

  it('returns early on return, with a value in #<_value> (LinuxCNC docs)', () => {
    const src = `o100 sub
  o110 if [#2 GT 5]
    o100 return [#2 * 5]
  o110 endif
  G0 X#1
o100 endsub [3 * 4]
o100 call [100] [2] [325]
G0 Y#<_value> Z#<_value_returned>
o100 call [100] [6]
G0 Y#<_value>`;
    expect(ends(src)).toEqual([
      [100, 0, 0],
      [100, 12, 1],
      [100, 30, 1],
    ]);
  });

  it('keeps named parameters local unless they start with "_"', () => {
    const src = `#<depth>=1
#<_global>=2
o1 sub
  o2 if [EXISTS[#<depth>]]
    G0 X9
  o2 endif
  #<depth>=5
  #<_global>=6
o1 endsub
o1 call
G0 X#<depth> Y#<_global>`;
    expect(ends(src)).toEqual([[1, 6, 0]]);
  });

  it('calls a subroutine defined later in the main program (as LinuxCNC’s source allows)', () => {
    expect(xs('o<later> call [4]\nM2\no<later> sub\nG0 X#1\no<later> endsub')).toEqual([4]);
  });

  it('normalises labels: o0100 is o100, and <My Sub> is <mysub>', () => {
    expect(xs('o100 sub\nG0 X1\no100 endsub\no0100 call')).toEqual([1]);
    expect(xs('o<mysub> sub\nG0 X2\no<mysub> endsub\no<My Sub> call')).toEqual([2]);
  });

  it('recurses, and allows 9 levels of calls, as LinuxCNC does', () => {
    const deep = (levels: number) => `o<r> sub
  G0 X#1
  o1 if [#1 LT ${levels}]
    o<r> call [#1+1]
  o1 endif
o<r> endsub
o<r> call [1]`;
    expect(xs(deep(9))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(errors(deep(9))).toEqual([]);
    expect(xs(deep(10))).toHaveLength(9);
    expect(errors(deep(10))).toEqual(['SEMANTIC_CALL_TOO_DEEP']);
  });

  it('reports a call to a subroutine that exists nowhere', () => {
    // A failed call aborts on the controller, so the run stops: nothing after it is drawn.
    expect(codes('o<nope> call\nG0 X1')).toEqual(['SEMANTIC_SUB_NOT_FOUND']);
    expect(xs('o<nope> call\nG0 X1')).toEqual([]);
  });

  it('treats a bare O number as a program number', () => {
    expect(codes('O1000\nG0 X1')).toEqual([]);
    expect(xs('O1000\nG0 X1')).toEqual([1]);
  });

  it('stops at other words on an O-word line (LinuxCNC: "Unexpected character after O-word")', () => {
    expect(codes('o1 if [1] G0 X5\no1 endif')).toEqual(['SEMANTIC_OWORD_EXTRA_WORDS']);
    expect(xs('o1 if [1] G0 X5\no1 endif')).toEqual([]);
  });
});

describe('subroutine files (o<name> call)', () => {
  const lib = {
    square: `(square.ngc)
G0 X99 (before the sub: never run)
o<square> sub
  G91 G1 X#1 F100
  Y#1
  X-#1
  Y-#1
  G90
o<square> endsub
M2`,
    broken: 'o<broken> sub\nG0 X#<undefined>\no<broken> endsub',
    other: 'o<something> sub\no<something> endsub',
  };

  it('loads the file from the resolver and runs its sub', () => {
    const r = run('G0 X10\no<square> call [5]\nG0 X0', { resolveProgram: files(lib) });
    expect(moves(r.steps).map((s) => [s.to.X, s.to.Y])).toEqual([
      [10, 0],
      [15, 0],
      [15, 5],
      [10, 5],
      [10, 0],
      [0, 0],
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  it('marks steps and diagnostics from the file with its name and its own line numbers', () => {
    const r = run('o<square> call [5]\nG0 X0\no<broken> call', { resolveProgram: files(lib) });
    const m = moves(r.steps);
    expect(m[0]).toMatchObject({ file: 'square', line: 4 });
    expect(m[4]).not.toHaveProperty('file');
    expect(r.diagnostics.filter((d) => d.file === 'broken').map((d) => d.line)).toContain(2);
  });

  it('asks the resolver once per file', () => {
    const asked: string[] = [];
    run('o<square> call [1]\no<square> call [2]', {
      resolveProgram: (req) => {
        asked.push(`${req.kind}:${req.name}`);
        return lib.square;
      },
    });
    expect(asked).toEqual(['o-word:square']);
  });

  it('reports a missing file, a resolver with no answer, and a file without the sub', () => {
    expect(codes('o<gone> call', { resolveProgram: files(lib) })).toEqual([
      'SEMANTIC_SUB_NOT_FOUND',
    ]);
    const noResolver = run('o<square> call').diagnostics[0]?.message;
    expect(noResolver).toMatch(/program resolver/);
    expect(codes('o<other> call', { resolveProgram: files(lib) })).toEqual([
      'SEMANTIC_SUB_NOT_FOUND',
    ]);
  });

  it('reports a resolver that throws, without throwing', () => {
    const r = run('o<x> call\nG0 X1', {
      resolveProgram: () => {
        throw new Error('disk on fire');
      },
    });
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      'SEMANTIC_RESOLVER_FAILED',
      'SEMANTIC_SUB_NOT_FOUND',
    ]);
    expect(xs('o<x> call\nG0 X1')).toEqual([]);
  });
});

describe('structure errors stop the run (as LinuxCNC aborts)', () => {
  it.each([
    ['nested definition', 'o1 sub\no2 sub\no2 endsub\no1 endsub', 'SEMANTIC_OWORD_NESTED_SUB'],
    ['endsub outside a sub', 'o1 endsub', 'SEMANTIC_OWORD_UNMATCHED'],
    ['return outside its sub', 'o1 return', 'SEMANTIC_OWORD_UNMATCHED'],
    ['endif without if', 'o1 endif', 'SEMANTIC_OWORD_UNMATCHED'],
    ['mismatched label', 'o1 if [1]\no2 endif', 'SEMANTIC_OWORD_UNMATCHED'],
    ['else after else', 'o1 if [0]\no1 else\no1 else\no1 endif', 'SEMANTIC_OWORD_AFTER_ELSE'],
    ['unclosed while', 'o1 while [0]\nG0 X1', 'SEMANTIC_OWORD_UNCLOSED'],
    ['sub with no endsub', 'o1 sub\nG0 X1', 'SEMANTIC_OWORD_UNCLOSED'],
    ['break outside a loop', 'o1 break', 'SEMANTIC_OWORD_UNMATCHED'],
    [
      'break in a repeat (LinuxCNC: while or do only)',
      'o1 repeat [2]\no1 break\no1 endrepeat',
      'SEMANTIC_OWORD_UNMATCHED',
    ],
    [
      'label reused in one scope',
      'o1 if [1]\no1 endif\no1 if [1]\no1 endif',
      'SEMANTIC_OWORD_DUPLICATE_LABEL',
    ],
    ['sub defined twice', 'o1 sub\no1 endsub\no1 sub\no1 endsub', 'SEMANTIC_OWORD_DUPLICATE_SUB'],
  ])('%s', (_name, src, code) => {
    const found = errors(src);
    expect(found).toContain(code);
  });

  it('stops at the broken line, having run what came before', () => {
    const r = run('G0 X1\no1 endif\nG0 X2');
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([1]);
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      'SEMANTIC_OWORD_UNMATCHED',
      'SEMANTIC_FLOW_STOPPED',
    ]);
  });

  it('stops when a condition cannot be evaluated or is missing', () => {
    expect(errors('o1 if [#<nope>]\nG0 X1\no1 endif\nG0 X2')).toContain('SEMANTIC_FLOW_STOPPED');
    expect(xs('o1 if [#<nope>]\nG0 X1\no1 endif\nG0 X2')).toEqual([]);
    expect(errors('o1 while\no1 endwhile')).toEqual(['SEMANTIC_OWORD_NO_ARGUMENT']);
    expect(errors('o1 repeat\no1 endrepeat')).toEqual(['SEMANTIC_OWORD_NO_ARGUMENT']);
  });
});

describe('safety limits (for untrusted input)', () => {
  it('stops an endless loop at the iteration limit', () => {
    const r = run('o1 while [1]\nG0 X1\no1 endwhile', { limits: { maxLoopIterations: 50 } });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_LIMIT_ITERATIONS']);
    expect(moves(r.steps)).toHaveLength(51);
  });

  it('stops at the block limit, counting canned-cycle repeats before building them', () => {
    expect(
      errors('G0 Z5\nG81 X1 Z-1 R1 L1000000000 F100', { limits: { maxBlocks: 1000 } }),
    ).toEqual(['SEMANTIC_LIMIT_BLOCKS']);
    expect(errors('G0 X1\nG0 X2\nG0 X3', { limits: { maxBlocks: 2 } })).toEqual([
      'SEMANTIC_LIMIT_BLOCKS',
    ]);
  });

  it('caps call depth whatever the dialect allows', () => {
    const rules = {
      ...LINUXCNC_INTERPRETER_RULES,
      subprograms: { ...LINUXCNC_INTERPRETER_RULES.subprograms, maxCallDepth: 1000 },
    };
    const src = 'o<r> sub\no<r> call\no<r> endsub\no<r> call';
    expect(errors(src, { interpreterRules: rules, limits: { maxCallDepth: 20 } })).toEqual([
      'SEMANTIC_LIMIT_CALL_DEPTH',
    ]);
  });
});

describe('Masso-style subprogram files (M98 P<n> / M99)', () => {
  const opts = (map: Record<string, string>): InterpretOptions => ({
    interpreterRules: MASSO_LIKE,
    resolveProgram: files(map),
  });

  it('runs file n, L times, returning at M99 (Masso docs: M98 P10 L5)', () => {
    const r = run('G91\nN10 M98 P10 L5\nG90 G0 Y1', opts({ '10': 'G0 X1\nM99' }));
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([1, 2, 3, 4, 5, 5]);
    expect(moves(r.steps)[0]).toMatchObject({ file: '10', line: 1 });
    expect(r.diagnostics).toEqual([]);
  });

  it('shares parameters with the caller, runs once without L, and not at all with L0', () => {
    expect(xs('M98 P1\nG0 X#1', opts({ '1': '#1=7\nM99' }))).toEqual([7]);
    expect(xs('M98 P1 L0\nG0 X2', opts({ '1': 'G0 X1\nM99' }))).toEqual([2]);
  });

  it('asks the resolver for the number, without leading zeros', () => {
    const asked: string[] = [];
    run('M98 P007', {
      interpreterRules: MASSO_LIKE,
      resolveProgram: (r) => {
        asked.push(`${r.kind}:${r.name}`);
        return 'M99';
      },
    });
    expect(asked).toEqual(['m98:7']);
  });

  it('allows 5 levels of nesting and refuses a 6th', () => {
    const chain = (levels: number) =>
      Object.fromEntries(
        Array.from({ length: levels }, (_, i) => [
          String(i + 1),
          `G0 X${i + 1}\n${i + 1 < levels ? `M98 P${i + 2}\n` : ''}M99`,
        ]),
      );
    expect(errors('M98 P1', opts(chain(5)))).toEqual([]);
    expect(xs('M98 P1', opts(chain(5)))).toEqual([1, 2, 3, 4, 5]);
    expect(errors('M98 P1', opts(chain(6)))).toEqual(['SEMANTIC_CALL_TOO_DEEP']);
  });

  it('reports a missing file, a missing or bad P, and a bad L', () => {
    expect(errors('M98 P3', opts({}))).toEqual(['SEMANTIC_SUB_NOT_FOUND']);
    expect(errors('M98', opts({}))).toEqual(['SEMANTIC_M98_NO_P']);
    expect(errors('M98 P1.5', opts({}))).toEqual(['SEMANTIC_M98_BAD_P']);
    expect(errors('M98 P0', opts({}))).toEqual(['SEMANTIC_M98_BAD_P']);
    expect(errors('M98 P1 L-1', opts({ '1': 'M99' }))).toEqual(['SEMANTIC_M98_BAD_L']);
  });

  it('returns at the end of a file with no M99, with a warning', () => {
    const r = run('M98 P1\nG0 X2', opts({ '1': 'G0 X1' }));
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([1, 2]);
    expect(r.diagnostics).toMatchObject([{ code: 'SEMANTIC_SUB_NO_RETURN', file: '1' }]);
  });

  it('ends the drawing at an M99 in the main program, with a warning', () => {
    const r = run('G0 X1\nM99\nG0 X2', opts({}));
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([1]);
    expect(r.steps.at(-1)).toMatchObject({ kind: 'end', by: 'M99' });
    expect(r.diagnostics.map((d) => d.code)).toContain('SEMANTIC_M99_IN_MAIN');
  });

  it('does not accept O-words', () => {
    expect(errors('o1 if [1]\no1 endif', opts({}))).toEqual([
      'SEMANTIC_UNSUPPORTED_OWORD',
      'SEMANTIC_UNSUPPORTED_OWORD',
    ]);
  });

  it('under LinuxCNC rules, M98/M99 (Fanuc style, within the file) are not interpreted yet', () => {
    expect(errors('M98 P100')).toEqual(['SEMANTIC_NOT_YET_SUPPORTED']);
    expect(errors('M99')).toEqual(['SEMANTIC_NOT_YET_SUPPORTED']);
  });
});

describe('signed parameter values', () => {
  it('negates the value after a sign, as LinuxCNC does (X-#1)', () => {
    expect(ends('#1=2\nG0 X-#1 Y+[#1*3] Z--#1')).toEqual([[-2, 6, 2]]);
  });
});

describe('limits and attribution corner cases', () => {
  it('counts continue towards the iteration limit', () => {
    expect(
      errors('o1 while [1]\no1 continue\no1 endwhile', { limits: { maxLoopIterations: 10 } }),
    ).toEqual(['SEMANTIC_LIMIT_ITERATIONS']);
  });

  it('reports a file loaded from another file under its own name', () => {
    const r = run('o<a> call', {
      resolveProgram: files({
        a: 'o<a> sub\no<b> call\no<a> endsub',
        b: 'o<b> sub\nG0 X)\no<b> endsub',
      }),
    });
    expect(r.diagnostics.map((d) => d.file)).not.toContain('a');
    expect(r.diagnostics.every((d) => d.file === 'b')).toBe(true);
  });
});

describe('R8 fixtures: differs from upstream deliberately', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../../../../fixtures/synthetic/${name}`, import.meta.url), 'utf8');
  const golden = (name: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../../../fixtures/golden/legacy/synthetic/${name}`, import.meta.url),
        'utf8',
      ),
    ) as { summary: { segments: number }; errors: unknown[] };

  it('runs the O-word subroutine that upstream could not read', () => {
    // Upstream: three "did not understand line" errors and nothing drawn.
    const legacy = golden('r8-o-word-sub.json');
    expect(legacy.summary.segments).toBe(0);
    expect(legacy.errors).toHaveLength(3);
    const r = run(fixture('r8-o-word-sub.ngc'));
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([10]);
    expect(r.diagnostics).toEqual([]);
  });

  it('reads a program number line without complaint', () => {
    const r = run(fixture('r8-program-number.ngc'));
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([10]);
    expect(r.diagnostics).toEqual([]);
  });
});

describe('reviewer findings on #12, pinned (LinuxCNC 2.9 source)', () => {
  it('zeroes unpassed arguments, so a default-argument idiom works', () => {
    const src = `#2=7
o1 sub
  o2 if [#2 EQ 0]
    #2=5
  o2 endif
  G0 X#2
o1 endsub
o1 call [1]
o1 call [1] [9]`;
    expect(xs(src)).toEqual([5, 9]);
  });

  it('takes exactly 30 arguments, and refuses 31', () => {
    const args = (k: number) => Array.from({ length: k }, (_, i) => `[${i + 1}]`).join(' ');
    const src = (k: number) => `o1 sub\nG0 X#30\no1 endsub\no1 call ${args(k)}\nG0 Y1`;
    expect(xs(src(30))).toEqual([30, 30]);
    expect(errors(src(31))).toEqual(['SEMANTIC_CALL_ARGUMENTS']);
    expect(xs(src(31))).toEqual([]);
  });

  it('rounds a repeat count half to even (nearbyint)', () => {
    const n = (v: string) => xs(`G91\no1 repeat [${v}]\nG0 X1\no1 endrepeat`).length;
    expect([n('0.5'), n('1.5'), n('2.5'), n('3.5'), n('2.6')]).toEqual([0, 2, 2, 4, 3]);
  });

  it('zeroes #<_value> on a valueless return, keeps it across calls, and it is read-only', () => {
    const src = `o1 sub
  o1 return [42]
o1 endsub
o2 sub
o2 endsub
G0 X#<_value> Y#<_value_returned>
o1 call
G0 X#<_value> Y#<_value_returned>
o2 call
G0 X#<_value> Y#<_value_returned>`;
    expect(ends(src).map(([x, y]) => [x, y])).toEqual([
      [0, 0],
      [42, 1],
      [0, 0],
    ]);
    expect(errors('#<_value>=3')).toEqual(['SEMANTIC_BAD_ASSIGNMENT']);
  });

  it('refuses to reach a definition again after a forward call (illegal location)', () => {
    const src = 'o<a> call\no<a> sub\nG0 X1\no<a> endsub\nG0 X2';
    expect(errors(src)).toEqual(['SEMANTIC_OWORD_SUB_ILLEGAL_LOCATION']);
    expect(xs(src)).toEqual([1]);
    // Defined first, then called: fine.
    expect(errors('o<a> sub\nG0 X1\no<a> endsub\no<a> call\nG0 X2')).toEqual([]);
    // A definition inside a loop is reached twice: illegal.
    expect(
      errors('#1=0\no9 while [#1 LT 2]\n#1=[#1+1]\no<a> sub\no<a> endsub\no9 endwhile'),
    ).toEqual(['SEMANTIC_OWORD_SUB_ILLEGAL_LOCATION']);
  });

  it('evaluates a do loop\u2019s closing while after break', () => {
    expect(errors('o1 do\no1 break\no1 while [1/0]\nG0 X1')).toContain('SEMANTIC_FLOW_STOPPED');
    expect(errors('o1 do\no1 break\no1 while [1]\nG0 X1')).toEqual([]);
  });

  it('stops a do-while at the iteration limit', () => {
    expect(errors('o1 do\nG0 X1\no1 while [1]', { limits: { maxLoopIterations: 20 } })).toEqual([
      'SEMANTIC_LIMIT_ITERATIONS',
    ]);
  });

  it('stops at the step limit, and keeps a bounded number of diagnostics', () => {
    const loop = 'o1 while [1]\nG0 X1\nG0 X2\no1 endwhile';
    const r = run(loop, { limits: { maxSteps: 100, maxLoopIterations: 1e9 } });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_LIMIT_STEPS']);
    expect(r.steps.length).toBeLessThanOrEqual(102);
    const noisy = run('#1=0\no1 while [#1 LT 500]\nG0 X1 Q1\n#1=[#1+1]\no1 endwhile', {
      limits: { maxDiagnostics: 50 },
    });
    expect(noisy.diagnostics).toHaveLength(51);
    expect(noisy.diagnostics.at(-1)).toMatchObject({ code: 'SEMANTIC_DIAGNOSTICS_TRUNCATED' });
  });

  it('refuses a G83/G73 with too many pecks at once, instead of looping (was endless)', () => {
    const t = performance.now();
    expect(errors('G0 Z5\nG83 X0 Z-1 R1000000 Q0.00000000001 F100')).toEqual([
      'SEMANTIC_CYCLE_TOO_MANY_PECKS',
    ]);
    expect(errors('G0 Z5\nG73 X0 Z-1000 R1 Q0.001 F100')).toEqual([
      'SEMANTIC_CYCLE_TOO_MANY_PECKS',
    ]);
    expect(performance.now() - t).toBeLessThan(1000);
    // A normal deep peck still works.
    expect(errors('G0 Z5\nG83 X0 Z-100 R1 Q0.5 F100')).toEqual([]);
  });

  it('bounds a huge M98 L by the iteration limit', () => {
    expect(
      errors('M98 P1 L1000000000', {
        interpreterRules: MASSO_LIKE,
        resolveProgram: files({ '1': 'G0 X1\nM99' }),
      }),
    ).toEqual(['SEMANTIC_LIMIT_ITERATIONS']);
  });

  it('treats % per file: a %-wrapped subprogram file does not end the program', () => {
    const r = run('%\nM98 P1\nG0 X2\n%', {
      interpreterRules: MASSO_LIKE,
      resolveProgram: files({ '1': '%\nG0 X1\nM99\n%' }),
    });
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([1, 2]);
  });
});

describe('onBlock: the modal state each executed block runs under', () => {
  it('reports every executed block, fast-path lines too, and not skipped ones', () => {
    const seen: string[] = [];
    interpret(parse('G20\nX1 Y1\n/G21\no100 sub\nG1 X2 F10\no100 endsub\nG91\no100 call\nM2'), {
      onBlock: ({ line, file, state }) =>
        seen.push(`${line}${file ? `@${file}` : ''}:${state.units}/${state.distance}`),
    });
    // Line 3 is block-deleted; line 5 runs in the caller's G91.
    expect(seen).toEqual([
      '1:mm/absolute',
      '2:inch/absolute',
      '7:inch/absolute',
      '5:inch/incremental',
      '9:inch/incremental',
    ]);
  });

  it('names the file of a block in a subprogram file', () => {
    const seen: string[] = [];
    interpret(parse('G21\no<part> call\nM2'), {
      resolveProgram: ({ name }) =>
        name === 'part' ? 'o<part> sub\nG1 X1 F10\no<part> endsub' : undefined,
      onBlock: ({ line, file }) => seen.push(`${line}${file ? `@${file}` : ''}`),
    });
    expect(seen).toEqual(['1', '2@part', '3']);
  });
});
