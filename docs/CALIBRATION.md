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
- `--target` (default 240 s): about how long each program runs. Long enough that the
  controller's 1 s timer is under 0.5% of it.
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
   the tool can sit below a workpiece top. **Don't tighten a collet nut on an empty
   collet:** with no shank in it, an ER collet can be over-compressed and damaged. Clamp
   a short plain shank (a dowel pin, or a blank with no cutting edge), or remove the
   collet and nut if the spindle's maker allows it to run bare.
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
   cutting tool fitted, and the collet as in step 1: a deformed collet spinning is the
   one real hazard here. Stand clear of the spindle's line. If neither a plain shank nor
   running bare is possible, skip the events program. On its first lap, if the first
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

The fit (5c, in progress) reads the runs file and fits the record's factors (ADR-0041:
`accelFactor`, `timeFactor`, and the junction deviation, which this controller doesn't
publish). It refuses fewer than 5 runs, a set that can't separate the factors, and a fit
that lands on a factor's limit. Its result goes into the machine's record, which is kept
by the application that stores machine records, not here.

A calibration is accepted only against **real production jobs** (at least 5), not the
programs it was fitted on: each within ±5% of its measured time. Those jobs are kept in
the private fixtures repository, each with its source job recorded.

## 5. When to calibrate again

- The controller's settings change (velocities, accelerations, firmware).
- The machine record gets a new revision.
- After 90 days: the calibration is then stale, and estimates say so.

## Results

Only the aggregate is published: the number of jobs checked, the mean and largest error,
and whether every one was within ±5%. Each job's figures and the fitted factors stay
private.

_No calibration has been accepted yet._
