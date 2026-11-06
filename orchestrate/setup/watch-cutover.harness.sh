#!/bin/bash
# The behaviour harness for watch-cutover.sh (from the #261 r1 audit). It runs the real script's control flow against a
# stand-in /Library/orchestrate in a folder it is given, with stand-ins for node, the updater, launchctl, id and sleep.
# No root, and no real system file is read or written. watch-cutover.test.mjs runs it; it prints one "ok"/"FAIL" line per
# check and ends "harness: N ok, M FAIL", exiting 0 only when M is 0.
# usage: watch-cutover.harness.sh <path to watch-cutover.sh> [an empty folder to work in; a new temp folder if none]
SRC="$1"; ROOT=$(cd "${2:-$(mktemp -d "${TMPDIR:-/tmp}/wch.XXXXXX")}" && pwd -P) || exit 2
KN="watch-app.$(printf 'p%sm' e)"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }

# The stand-ins the harness copy of the script reads in, just after its PATH line.
fakes() {
  cat > "$1" <<'EOF'
id() { echo "${FAKE_UID:-0}"; }
sleep() { :; }
# A pass reports "running" for FAKE_RUNS prints after its kickstart (3 by default), writes its out line on the last of
# them, and only then reports "not running" with FAKE_EXIT. Before any kickstart, the earlier pass ended with exit 0.
launchctl() {
  echo "LC $*" >> "$CTL/calls"
  local n
  case "$1" in
    print)
      n=$(cat "$CTL/left" 2>/dev/null || echo -1)
      if [ "$n" -gt 0 ]; then
        echo $((n - 1)) > "$CTL/left"
        if [ "$n" = 1 ]; then [ -n "${FAKE_SILENT:-}" ] || echo "judged 1 new commit(s); 0 already in the log." >> "$OUT_LOG"; [ -n "${FAKE_ERR:-}" ] && echo "$FAKE_ERR" >> "$ERR_LOG"; fi
        printf '\tstate = running\n\tlast exit code = 0\n'
      elif [ "$n" = 0 ]; then printf '\tstate = not running\n\tlast exit code = %s\n' "${FAKE_EXIT:-0}"
      else printf '\tstate = not running\n\tlast exit code = 0\n'; fi ;;
    kickstart) echo "${FAKE_RUNS:-3}" > "$CTL/left" ;;
  esac
  return 0
}
EOF
}

setup_world() {   # $1 = the scenario's folder
  local T="$1"; mkdir -p "$T/L/install" "$T/L/keys" "$T/L/watch" "$T/L/logs" "$T/root" "$T/ctl"
  printf 'rules: draft\n' > "$T/L/watch/rules-draft.yaml"
  H=$(shasum -a 256 "$T/L/watch/rules-draft.yaml" | cut -d' ' -f1)
  : > "$T/L/keys/$KN"; : > "$T/ctl/calls"; fakes "$T/ctl/fakes.sh"
  # The harness copy: the host's paths and pin swapped for the stand-in's, and the stand-ins read in.
  BASE="$T/L" ROOTTMP="$T/root/" PINV="$H" perl -pe '
    s{^BASE=/Library/orchestrate$}{BASE=$ENV{BASE}};
    s{/private/var/root/}{$ENV{ROOTTMP}}g;
    s{^PIN=.*}{PIN=$ENV{PINV}};
    $_ .= ". \"\$CTL/fakes.sh\"\n" if m{^export PATH=/usr/bin:/bin:/usr/sbin:/sbin$};
  ' "$SRC" > "$T/harness-cutover.sh"
  mkv "$T" old 0
  ln -s orchestrate.v-old/orchestrate "$T/L/install/orchestrate"
}
# A version folder with a stand-in node. The updater moves the link to v-new (made like v-old, with the harness copy of
# the script unless ctl/no_script, changed if ctl/differ) and exits with ctl/upd_rc. A setup call whose arguments match
# the pattern in ctl/fail fails; one matching ctl/flip_after moves the link to v-later afterwards (the updater job
# running mid-way).
mkv() {   # $1 T, $2 version, $3 with the script (1/0)
  local T="$1" d="$1/L/install/orchestrate.v-$2/orchestrate"
  mkdir -p "$d/bin" "$d/setup" "$d/modules/M4-workshop/launcher"
  : > "$d/setup/setup.mjs"; : > "$d/modules/M4-workshop/launcher/review-updater.mjs"; : > "$d/updater.json"
  cat > "$d/bin/node" <<EOF
#!/bin/bash
T="$T"; CTL="\$T/ctl"; I="\$T/L/install"
echo "NODE \$*" >> "\$CTL/calls"
case "\$1" in
  *review-updater.mjs)
    rc=\$(cat "\$CTL/upd_rc" 2>/dev/null || echo 0)
    if [ "\$rc" = 0 ] && [ ! -e "\$I/orchestrate.v-new" ]; then
      d="\$I/orchestrate.v-new/orchestrate"; mkdir -p "\$d/bin" "\$d/setup" "\$d/modules/M4-workshop/launcher"
      cp "\$I/orchestrate.v-old/orchestrate/bin/node" "\$d/bin/node"; : > "\$d/setup/setup.mjs"; : > "\$d/modules/M4-workshop/launcher/review-updater.mjs"; : > "\$d/updater.json"
      [ -f "\$CTL/no_script" ] || cp "\$T/harness-cutover.sh" "\$d/setup/watch-cutover.sh"
      [ -f "\$CTL/differ" ] && echo "# changed on main" >> "\$d/setup/watch-cutover.sh"
      ln -sfn orchestrate.v-new/orchestrate "\$I/orchestrate"
    fi
    [ -f "\$CTL/rewrite" ] && printf 'echo HIJACKED; exit 9\n' > "\$(cat "\$CTL/rewrite")"
    exit "\$rc";;
esac
shift
key="\$*"
if [ -f "\$CTL/fail" ] && [[ "\$key" == \$(cat "\$CTL/fail") ]]; then echo "FAIL  planted"; exit 1; fi
if [ -f "\$CTL/flip_after" ] && [[ "\$key" == \$(cat "\$CTL/flip_after") ]]; then
  cp -R "\$I/orchestrate.v-new" "\$I/orchestrate.v-later"; ln -sfn orchestrate.v-later/orchestrate "\$I/orchestrate"
fi
echo "fake ok: \$key"; exit 0
EOF
  chmod 755 "$d/bin/node"
  [ "$3" = 1 ] && cp "$T/harness-cutover.sh" "$d/setup/watch-cutover.sh"
  return 0
}
run() { local T="$1"; shift; ( cd "$T" && env CTL="$T/ctl" "$@" ) > "$T/out" 2>&1; echo $? > "$T/rc"; }
outer() { local T="$1"; shift; mkdir -p "$T/outside"; cp "$T/harness-cutover.sh" "$T/outside/w.sh"; run "$T" "$@" /bin/bash "$T/outside/w.sh"; }
has() { grep -q -- "$2" "$1/out"; }
rc() { cat "$1/rc"; }
nodecalls() { grep -c '^NODE' "$1/ctl/calls"; }
setupcalls() { grep -c '^NODE .*setup\.mjs' "$1/ctl/calls"; }
lastnode() { grep '^NODE' "$1/ctl/calls" | tail -1 | sed -E 's#^NODE [^ ]*/(review-updater\.mjs|setup\.mjs) ?##'; }
stops() {   # $1 T, $2 the step, $3 the start of its reason: exit 1, exactly one STOPPED line, that one, and no ALL DONE
  [ "$(rc "$1")" = 1 ] && [ "$(grep -c '^STOPPED at step' "$1/out")" = 1 ] && grep -qF -- "STOPPED at step $2: ${3:-}" "$1/out" && ! has "$1" "ALL DONE"
}
n=0; next() { n=$((n + 1)); T="$ROOT/w$n"; setup_world "$T"; }
WA="watch-app --app-id 5635934 --app-installation 179103836 --app-key-name $KN --rules-sha256"

echo "S1 the happy path, from outside the copy"
next; outer "$T"
[ "$(rc "$T")" = 0 ] && has "$T" "^ALL DONE" && ok "exit 0 and ALL DONE" || bad "rc $(rc "$T"): $(tail -3 "$T/out")"
seq=$(grep '^NODE' "$T/ctl/calls" | sed -E 's#^NODE [^ ]*/(review-updater\.mjs|setup\.mjs) ?##' | sed -E 's#rules-source [^ ]*/rules\.yaml#rules-source TMP#' | tr '\n' '|')
want="$T/L/install/orchestrate/updater.json|$WA $H --dry-run|$WA $H|watch-rules --rules-source TMP --dry-run|watch-rules --rules-source TMP|check-watch-rules|daemons place --only watch-only --dry-run|daemons place --only watch-only|daemons load --only watch-only --dry-run|daemons load --only watch-only|check-watch-rules|check-install|daemons check --only watch-only|"
[ "$seq" = "$want" ] && ok "the updater, then every setup call in order, each step's dry run before it" || bad "order: $seq"
[ "$(grep -c '^NODE .*orchestrate\.v-new/orchestrate/setup/setup\.mjs' "$T/ctl/calls")" = 12 ] && ok "every setup call runs from the new copy, by its real folder" || bad "setup calls: $(grep '^NODE' "$T/ctl/calls" | cut -c1-120)"
[ "$(grep -c '^LC kickstart' "$T/ctl/calls")" = 1 ] && ok "one pass started" || bad "kickstarts: $(grep -c '^LC kickstart' "$T/ctl/calls")"
[ "$(grep -c '^LC print' "$T/ctl/calls")" -ge 5 ] && ok "it waited while the pass was running" || bad "prints: $(grep -c '^LC print' "$T/ctl/calls")"
has "$T" "orchestrate.v-new" && ok "the copy moved to main" || bad "the copy did not move"
[ -z "$(ls "$T/root")" ] && ok "root's temp folder is cleaned up" || bad "left behind: $(ls "$T/root")"

echo "S2 --after-b from a file outside the copy refuses"
next; mkdir -p "$T/outside"; cp "$T/harness-cutover.sh" "$T/outside/w.sh"; run "$T" /bin/bash "$T/outside/w.sh" --after-b
stops "$T" a "--after-b runs only from the current installed copy" && ok "refused" || bad "rc $(rc "$T"): $(cat "$T/out")"
[ "$(nodecalls "$T")" = 0 ] && ok "no node call" || bad "node ran"

echo "S3 the updater fails"
next; echo 1 > "$T/ctl/upd_rc"; outer "$T"
stops "$T" b "the updater failed (exit 1)" && ok "stops at b" || bad "$(tail -3 "$T/out")"
[ "$(nodecalls "$T")" = 1 ] && ok "nothing after it" || bad "more calls"

echo "S4 main has no script"
next; : > "$T/ctl/no_script"; outer "$T"
stops "$T" b "the copy has no setup/watch-cutover.sh" && ok "stops at b" || bad "$(tail -3 "$T/out")"
[ "$(setupcalls "$T")" = 0 ] && ok "no setup call" || bad "setup ran"

echo "S5 main's copy of the script is not the file that was run"
next; : > "$T/ctl/differ"; outer "$T"
stops "$T" b "main's copy of this script is not the file you ran" && ok "stops at b" || bad "$(tail -3 "$T/out")"
[ "$(setupcalls "$T")" = 0 ] && ok "no setup call" || bad "setup ran"

for f in "$WA HASH --dry-run:a" "$WA HASH:a" "watch-rules --rules-source *--dry-run:a2" "watch-rules --rules-source *rules.yaml:a2" \
         "check-watch-rules:a2-check" "daemons place --only watch-only --dry-run:c-place" "daemons place --only watch-only:c-place" \
         "daemons load --only watch-only --dry-run:c-load" "daemons load --only watch-only:c-load" "check-install:d-install" "daemons check --only watch-only:d-job"; do
  cmd="${f%:*}"; st="${f##*:}"
  next; cmd="${cmd//HASH/$H}"; printf '%s' "$cmd" > "$T/ctl/fail"; outer "$T"
  echo "S6 a planted failure at $st ($cmd)"
  stops "$T" "$st" && ok "stops at $st with one plain line" || bad "rc $(rc "$T"): $(grep STOPPED "$T/out")"
  # shellcheck disable=SC2053   # the planted text is a pattern
  [[ "$(lastnode "$T")" == $cmd ]] && ok "no setup call after it" || bad "a call after it: $(lastnode "$T")"
  [ "$(grep -c '^LC kickstart' "$T/ctl/calls")" = 0 ] && ok "no pass started" || bad "a pass started"
done

echo "S7 the rules copy is not at the pin"
next; echo changed >> "$T/L/watch/rules-draft.yaml"; outer "$T"
stops "$T" a2 "the rules copy in place hashes to" && ok "stops at a2" || bad "$(grep STOPPED "$T/out")"
[ "$(lastnode "$T")" = "$WA $H" ] && ok "nothing after step a" || bad "a call after: $(lastnode "$T")"

echo "S8 not root"
next; outer "$T" FAKE_UID=501
stops "$T" start "it must run as root" && ok "refused" || bad "$(cat "$T/out")"
[ "$(nodecalls "$T")" = 0 ] && ok "no node call" || bad "node ran"

echo "S9 the key file is missing"
next; rm -f "$T"/L/keys/*; outer "$T"
stops "$T" a "the App's key file" && ok "stops at a" || bad "$(grep STOPPED "$T/out")"
[ "$(setupcalls "$T")" = 0 ] && ok "no setup call" || bad "setup ran"

echo "S10 run as the installed copy's own file (a second run), no arguments"
next; rm -rf "$T/L/install/orchestrate.v-old"; mkv "$T" old 1
run "$T" /bin/bash "$T/L/install/orchestrate/setup/watch-cutover.sh"
[ "$(rc "$T")" = 0 ] && grep -q "review-updater" "$T/ctl/calls" && has "$T" "^ALL DONE" && ok "runs b, then a to d" || bad "rc $(rc "$T") $(tail -2 "$T/out")"

echo "S10b run as the installed copy's own file, when main's copy of the script has changed"
next; rm -rf "$T/L/install/orchestrate.v-old"; mkv "$T" old 1; : > "$T/ctl/differ"
run "$T" /bin/bash "$T/L/install/orchestrate/setup/watch-cutover.sh"
stops "$T" b "main's copy of this script is not the file you ran" && ok "stops at b: the file started from is compared, not the link's new file" || bad "rc $(rc "$T"): $(tail -2 "$T/out")"
[ "$(setupcalls "$T")" = 0 ] && ok "no setup call" || bad "setup ran"

echo "S11 an HTTP 403 in the pass's new error lines"
for e in "HTTP 403 Forbidden for /repos/o/r/check-runs" "GitHub answered 403 for /repos/o/r/pulls/7" "GitHub refused the token request (403)"; do
  next; outer "$T" FAKE_ERR="$e"
  stops "$T" pass "the pass met a 403" && ok "stops on: $e" || bad "$e: $(tail -3 "$T/out")"
done

echo "S12 a 403 inside a commit, a number or a time is not an HTTP 403"
next; outer "$T" FAKE_ERR="note: commit 9f403ab1 took 1403 ms in pull 4031"
[ "$(rc "$T")" = 0 ] && has "$T" "^ALL DONE" && ok "carries on to ALL DONE" || bad "$(tail -3 "$T/out")"

echo "S13 the pass ends with an exit other than 0"
next; outer "$T" FAKE_EXIT=78
stops "$T" pass "the pass did not finish with exit 0" && ok "stops on exit 78" || bad "$(tail -3 "$T/out")"

echo "S14 the pass is still running after 3 minutes (the earlier pass had ended with 0)"
next; outer "$T" FAKE_RUNS=999
stops "$T" pass "the pass is still going after 3 minutes" && ok "says it is still going, not ALL DONE" || bad "$(tail -3 "$T/out")"

echo "S14b the pass ends with exit 0 but wrote nothing to its out log"
next; outer "$T" FAKE_SILENT=1
stops "$T" pass "the job wrote no new line" && ok "says the pass may not have run, not ALL DONE" || bad "$(tail -3 "$T/out")"

echo "S15 --after-b from an older version folder that is not the current copy"
next; mkv "$T" stale 1
run "$T" /bin/bash "$T/L/install/orchestrate.v-stale/orchestrate/setup/watch-cutover.sh" --after-b
stops "$T" a "--after-b runs only from the current installed copy" && ok "refused" || bad "rc $(rc "$T"): $(grep STOPPED "$T/out")"
[ "$(nodecalls "$T")" = 0 ] && ok "no node call" || bad "node ran"

echo "S16 the updater job moves the link between steps a and c"
next; printf '%s' "$WA $H" > "$T/ctl/flip_after"; outer "$T"
[ "$(rc "$T")" = 0 ] && ok "runs through" || bad "rc $(rc "$T"): $(tail -3 "$T/out")"
[ "$(grep -c '^NODE .*orchestrate\.v-later' "$T/ctl/calls")" = 0 ] && [ "$(readlink "$T/L/install/orchestrate")" = orchestrate.v-later/orchestrate ] \
  && ok "every step after the move still runs the copy it began with" || bad "a step ran the moved copy: $(grep -c 'v-later' "$T/ctl/calls")"

echo "S17 the base is reached through a link"
next; ln -s "$T/L" "$T/Llink"; perl -pi -e "s{^BASE=\\Q$T/L\\E\$}{BASE=$T/Llink}" "$T/harness-cutover.sh"
rm -rf "$T/L/install/orchestrate.v-old"; mkv "$T" old 0; outer "$T"
[ "$(rc "$T")" = 0 ] && ok "runs through" || bad "rc $(rc "$T"): $(grep STOPPED "$T/out")"

echo "S18 the file it was started from changes while it runs (a synced folder)"
next; mkdir -p "$T/outside"; cp "$T/harness-cutover.sh" "$T/outside/w.sh"; printf '%s' "$T/outside/w.sh" > "$T/ctl/rewrite"
run "$T" /bin/bash "$T/outside/w.sh"
has "$T" HIJACKED && bad "a change made mid-run was run" || ok "a change made mid-run is not run (rc $(rc "$T"))"

echo
echo "harness: $pass ok, $fail FAIL"
[ "$fail" = 0 ]
