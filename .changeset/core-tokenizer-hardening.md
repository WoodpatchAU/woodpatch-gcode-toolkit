---
'@woodpatch/gcode-core': patch
---

The tokenizer never throws and runs in linear time on hostile lines: a 10,000-deep run of
signs or "#" no longer overflows the stack, and lines of many M words or letters are no
longer quadratic. What it reads from ordinary lines is unchanged.
