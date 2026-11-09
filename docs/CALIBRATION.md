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
  you'll set. It must fit the machine's travel and be clear of everything. Each side is
  at least 220 mm (`MIN_ENVELOPE`: a 10 mm margin, the 200 mm hop, the margin again).
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
   envelope is inside the machine's travel. The header names the machine-coordinate range
   G54 X0 Y0 may take for that: the travel check reads the program with a zero work
   offset, so only the operator can check the real one. The range is computed from the
   envelope, so it holds only while no program leaves [0, envelope] on X or Y, rapids
   and arc bulges included; `extent.test.mjs` checks that for both sets. An origin set before homing moves with the
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
application adopts the candidate through its own flow. It fits again from the record,
the runs and the programs (about half a minute), and refuses a `fit.json` that isn't
what that fit makes: don't edit it. It refuses, saying why, when:

- there are fewer than 5 distinct jobs. The same program under two names counts once,
  even re-exported: time it under one name, and enter repeats as more timings of it;
- a job is one of the calibration programs, even saved again or re-posted by CAM;
- a job was timed before the calibration runs: time it again;
- a job is outside ±5%, or its repeat timings disagree by more than 5%;
- a value is still a seed (`"source": "seed"`). Measure it, and enter it as
  `"measured"`: time a tool change, for example;
- the fit couldn't place the junction deviation and it matters for these jobs (some job
  moves more than 1% across its uncertainty). Time the corners program again.

If the junction deviation couldn't be placed and doesn't matter for these jobs, the
record's value can be kept by a named person:
`--keep junctionDeviation --operator <name> --decided-on <YYYY-MM-DD>`. It's then
recorded as `"manual"`, never as fitted.

## 4a. The planes programs: arcs and lines in XY, ZX and YZ

A second set, for what the first can't see: how the arc model (ADR-0052) holds out of the
XY plane, and how fast Z really accelerates when it moves together with X or Y
(ADR-0053).

```bash
node tools/calibration/programs-planes.mjs --record <record.json> --out <new private dir> --envelope-x <mm> --envelope-y <mm>
```

The options are the same as in §1. It writes eleven programs, `cal-v-01` to `cal-v-11`,
about four minutes each:

| plane    | arcs     | the same paths as lines, 0.01 mm | the same, 0.002 mm (the densest) | steep lines |
| -------- | -------- | -------------------------------- | -------------------------------- | ----------- |
| XY (G17) | cal-v-01 | cal-v-02                         | cal-v-03                         |             |
| ZX (G18) | cal-v-04 | cal-v-05                         | cal-v-06                         | cal-v-07    |
| YZ (G19) | cal-v-08 | cal-v-09                         | cal-v-10                         | cal-v-11    |

- The arcs are quarters (level to vertical, the shape of a roundover), semicircles and
  full circles, at radii of 3 mm, 7 mm and up to 14 mm, and at half and all of the
  slowest axis's speed. Every plane uses the same shapes and feeds, so the planes compare.
- The line programs are the same paths as short straight moves, as CAM writes them. No
  move asks for more blocks per second than cal-05 has already run without slowing.
- **These programs move Z together with X or Y**, which the first set never does. They
  only work on a controller that reads G10 as Masso does; the tool refuses any other.

**Before each one**, as well as §2:

1. The programs **set work offset G54.1 P100**, overwriting it every run.
2. They move through the whole envelope from the safe height down to `--plunge` below it.
   Clear that whole slab of clamps and stock, not just the surface.
3. At the start, each program sets the offset and stops at an **M0**, with nothing moved.
   Check the readouts: the WORK position must show **X0 Y0 Z0**, and the MACHINE Z the
   safe height. If any differs, stop the program: the controller set the offset wrongly.
4. If you stop a program part-way, the machine may be left in G54.1 P100 and in G18 or
   G19. Run `G17 G54` before any other job (the next calibration program does it too).

**Time each one by stopwatch**, from pressing cycle start after the M0 to the end of the
program. The M0's wait is yours, and the estimate counts it as nothing. The runs file
asks for the stopwatch method, so the whole set is timed one way.

## 5. When to calibrate again

- The controller's settings change (velocities, accelerations, firmware).
- The machine record's values change (a machine edit). Its `revision` is the schema's,
  not the content's: the content hash is what changes.
- After 90 days: the calibration is then stale, and estimates say so.

## Results

Only the aggregate is published: the number of jobs checked, the mean and largest error,
and whether every one was within ±5%. Each job's figures and the fitted factors stay
private.

_No calibration has been accepted yet._

## Generator versions

Every program's header carries `Generator v<N>`, and every runs file its `generator`.
`GENERATOR_VERSION` is bumped whenever the written bytes change, and
`tools/calibration/generator-version.test.mjs` enforces it both ways: changed output with
the same version fails, and a bump with unchanged output fails. Keep the programs that
were actually run beside their measured times; a new version means a new session, never
regenerated bytes in an old one.

- v1: up to the bump (ba6e2dc). Programs stamped v1 before the G54 fixes exist too, so
  for v1 the session's toolkit commit is what identifies the bytes.
- v2: the header names the range for G54's X0 Y0, the planes set carries the stamp, and
  envelopes under 220 mm are refused up front.
