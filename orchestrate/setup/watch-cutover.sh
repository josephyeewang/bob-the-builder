#!/bin/bash
# The watch job's cutover to the watcher App, as root, in one paste (L630, L633, L643): `sudo bash <this file>`.
#
# In order, each step shown as a dry run first, then run; it stops at the first FAIL with one plain line:
#   b   the updater, once, moves the installed copy to main (the same command and setting the updater job uses)
#   a   watch-app: name the watcher App and the rules pin in root's config
#   a2  watch-rules: the rules copy in place (checked against the pin first) put back as root's 0644 copy
#   c   daemons place, then load, for the watch job only
#   d   check-watch-rules, check-install, daemons check --only watch-only
# then it starts one watch pass and shows the end of the job's logs, with a count of "403" lines.
#
# Steps a to d run from the copy step b installed: run from anywhere else (the first run comes from outside, since the
# copy before step b has no such script), this file runs step b only, then hands over to the copy's own file. Root never
# runs setup code from a folder anyone else can write. Safe to run again: a step already done says it has nothing to do.
# It never reads or prints the key or the token: it only checks the key file is there.
# The whole script is one { } block, so bash has read all of it before the first step: a copy of this file that changes
# while it runs (a synced folder) changes nothing. After step b it reads no file outside /Library/orchestrate.
{
set -u
umask 022
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

# The host's values (the lead's L627-L633 rulings): change them here, nowhere else.
APP_ID=5635934
APP_INSTALLATION=179103836
KEY_NAME="watch-app.pem"
PIN=120df76033dc3852c6d5353719834e14ae6842eeb48c12487dff72c95c3a591a

BASE=/Library/orchestrate
COPY="$BASE/install/orchestrate"
NODE="$COPY/bin/node"
SETUP="$COPY/setup/setup.mjs"
UPDATER="$COPY/modules/M4-workshop/launcher/review-updater.mjs"
RULES="$BASE/watch/rules-draft.yaml"
LABEL=com.orchestrate.watch-only
OUT_LOG="$BASE/logs/watch-only.out.log"
ERR_LOG="$BASE/logs/watch-only.err.log"
JUDGED="$BASE/watch/log.jsonl"

stop() { echo; echo "STOPPED at step $1: $2"; echo "Nothing after this step was run. Fix that, then paste the same line again."; exit 1; }
say() { echo; echo "==== $*"; }
# Anything a step prints passes through here, so a token-shaped word could never reach the screen.
hide() { sed -E 's/gh[opsuar]_[A-Za-z0-9_]{20,}/<token hidden>/g; s/-----BEGIN[^-]*-----/<key hidden>/g'; }
# One setup command: its dry run, then the real run. Either failing stops the script.
step() {
  local name="$1"; shift
  say "$name: dry run"
  "$NODE" "$SETUP" "$@" --dry-run 2>&1 | hide; local r=${PIPESTATUS[0]}
  [ "$r" = 0 ] || stop "$name" "its dry run failed (exit $r): see the lines above"
  say "$name"
  "$NODE" "$SETUP" "$@" 2>&1 | hide; r=${PIPESTATUS[0]}
  [ "$r" = 0 ] || stop "$name" "it failed (exit $r): see the lines above"
}
# A read-only check (no dry run: it changes nothing).
check() {
  local name="$1"; shift
  say "$name"
  "$NODE" "$SETUP" "$@" 2>&1 | hide; local r=${PIPESTATUS[0]}
  [ "$r" = 0 ] || stop "$name" "a check FAILED: see the FAIL lines above"
}

[ "$(id -u)" = 0 ] || stop start "it must run as root: sudo bash $0"
[ -L "$COPY" ] || stop start "$COPY is not the installed copy's link; the install is not there"
HERE="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
case "$HERE" in "$BASE"/install/*) IN_COPY=1 ;; *) IN_COPY=0 ;; esac

if [ "${1:-}" != "--after-b" ]; then
  say "b: dry run"
  echo "would run, as the updater job does: $UPDATER $COPY/updater.json"
  echo "the copy is now at: $(readlink "$COPY")"
  say "b: the updater, once"
  (cd / && env -i PATH="$PATH" "$NODE" "$UPDATER" "$COPY/updater.json") 2>&1 | hide; r=${PIPESTATUS[0]}
  [ "$r" = 0 ] || stop b "the updater failed (exit $r): see its lines above; the copy was not moved"
  echo "the copy is at: $(readlink "$COPY")"
  NEW="$COPY/setup/watch-cutover.sh"
  [ -f "$NEW" ] || stop b "the copy has no setup/watch-cutover.sh, so main does not have the watcher change yet"
  # Steps a to d go on from the copy's own file: root's, not this one.
  exec /bin/bash "$NEW" --after-b
fi
[ "$IN_COPY" = 1 ] || stop a "--after-b runs only from the installed copy's own file"

[ -f "$BASE/keys/$KEY_NAME" ] || stop a "the App's key file $BASE/keys/$KEY_NAME is not there"
step a watch-app --app-id "$APP_ID" --app-installation "$APP_INSTALLATION" --app-key-name "$KEY_NAME" --rules-sha256 "$PIN"

# a2: the source is the rules copy in place, taken into a folder only root can open, after its fingerprint is checked.
[ -f "$RULES" ] && [ ! -L "$RULES" ] || stop a2 "$RULES is not a plain file"
GOT=$(shasum -a 256 "$RULES" | cut -d' ' -f1)
[ "$GOT" = "$PIN" ] || stop a2 "the rules copy in place hashes to ${GOT:0:8}…, not the pin ${PIN:0:8}…"
TMP=$(mktemp -d /private/var/root/watch-cutover.XXXXXX) || stop a2 "could not make a folder for root's copy of the rules"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"; cp "$RULES" "$TMP/rules.yaml"; chmod 600 "$TMP/rules.yaml"
[ "$(shasum -a 256 "$TMP/rules.yaml" | cut -d' ' -f1)" = "$PIN" ] || stop a2 "the rules changed while being copied"
step a2 watch-rules --rules-source "$TMP/rules.yaml"
check a2-check check-watch-rules

step c-place daemons place --only watch-only
step c-load daemons load --only watch-only

check d-rules check-watch-rules
check d-install check-install
check d-job daemons check --only watch-only

say "one watch pass"
before=0; [ -f "$JUDGED" ] && before=$(wc -l < "$JUDGED")
outBefore=0; [ -f "$OUT_LOG" ] && outBefore=$(wc -l < "$OUT_LOG")
errBefore=0; [ -f "$ERR_LOG" ] && errBefore=$(wc -l < "$ERR_LOG")
launchctl print "system/$LABEL" >/dev/null 2>&1 || stop pass "$LABEL is not loaded"
if launchctl kickstart "system/$LABEL" >/dev/null 2>&1; then echo "started; waiting up to 3 minutes for it to finish..."
else echo "a pass is already running; waiting up to 3 minutes for it to finish..."; fi
for _ in $(seq 1 36); do
  sleep 5
  now=0; [ -f "$OUT_LOG" ] && now=$(wc -l < "$OUT_LOG")
  running=$(launchctl print "system/$LABEL" 2>/dev/null | awk -F'= ' '/^\tstate = /{print $2; exit}')
  [ "$now" -gt "$outBefore" ] && [ "$running" != "running" ] && break
done
code=$(launchctl print "system/$LABEL" 2>/dev/null | awk -F'= ' '/last exit code = /{print $2; exit}')
echo "the job's last exit code: ${code:-unknown}"
echo "-- new lines of $OUT_LOG:"; [ -f "$OUT_LOG" ] && tail -n +"$((outBefore + 1))" "$OUT_LOG" | tail -5 | hide
echo "-- new lines of $ERR_LOG:"; [ -f "$ERR_LOG" ] && tail -n +"$((errBefore + 1))" "$ERR_LOG" | tail -10 | hide
n403=0; [ -f "$ERR_LOG" ] && n403=$(tail -n +"$((errBefore + 1))" "$ERR_LOG" | grep -c "403")
echo "-- the last judgements ($JUDGED):"; [ -f "$JUDGED" ] && tail -3 "$JUDGED" | cut -c1-240 | hide
after=0; [ -f "$JUDGED" ] && after=$(wc -l < "$JUDGED")
echo
echo "new judgements this pass: $((after - before)); lines with 403 in the new error log lines: $n403"
[ "$n403" = 0 ] || stop pass "the pass met a 403: see the error log lines above"
[ "${code:-x}" = 0 ] || stop pass "the pass did not finish with exit 0 within 3 minutes (exit ${code:-unknown})"
echo "ALL DONE: steps b, a, a2, c and d passed, and the watch pass finished with no 403."
exit 0
}
