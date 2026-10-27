<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# Calibrating the time estimator

How a machine's estimates are brought within ±5% of its real job times (plan §4.3,
ADR-0043, ADR-0047). The estimator models the machine from its record (ADR-0041); what a
controller doesn't publish, such as its cornering, is fitted here from timed runs.

This repository holds the **procedure and the tools**, never a machine's numbers. A
machine's record, the programs generated from it, its measured times and its fitted
factors all stay private.

## 1. Generate the programs

On a machine that holds the record (private):

```bash
node tools/calibration/programs.mjs --record <record.json> --out <new private dir> --envelope-x <mm> --envelope-y <mm>
```

- `--envelope-x`, `--envelope-y`: the XY area the programs may use, from the work origin
  you'll set. It must fit the machine's travel and be clear of everything.
- `--clearance` (default 5 mm): how far below the top of Z travel the programs work.
- `--plunge` (default 30 mm): how far below that the plunge program goes.
- `--target` (default 240 s, at least 120 s): about how long each program runs. Long
  enough that the controller's 1 s timer is under 0.5% of it. Shorter programs can't
  separate accelFactor from the junction deviation, so the fit would refuse them, and the
  generator refuses a target under 120 s before anything is timed.
- `--events`: also write the events program, which **starts the spindle**. It's off by
  default; write it only if the operator wants it run.

`--out` must be outside this repository. Nothing is written unless every program passes
the generator's safety checks, read back through the interpreter:

| program           | what it isolates                                               |
| ----------------- | -------------------------------------------------------------- |
| `cal-01-rapids`   | rapid rate and acceleration                                    |
| `cal-02-feeds`    | feed moves at three feeds: acceleration and velocity           |
| `cal-03-corners`  | cornering (junction deviation): squares, and 30-150° zigzags   |
| `cal-04-arcs`     | full circles at three radii                                    |
| `cal-05-polyline` | dense short segments (1 mm, 0.25 mm): the planner, block rate  |
| `cal-06-plunge`   | Z alone, in machine coordinates, at three Z feeds and at rapid |
| `cal-07-events`   | spindle start and stop, and dwells (only with `--events`)      |

**What makes them safe to run:**

- Every Z move is in **machine coordinates** (G53), at the clearance below the top of Z
  travel. Where Z goes never depends on the work offset. Only the plunge program moves
  Z, and only within `--plunge` of that height. A Z word outside a G53 line is refused.
- XY moves stay inside the envelope, from the work origin, and the travel check finds
  nothing. No program changes an offset, homes, or moves incrementally.
- No feed exceeds the record's maximum velocity for the axes it moves.
- The spindle stays off, and there's no tool change. The events program is the only
  exception, and it's opt-in.
- Each program starts with these rules as comments, and ends `M5` then `M30`.

The generator also writes `calibration-runs.json`: one entry per program, with the
program's SHA-256, for the measured times.

## 2. Before you press start

None of this replaces the operator's judgement at the machine. If anything looks wrong,
stop.

1. **Remove the tool.** Retracted is not clear: on some machines, even at the top of Z
   the tool can sit below a workpiece top. **The collet:** don't clamp an empty ER
   collet: tightening it with no shank in it can over-compress and damage it, and a
   deformed collet spinning is the one real hazard here. Either clamp a
   short plain shank (a dowel pin or a blank with no cutting edges, inside the collet's
   range), or remove the collet and nut entirely if the spindle's maker allows it to run
   bare. Check the spindle manual on running unloaded. If neither is possible, skip the
   events program.
2. **Clear the bed and the workholding** from the whole envelope, and from the gantry's
   path at the top of Z.
3. **Home the machine first.** Check the readout: machine Z 0 at the top, negative
   downwards.
4. **Then set the work origin** (G54 X0 Y0) at the envelope's corner, so the whole
   envelope is inside the machine's travel. An origin set before homing moves with the
   homing. The work Z doesn't matter: Z only moves in machine coordinates. **Soft limits
   on.**
5. **Check the safe height in MDI:** `G53 G0 Z<safe>` (the header gives it) shows that
   machine Z, and the active tool length offset doesn't move it.
6. **Before the plunge program,** jog over its start point (the envelope's centre) to its
   lowest machine Z, and check the spindle nose clears the bed.
7. **Check each program's preview and extents** on the controller before starting it.
8. **Spindle off.** Only the events program (`--events`) starts it. It runs with no
   cutting tool fitted, and the collet as in step 1. Stand clear of the spindle's line.
   On its first lap, if the first
   dwell after M3 hasn't ended within about 10 s of the spindle reaching speed, feed
   hold and stop: the controller reads G4's P in another unit than the record's dialect
   says, and the dwell could run for half an hour.
9. **A hand on the E-stop** (or feed hold) for every run.
10. **First pass: the feed AND rapid overrides low,** or single-block through the first
    lines. A feed override alone leaves every G0 at full speed. Watch the first moves:
    up to the safe height, then across to the start point. Stop if anything looks
    wrong.
11. **Timed run at 100% feed and 100% rapid.** If it isn't, record the overrides used:
    they change the time.

## 3. Time each run

Read the time from the **controller's job timer**, from cycle start to program end.
Record it in `calibration-runs.json`:

- `measuredSeconds`: the timer's reading;
- `method`: `controller-timer`, or `stopwatch` if timed by hand;
- `overrides`: the feed and rapid percentages used;
- `date`, and `notes`: anything unusual (a pause, a restart, an alarm).

Don't mix methods within a set without a note: a stopwatch adds about a second of
reaction at each end.

## 4. Fit, and check

```bash
node tools/calibration/fit.mjs --record <record.json> --runs <calibration-runs.json> --programs <the programs' dir> --out <new private dir>
```

The fit (ADR-0049) reads the runs and fits the record's factors: `timeFactor`,
`accelFactor`, and the junction deviation, which some controllers don't publish. It uses
the motion programs timed at 100% feed and rapid. It writes `fit.json` and `fit.txt`,
and refuses, saying why, when:

- there are fewer than 5 timed runs, or no program is timed twice;
- the runs can't tell two factors apart;
- a factor lands on the edge of its range;
- a factor rests on one run. Time that program again: on most machines it's the corners
  program, for the junction deviation;
- the fit hangs on any one run.

A factor it can only roughly place (a standard error over 25%) is a warning, not a
refusal, and is marked undetermined: acceptance keeps the record's value for it unless
the production jobs show it matters. When the runs scatter more than the repeats
explain, it widens its standard errors to match, and says so.

It also reports what it doesn't fit, for you to set in the record as measured: whether
the overrides touch the programs they shouldn't, which rapid model fits the rapids, and
the spindle's implied start and stop times.

A fit is not a calibration. A calibration is accepted only against **real production
jobs** (at least 5), not the programs it was fitted on: each within ±5% of its measured
time. Those jobs are kept in the private fixtures repository, each with its source job
recorded.

```bash
node tools/calibration/accept.mjs --record <record.json> --fit <fit.json> --runs <calibration-runs.json> --programs <the programs' dir> --jobs <timings.json> --jobs-root <dir> --out <new private dir>
```

The acceptance check (ADR-0050) estimates each job with the fitted factors, and writes a
**candidate** calibrated record only if every job is within ±5%. The storing
application adopts the candidate through its own flow. It refuses, saying why, when:

- there are fewer than 5 distinct jobs, or a job is one of the calibration programs,
  even saved again;
- a job is outside ±5%, or its repeat timings disagree by more than 5%;
- a value is still a seed (`"source": "seed"`). Measure it, and enter it as
  `"measured"`: time a tool change, for example;
- the fit couldn't place the junction deviation and it matters for these jobs (some job
  moves more than 1% across its uncertainty). Time the corners program again.

If the junction deviation couldn't be placed and doesn't matter for these jobs, the
record's value can be kept by a named person:
`--keep junctionDeviation --operator <name> --decided-on <YYYY-MM-DD>`. It's then
recorded as `"manual"`, never as fitted.

## 5. When to calibrate again

- The controller's settings change (velocities, accelerations, firmware).
- The machine record gets a new revision.
- After 90 days: the calibration is then stale, and estimates say so.

## Results

Only the aggregate is published: the number of jobs checked, the mean and largest error,
and whether every one was within ±5%. Each job's figures and the fitted factors stay
private.

_No calibration has been accepted yet._
