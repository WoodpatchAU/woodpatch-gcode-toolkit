#!/bin/sh
# SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
# SPDX-License-Identifier: MIT
#
# The estimate server's tripwire (ADR-0040, ADR-0046). The socket and service units run it
# as root, outside the sandbox, before they start; any failure fails the start, and
# repeated failures leave the socket unit failed and not listening (ADR-0040).
#
#   tripwire service     --group G --gid N --caller U --dir D --cred F --bundle B --build S --node P
#   tripwire socket-pre  --group G --gid N --caller U --dir D
#   tripwire socket-post --group G --gid N --caller U --dir D --socket S --unit NAME
#
# It refuses, with one line on stderr naming the rule, unless:
#   - the group's members are exactly the caller, in /etc/group, /etc/gshadow and NSS;
#   - the group's gshadow password starts with ! or *, and it has no administrators;
#   - no user other than the caller has the gid as its primary group (files, and NSS
#     as far as NSS enumerates: under sssd with enumerate off, only the files are seen);
#   - the gid is the group's alone and resolves to its name, in the files and in NSS;
#   - the gid lies outside sssd's ID ranges (a domain without min_id and max_id counts as
#     overlapping), systemd's DynamicUser range (61184-65519) and homed's (60001-60513);
#   - the directory is root:<group> 0750, the socket (socket-post) root:<group> 0660,
#     and neither has an extended ACL;
#   - socket-post: the socket unit listens on exactly that one path;
#   - service: the log key is a regular file, root:root 0600, at least 32 bytes; the
#     bundle and node are root-owned with no group or other write; the bundle's BUILD
#     is the build the unit was rendered with.
#
# POSIX sh and the base system's tools only. TRIPWIRE_ROOT (tests only) is prefixed to
# the files it reads under /etc.
set -eu

ROOT="${TRIPWIRE_ROOT:-}"

die() {
  printf 'wp-gcode tripwire: %s\n' "$*" >&2
  exit 1
}

mode="${1:-}"
[ $# -gt 0 ] && shift
case "$mode" in
  service | socket-pre | socket-post) ;;
  *) die "usage: tripwire service|socket-pre|socket-post --option value ..." ;;
esac

group='' gid='' caller='' dir='' sock='' unit='' cred='' bundle='' build='' node=''
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "option $1 has no value"
  case "$1" in
    --group) group="$2" ;;
    --gid) gid="$2" ;;
    --caller) caller="$2" ;;
    --dir) dir="$2" ;;
    --socket) sock="$2" ;;
    --unit) unit="$2" ;;
    --cred) cred="$2" ;;
    --bundle) bundle="$2" ;;
    --build) build="$2" ;;
    --node) node="$2" ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done

need() {
  for name in "$@"; do
    eval "value=\${$name}"
    # shellcheck disable=SC2154 # set by the eval above
    [ -n "$value" ] || die "--$name is required for $mode"
  done
}
need group gid caller dir
case "$mode" in
  service) need cred bundle build node ;;
  socket-post) need sock unit ;;
esac

case "$gid" in
  '' | *[!0-9]*) die "--gid must be a number" ;;
esac
case "$group$caller" in
  *[!a-z0-9_-]*) die "--group and --caller must be plain names" ;;
esac

# ── The reserved gid ────────────────────────────────────────────────────────

in_range() { [ "$gid" -ge "$1" ] && [ "$gid" -le "$2" ]; }
in_range 61184 65519 && die "gid $gid is in systemd's DynamicUser range (61184-65519)"
in_range 60001 60513 && die "gid $gid is in systemd-homed's range (60001-60513)"

# sssd: every [domain/...] section must state min_id and max_id, and exclude the gid.
sssd_files=''
[ -f "$ROOT/etc/sssd/sssd.conf" ] && sssd_files="$ROOT/etc/sssd/sssd.conf"
if [ -d "$ROOT/etc/sssd/conf.d" ]; then
  for f in "$ROOT"/etc/sssd/conf.d/*.conf; do
    [ -f "$f" ] && sssd_files="$sssd_files $f"
  done
fi
if [ -n "$sssd_files" ]; then
  # shellcheck disable=SC2086 # a list of paths without spaces
  ranges=$(awk '
    function flush() { if (dom != "") print dom, (min == "" ? "-" : min), (max == "" ? "-" : max) }
    /^[ \t]*\[/ { flush(); dom = ""; min = ""; max = ""
                  if ($0 ~ /^[ \t]*\[domain\//) { dom = $0; gsub(/[ \t\[\]]/, "", dom) } next }
    dom != "" && /^[ \t]*min_id[ \t]*=/ { v = $0; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t]*$/, "", v); min = v }
    dom != "" && /^[ \t]*max_id[ \t]*=/ { v = $0; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t]*$/, "", v); max = v }
    END { flush() }' $sssd_files)
  # A here-document, not a pipe: the loop must run in this shell, so die() exits it.
  while read -r dom min max; do
    [ -n "$dom" ] || continue
    if [ "$min" = - ] || [ "$max" = - ] || [ "$max" = 0 ]; then
      die "sssd $dom has no min_id and max_id: its range is unbounded, so it may cover gid $gid"
    fi
    in_range "$min" "$max" && die "gid $gid is inside sssd $dom's range ($min-$max)"
  done <<RANGES
$ranges
RANGES
fi

# ── The group: files, gshadow, NSS ──────────────────────────────────────────

# The line for a name (field 1) or a gid (field 3) in a group-format file.
line_by_name() { awk -F: -v n="$1" '$1 == n' "$2"; }
lines_by_gid() { awk -F: -v g="$1" '$3 == g' "$2"; }

[ -r "$ROOT/etc/group" ] || die "can't read /etc/group"
files_line=$(line_by_name "$group" "$ROOT/etc/group")
[ -n "$files_line" ] || die "group $group isn't in /etc/group (it must be a local group)"
[ "$(printf '%s\n' "$files_line" | wc -l)" -eq 1 ] || die "group $group is in /etc/group more than once"
files_gid=$(printf '%s' "$files_line" | cut -d: -f3)
files_members=$(printf '%s' "$files_line" | cut -d: -f4)
[ "$files_gid" = "$gid" ] || die "group $group has gid $files_gid in /etc/group, not $gid"
[ "$files_members" = "$caller" ] || die "group $group's members in /etc/group aren't exactly $caller"
[ "$(lines_by_gid "$gid" "$ROOT/etc/group" | wc -l)" -eq 1 ] || die "gid $gid belongs to more than one group in /etc/group"

[ -r "$ROOT/etc/gshadow" ] || die "can't read /etc/gshadow"
shadow_line=$(line_by_name "$group" "$ROOT/etc/gshadow")
[ -n "$shadow_line" ] || die "group $group isn't in /etc/gshadow"
shadow_pw=$(printf '%s' "$shadow_line" | cut -d: -f2)
shadow_admins=$(printf '%s' "$shadow_line" | cut -d: -f3)
shadow_members=$(printf '%s' "$shadow_line" | cut -d: -f4)
case "$shadow_pw" in
  '!'* | '*'*) ;;
  *) die "group $group has a usable password in /etc/gshadow (newgrp would get round the membership rule)" ;;
esac
[ -z "$shadow_admins" ] || die "group $group has administrators in /etc/gshadow (gpasswd would get round the membership rule)"
[ "$shadow_members" = "$caller" ] || die "group $group's members in /etc/gshadow aren't exactly $caller"

# NSS: what the system actually resolves, which a directory group can shadow or extend.
nss_line=$(getent group "$group" || true)
[ -n "$nss_line" ] || die "NSS doesn't resolve group $group"
[ "$nss_line" = "$files_line" ] || die "NSS's group $group differs from /etc/group (a directory group may shadow or extend it)"
nss_by_gid=$(getent group "$gid" || true)
[ "$(printf '%s' "$nss_by_gid" | cut -d: -f1)" = "$group" ] || die "NSS resolves gid $gid to another group than $group"

# No other user may have the gid as its primary group.
[ -r "$ROOT/etc/passwd" ] || die "can't read /etc/passwd"
others=$( {
  cat "$ROOT/etc/passwd"
  # As far as NSS enumerates: under sssd with enumerate off, directory users aren't
  # listed, and only the files (above) are seen for them.
  getent passwd || true
} | awk -F: -v g="$gid" -v c="$caller" '$4 == g && $1 != c { print $1 }' | sort -u)
[ -z "$others" ] || die "another user has gid $gid as its primary group: $(printf '%s' "$others" | tr '\n' ' ')"

# ── Paths ───────────────────────────────────────────────────────────────────

# "uid gid mode size type", without following a symlink. The type is last: it can be
# several words ("regular file", "symbolic link").
meta() { stat -c '%u %g %a %s %F' -- "$1" 2>/dev/null || die "can't stat $1"; }

# The last three digits of a mode (so 4755 reads as 755).
perms() { printf '%s' "${1#"${1%???}"}"; }

no_acl() {
  acl=$(getfacl -c --skip-base -- "$1" 2>/dev/null) || die "can't read $1's ACL"
  [ -z "$acl" ] || die "$1 has an extended ACL (the mode bits wouldn't be the whole story)"
}

expect() { # path uid gid mode type
  path=$1 uid=$2 gid_=$3 mode_=$4 type=$5
  # shellcheck disable=SC2046 # split the metadata into its fields
  set -- $(meta "$path")
  [ "$1:$2" = "$uid:$gid_" ] || die "$path must be owned by $uid:$gid_ (it is $1:$2)"
  [ "$3" = "$mode_" ] || die "$path must have mode $mode_ (it has $3)"
  shift 4
  [ "$*" = "$type" ] || die "$path must be a $type (it is a $*)"
}

expect "$dir" 0 "$gid" 750 directory
no_acl "$dir"

if [ "$mode" = socket-post ]; then
  expect "$sock" 0 "$gid" 660 socket
  no_acl "$sock"
  listen=$(systemctl show -P Listen -- "$unit") || die "can't read $unit's listeners"
  [ "$listen" = "$sock (Stream)" ] || die "$unit must listen on exactly $sock, and nothing else"
fi

if [ "$mode" = service ]; then
  # The log key, which LoadCredential= hands the service.
  # shellcheck disable=SC2046 # split the metadata into its fields
  set -- $(meta "$cred")
  [ "$1:$2" = 0:0 ] || die "the log key must be owned by root:root"
  [ "$3" = 600 ] || die "the log key must have mode 0600"
  size=$4
  shift 4
  [ "$*" = "regular file" ] || die "the log key must be a regular file (not a link, not empty)"
  [ "$size" -ge 32 ] || die "the log key must be at least 32 bytes"

  # What the service runs: nothing it runs as may write its own code.
  root_only() { # path: refuse unless root-owned with no group or other write
    # shellcheck disable=SC2046 # split the metadata into its fields
    set -- "$1" $(meta "$1")
    [ "$2" = 0 ] || die "$1 must be owned by root"
    m=$(perms "$4")
    case "$m" in
      ?[2367]? | ??[2367]) die "$1 must not be writable by its group or others" ;;
    esac
  }
  root_only "$node"
  files=$(find "$bundle") || die "can't list the bundle"
  while IFS= read -r f; do
    root_only "$f"
  done <<FILES
$files
FILES
  [ -f "$bundle/BUILD" ] || die "the bundle has no BUILD file"
  [ "$(cat "$bundle/BUILD")" = "$build" ] || die "the bundle's BUILD isn't the build the units were rendered for"
fi

exit 0
