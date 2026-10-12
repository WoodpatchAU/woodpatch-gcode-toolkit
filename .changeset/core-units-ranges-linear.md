---
'@woodpatch/gcode-core': patch
---

Units conversion checks Masso M66 skip ranges in near-linear time whatever their shape
(many short ranges, ranges to the end of the file, long ranges with comments), and reads
an M66's S from its text: S1.9999999999999999 and a bare S are refused.
