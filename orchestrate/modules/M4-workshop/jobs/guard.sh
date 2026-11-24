#!/bin/sh
# The locked job's guard (L1352; wiring/runner-locked.mjs lockedCommand builds the one command that runs it, and the one
# allow rule for it). Claude runs one plain command, `/bin/sh <this file> <record> <go-ahead> <waits> <job>`, which a
# settings file can allow exactly; the compound shell line it ran before was refused under dontAsk.
#   $1 the process-group record: this shell's own pid is written into it, as a new file (noclobber, never through a file
#      already there); the runner reads the pid's group and its leader's start time outside the sandbox (readGroupRecord)
#   $2 the runner's go-ahead (ackFile): the job runs only once it is there
#   $3 how many 50 ms waits for it (JOB_ACK_WAIT_MS / 50); none, and the job never runs
#   $4 the job's own shell command, base64: decoded here and run by /bin/sh in this same process (exec), so the group
#      the record names is the job's
[ $# -eq 4 ] || exit 64
( set -C; /bin/echo $$ > "$1" ) || exit 65
n=0
while [ ! -e "$2" ] && [ "$n" -lt "$3" ]; do /bin/sleep 0.05; n=$((n+1)); done
[ -e "$2" ] || exit 66
# --decode: older macOS base64 takes -D or --decode, newer -D, -d or --decode, GNU's (the Linux CI) -d or --decode.
job=$(/bin/echo "$4" | /usr/bin/base64 --decode) && [ -n "$job" ] || exit 67
exec /bin/sh -c "$job"
