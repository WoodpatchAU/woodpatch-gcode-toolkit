<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# Security policy

## Reporting a vulnerability

Please report it privately, through GitHub: on this repository's **Security** tab,
choose **Report a vulnerability**. Don't open a public issue or pull request for it.

Say what's affected (a package and version, or a commit), how to reproduce it, and what
an attacker could do with it. We'll acknowledge the report, keep you posted while we fix
it, and credit you when it's published unless you'd rather not be named.

## What's in scope

The packages in this repository (`@woodpatch/gcode-*`) and the playground. They read
G-code that may come from anyone, so the parser, interpreter and transforms are meant to
handle hostile input without crashing, hanging or using unbounded memory. A file that
makes them do so is a vulnerability worth reporting.

The upstream code under [`legacy/`](legacy/) is kept for reference only. It isn't built
or shipped, so it's out of scope.

## Supported versions

Nothing is released yet. Until the first release, fixes go to `main` only.
