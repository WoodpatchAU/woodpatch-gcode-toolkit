// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Renders the estimate server's systemd files from a host's values file (ADR-0046):
//
//   node render.mjs --values host.json --bundle <bundle dir> --out <dir> [--force]
//
// The values file is the host's, and stays private: user and group names, the reserved
// gid, paths. This public repository holds only the templates. Every value is checked
// against a strict pattern, every placeholder must be filled, and nothing is written
// outside --out or over an existing file without --force. The build string comes from the
// bundle's own BUILD file, so the units always name the bundle they were rendered for.

import { existsSync, readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = {
  'wp-gcode.socket': 'systemd/wp-gcode.socket.in',
  'wp-gcode.service': 'systemd/wp-gcode.service.in',
  'wp-gcode-tmpfiles.conf': 'systemd/wp-gcode-tmpfiles.conf.in',
};

const NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
/** Absolute, normalised, no trailing slash, and only characters that need no quoting in a unit file. */
const PATH = /^\/[A-Za-z0-9._/-]*$/;
/** ADR-0044's build pattern, and no characters a unit file would read specially. */
const BUILD = /^[A-Za-z0-9._+-]{1,128}$/;

/** Each field: its check, and its default (undefined: required). */
const FIELDS = {
  group: { check: (v) => typeof v === 'string' && NAME.test(v) },
  gid: {
    check: (v) =>
      Number.isSafeInteger(v) &&
      v >= 1 &&
      v < 4294967295 &&
      !(v >= 61184 && v <= 65519) && // systemd's DynamicUser range
      !(v >= 60001 && v <= 60513), // systemd-homed's
  },
  callerUser: { check: (v) => typeof v === 'string' && NAME.test(v) },
  prefix: { check: isPath },
  credFile: { check: isPath },
  node: { check: isPath },
  /** The calling application's code, config and data: the service can't see them. */
  inaccessible: { check: (v) => Array.isArray(v) && v.length > 0 && v.every(isPath) },
  workers: { check: (v) => Number.isInteger(v) && v >= 1 && v <= 16, default: 2 },
  heapMb: { check: (v) => Number.isInteger(v) && v >= 64 && v <= 16384, default: 1536 },
  youngMb: { check: (v) => Number.isInteger(v) && v >= 8 && v <= 1024, default: 64 },
  mainMb: { check: (v) => Number.isInteger(v) && v >= 128 && v <= 8192, default: 512 },
  cpuQuotaPercent: { check: (v) => Number.isInteger(v) && v >= 10 && v <= 1600, default: 200 },
  tasksMax: { check: (v) => Number.isInteger(v) && v >= 32 && v <= 4096, default: 256 },
};

function isPath(v) {
  return (
    typeof v === 'string' &&
    PATH.test(v) &&
    posix.normalize(v) === v &&
    !v.split('/').includes('..') &&
    // normalize() keeps a trailing slash; a file or directory here is named without one.
    !v.endsWith('/')
  );
}

export class RenderError extends Error {}

/** The values, checked, with defaults applied. Throws RenderError naming the field. */
export function readValues(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RenderError('the values file must hold one JSON object');
  }
  for (const k of Object.keys(raw)) {
    if (!Object.hasOwn(FIELDS, k)) throw new RenderError(`unknown field "${k}" in the values file`);
  }
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const v = Object.hasOwn(raw, k) ? raw[k] : f.default;
    if (v === undefined) throw new RenderError(`the values file needs "${k}"`);
    if (!f.check(v)) throw new RenderError(`"${k}" in the values file isn't valid`);
    out[k] = v;
  }
  return out;
}

/** Every placeholder and its text, from checked values and the bundle's build. */
export function placeholders(v, build) {
  if (!BUILD.test(build)) throw new RenderError("the bundle's BUILD isn't a valid build string");
  return {
    GROUP: v.group,
    GID: String(v.gid),
    CALLER_USER: v.callerUser,
    PREFIX: v.prefix,
    CRED_FILE: v.credFile,
    NODE: v.node,
    INACCESSIBLE: v.inaccessible.join(' '),
    WORKERS: String(v.workers),
    BUILD: build,
    MEMORY_MAX_MB: String((v.workers + 1) * (v.heapMb + v.youngMb) + v.mainMb),
    CPU_QUOTA: String(v.cpuQuotaPercent),
    TASKS_MAX: String(v.tasksMax),
  };
}

/** One template, filled. Any placeholder it names that isn't known, or isn't filled, fails. */
export function fill(template, map) {
  return template.replace(/@([A-Z_]+)@/g, (whole, name) => {
    if (!Object.hasOwn(map, name))
      throw new RenderError(`the template has an unknown placeholder ${whole}`);
    return map[name];
  });
}

/** Renders every file into `out`. Returns the paths written. */
export function render({ values, bundle, out, force = false }) {
  const v = readValues(values);
  const build = readFileSync(join(bundle, 'BUILD'), 'utf8').trim();
  const map = placeholders(v, build);
  const dir = realpathSync(out);
  const written = [];
  for (const [name, template] of Object.entries(TEMPLATES)) {
    const target = resolve(dir, name);
    // Fixed names, but checked anyway: nothing is ever written outside --out.
    if (!target.startsWith(dir + sep)) throw new RenderError(`${name} would land outside --out`);
    if (existsSync(target) && !force)
      throw new RenderError(`${target} exists (pass --force to replace it)`);
    const text = fill(readFileSync(join(HERE, template), 'utf8'), map);
    if (/@[A-Z_]+@/.test(text)) throw new RenderError(`${name} still has a placeholder`);
    writeFileSync(target, text, { mode: 0o644 });
    chmodSync(target, 0o644);
    written.push(target);
  }
  return written;
}

// The command line.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const valuesPath = opt('--values');
    const bundle = opt('--bundle');
    const out = opt('--out');
    if (!valuesPath || !bundle || !out) {
      throw new RenderError(
        'usage: render.mjs --values <host.json> --bundle <dir> --out <dir> [--force]',
      );
    }
    const values = JSON.parse(readFileSync(valuesPath, 'utf8'));
    for (const f of render({ values, bundle, out, force: args.includes('--force') })) {
      process.stdout.write(`wrote ${f}\n`);
    }
  } catch (e) {
    process.stderr.write(
      `render: ${e instanceof RenderError || e instanceof SyntaxError ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }
}
