// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_LISTED, MAX_TEXT, boundText, parseRequest, type EstimateRequest } from './contract.js';
import { CALIBRATION_MAX_AGE_DAYS, handleEstimate, type EstimateResponse } from './handle.js';

const EXAMPLE = JSON.parse(
  readFileSync(new URL('../../db-schema/examples/example-router.json', import.meta.url), 'utf8'),
);
const CALIBRATED = {
  ...EXAMPLE,
  // A calibrated record holds no seed value (ADR-0041).
  axes: JSON.parse(JSON.stringify(EXAMPLE.axes).replaceAll('"seed"', '"manual"')),
  planner: { junctionDeviation: { value: 0.02, source: 'fitted' } },
  spindle: JSON.parse(JSON.stringify(EXAMPLE.spindle).replaceAll('"seed"', '"manual"')),
  overheads: { toolChangeSeconds: { value: 60, source: 'measured' } },
  calibration: {
    status: 'calibrated',
    fittedOn: '2026-10-01',
    timeFactor: 1.5,
    accelFactor: 1,
    residuals: { jobs: 5, meanAbsPercent: 2, maxAbsPercent: 4 },
  },
};

const BUILD = 'test-build';
const TODAY = '2026-10-26';
function request(gcode: string, record: object = EXAMPLE): EstimateRequest {
  const r = parseRequest(
    JSON.stringify({ v: 1, scope: 'staff:1', gcode, machine: JSON.stringify(record) }),
  );
  if (!r.ok) throw new Error(r.error.error.code);
  return r.request;
}
const run = (gcode: string, record?: object): EstimateResponse =>
  handleEstimate(request(gcode, record), BUILD, TODAY);

const JOB = 'G21 G90\nM3 S12000\nG0 X0 Y0 Z5\nG1 Z-1 F300\nG1 X100 F1500\nG0 Z5\nM5\nM30\n';
const TIMES = ['knownMs', 'cutMs', 'rapidMs', 'eventMs', 'dwellMs'] as const;

describe('handleEstimate', () => {
  it('answers a complete job in whole milliseconds, with the record echoed', () => {
    const r = run(JOB);
    expect(r.v).toBe(1);
    expect(r.build).toBe(BUILD);
    expect(r.estimate.complete).toBe(true);
    expect(r.estimate.totalMs).toBe(r.estimate.knownMs);
    for (const k of TIMES) expect(Number.isSafeInteger(r.estimate[k]), k).toBe(true);
    for (const t of r.estimate.perTool.items) expect(Number.isSafeInteger(t.ms)).toBe(true);
    expect(r.record).toEqual({
      id: 'example-1',
      version: 1,
      revision: 1,
      calibration: 'uncalibrated',
      hash: request(JOB).recordHash,
    });
    expect(r.record.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is uncalibrated, and says the rapid model is assumed, for a v1 record', () => {
    const r = run(JOB);
    expect(r.estimate.calibrated).toBe(false);
    expect(r.estimate.notes.items.join('\n')).toMatch(/rapid/i);
  });

  it('applies a calibrated record, and says so', () => {
    const plain = run(JOB);
    const cal = run(JOB, CALIBRATED);
    expect(cal.estimate.calibrated).toBe(true);
    expect(cal.record.calibration).toBe('calibrated');
    // timeFactor 1.5 on motion and events alike, give or take each part's rounding.
    expect(cal.estimate.totalMs).toBeCloseTo((plain.estimate.totalMs as number) * 1.5, -1);
  });

  it('has no total for an incomplete job, only the known part', () => {
    const r = run(`${JOB.replace('M30\n', '')}G1 X5 Y5 Q\n`);
    expect(r.estimate.complete).toBe(false);
    expect(r.estimate.totalMs).toBeNull();
    expect(r.estimate.knownMs).toBeGreaterThan(0);
    expect(r.estimate.unknowns.count).toBeGreaterThan(0);
  });

  it("runs the record's dialect", () => {
    // G54.1 P1 is Masso's; LinuxCNC 2.9 doesn't have it.
    const src = 'G54.1 P1\nG0 X1\n';
    const masso = run(src, { ...EXAMPLE, dialect: 'masso-g3-5.13' });
    const linux = run(src, { ...EXAMPLE, dialect: 'linuxcnc-2.9' });
    expect(masso.estimate.complete).toBe(true);
    expect(linux.estimate.complete).toBe(false);
  });

  it("travel-checks against the record's limits", () => {
    // The example's X is 0 to 2440: a 3000 mm extent never fits.
    const r = run('G0 X0\nG0 X3000\n');
    expect(r.travel.items.map((d) => d.code)).toEqual(['TRAVEL_EXTENT']);
    expect(run('G0 X0\nG0 X2000\n').travel.count).toBe(0);
  });

  it('lists at most MAX_LISTED of anything, and says how many there were', () => {
    const r = run('G1 X1 Q\n'.repeat(MAX_LISTED + 50));
    expect(r.diagnostics.count).toBeGreaterThan(MAX_LISTED);
    expect(r.diagnostics.items).toHaveLength(MAX_LISTED);
    expect(r.estimate.unknowns.count).toBeGreaterThan(MAX_LISTED);
    expect(r.estimate.unknowns.items).toHaveLength(MAX_LISTED);
    // In line order, parser's and interpreter's findings together.
    const lines = r.diagnostics.items.map((d) => d.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it("gives the parser's findings with the interpreter's, in line order", () => {
    // Line 1: refused by the interpreter (Q1 outside a cycle); line 2: a syntax error.
    const r = run('G1 X1 Q1\nG0 X1 (open\n');
    const found = r.diagnostics.items.map((d) => `${d.line} ${d.code.split('_')[0]}`);
    expect(found[0]).toBe('1 SEMANTIC');
    expect(found).toContain('2 SYNTAX');
  });

  it('holds the two biconditionals on every program here', () => {
    for (const [src, record] of [
      [JOB, EXAMPLE],
      [JOB, CALIBRATED],
      ['G1 X1 Q1\n', EXAMPLE],
      ['G1 X1 Q1\n', CALIBRATED],
      ['', EXAMPLE],
    ] as const) {
      const r = run(src, record);
      expect(r.estimate.complete).toBe(r.estimate.totalMs !== null);
      expect(r.estimate.calibrated).toBe(r.record.calibration === 'calibrated');
    }
  });

  it('cuts a long message, by code point, so a response stays bounded', () => {
    // Core quotes the number it read: 1,201 digits here.
    const r = run(`G0 X1${' 1'.repeat(1200)}\n`);
    const long = r.diagnostics.items.find((d) => d.message.endsWith('...'));
    expect(long).toBeDefined();
    expect(Array.from(long?.message ?? '').length).toBe(MAX_TEXT);
    // A surrogate pair at the cut stays whole.
    const cut = boundText(`${'a'.repeat(MAX_TEXT - 4)}${'\u{1F600}'.repeat(10)}`);
    expect(Array.from(cut).length).toBe(MAX_TEXT);
    expect(/[\ud800-\udfff]/.test(cut.replace(/\u{1F600}/gu, ''))).toBe(false);
    expect(boundText('short')).toBe('short');
  });

  it('refuses a build that is not 1-128 printable ASCII characters', () => {
    const req = request(JOB);
    for (const b of ['', 'a b', 'b'.repeat(129), 'é']) {
      expect(() => handleEstimate(req, b, TODAY), JSON.stringify(b)).toThrow(/build/);
    }
    expect(handleEstimate(req, 'b'.repeat(128), TODAY).build).toHaveLength(128);
  });

  it('is deterministic: the same request gives the same bytes', () => {
    expect(JSON.stringify(run(JOB))).toBe(JSON.stringify(run(JOB)));
  });

  it('carries no character spans, only lines', () => {
    const r = run('G1 X1 Q\n');
    expect(r.diagnostics.items.length).toBeGreaterThan(0);
    for (const d of r.diagnostics.items)
      expect(Object.keys(d).sort()).toEqual(['code', 'line', 'message', 'severity']);
  });
});

describe('the calibration age (ADR-0048)', () => {
  const at = (today: string, fittedOn = '2026-10-01', record: object = CALIBRATED) =>
    handleEstimate(
      request(JOB, { ...record, calibration: { ...CALIBRATED.calibration, fittedOn } }),
      BUILD,
      today,
    );
  const ageNotes = (r: EstimateResponse) =>
    r.estimate.notes.items.filter((n) => n.startsWith('calibrated on'));

  it(`says nothing up to ${CALIBRATION_MAX_AGE_DAYS} days, and says so the day after`, () => {
    expect(ageNotes(at('2026-10-01'))).toEqual([]);
    // 2026-10-01 + 90 days is 2026-12-30.
    expect(ageNotes(at('2026-12-30'))).toEqual([]);
    expect(ageNotes(at('2026-12-31'))).toEqual([
      'calibrated on 2026-10-01, 91 days ago: past the 90-day limit, recalibrate',
    ]);
    // Across a leap day, counted in calendar days.
    expect(ageNotes(at('2028-05-30', '2028-02-28'))[0]).toContain('92 days ago');
  });

  it('says so when the calibration is dated after today', () => {
    expect(ageNotes(at('2026-09-30'))).toEqual([
      "calibrated on 2026-10-01, after today (2026-09-30): check the record's date",
    ]);
  });

  it("changes nothing else: calibrated stays the record's status, and the times stay", () => {
    const fresh = at('2026-10-26');
    const stale = at('2027-10-26');
    expect(stale.estimate.calibrated).toBe(true);
    expect(stale.record).toEqual(fresh.record);
    expect({ ...stale.estimate, notes: null }).toEqual({ ...fresh.estimate, notes: null });
    // After the estimator's own notes.
    expect(stale.estimate.notes.items.slice(0, -1)).toEqual(fresh.estimate.notes.items);
    expect(stale.estimate.notes.count).toBe(fresh.estimate.notes.count + 1);
  });

  it('notes nothing on an uncalibrated record, however old', () => {
    expect(ageNotes(handleEstimate(request(JOB), BUILD, '2099-01-01'))).toEqual([]);
  });

  it('refuses a day that is not a real date', () => {
    for (const bad of ['', '2026-02-30', '26-10-26', '2026-10-26T00:00:00Z', '2026-1-5']) {
      expect(() => handleEstimate(request(JOB), BUILD, bad), bad).toThrow(/today/);
    }
  });
});
