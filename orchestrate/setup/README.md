# orchestrate/setup — the Mini's one-time setup

Commands for the Mac-level setup that has no other home (runbook Part A). Plain Node, no dependencies. Bob is public, so
nothing here names a product, a person or a machine: those come from a config file.

## Part 1 (R-0b-05): the three Mac users and their folders

`layout.mjs` is the one list of what exists: the users `orchestrate`, `pages` and `review`, and every folder with its
owner and exact mode (v4 §14.1.4). `setup.mjs` makes them and checks them.

Config file (JSON), for example `~/orchestrate-setup.json`:

```json
{ "base": "/Library/orchestrate", "owner": "<your Mac user>", "products": ["<product>"] }
```

`base` is root's and must not sit under `/Users`, `/Applications` or `/tmp` (the review runner refuses a wall in a
folder others can write).

| Command | What it does | Root? |
|---|---|---|
| `node setup.mjs users-folders --config <file> --dry-run` | prints every step it would take; changes nothing | no |
| `sudo node setup.mjs users-folders --config <file>` | makes the three users (hidden, shell `/usr/bin/false`, password `*`, own group, never admin), then the folders (owner, group, exact mode, access list cleared), then runs `check` | yes |
| `node setup.mjs check --config <file>` | read only: `PASS` or `FAIL` per item; exit 1 on any FAIL | no |

- Run it twice and the second run does nothing. A cut-off run is finished by the next one.
- A user or group that exists but is wrong (an admin, a login shell, not hidden, another home) is **refused, not
  changed**: the command lists the problem and changes nothing. A folder under the base that is wrong gets its owner,
  mode and access list put right. A link where a folder belongs is refused.
- It never sets or reads a password.
- Not in this part: the install and the background jobs (part 2, below); the ownerTaps and proposals folders, the
  account job reload and the Keychain token (part 3).

## Part 2: the install and the background jobs

Extra config keys (the same file): `address` (https address of the repository), `label` (starts the jobs' names),
`runnerConfig` (full path of the review runner's prepared `review.json`, whose `installRoot` is `<base>/install/orchestrate`),
`extras` (full paths of the files and folders the runner config names: its wiring, claude program and hooks), and
optionally `gitBin` (default `/usr/bin/git`) and `nodeBin` (default: the node running the command).
Every name, path and layout rule comes from the launcher's own modules (`install-check.mjs`, `review-daemons.mjs`,
`review-updater.mjs`); `install.test.mjs` pins the two copies it cannot import (the label rule, the updater's file set).

| Command | What it does | Root? |
|---|---|---|
| `node setup.mjs install --config <file> --dry-run` | prints every step | no |
| `sudo node setup.mjs install --config <file>` | makes the root-owned `install` folder, a root-owned copy of the updater's three files and of node, the seed (`updater.json`, `review.json`, the extras), then runs the updater's `--first` run, which builds the `.v-<commit>` copy and flips the link; then checks | yes |
| `node setup.mjs check-install --config <file> [--main <commit>]` | read only: the link is root's; the copy and every folder above it are root's alone; the commit stamp; **no access list on any install folder**; `review.json` names this copy and what it names exists | no |
| `sudo node setup.mjs daemons place --config <file>` | writes the three job files into `/Library/LaunchDaemons` (root:wheel 0644, exactly what `review-daemons.mjs` builds) | yes |
| `sudo node setup.mjs daemons load` / `unload` | `launchctl bootstrap` / `bootout` for each job not yet loaded / loaded; load refuses until the install and the job files are there; unload with nothing loaded is not an error | yes |
| `node setup.mjs daemons list` / `check` | read only: loaded or not; the job files are exact and the jobs loaded | no |

Root never runs code a user can write: the updater runs from a root-owned `install-work/bootstrap` copy with a root-owned
copy of node. A plain folder where the copy's link belongs is refused, not replaced.

Tests: `node --test orchestrate/setup/install.test.mjs`. They add a `launchctl` stand-in that refuses what the real one
refuses (no root; a job file with the wrong owner or mode; loading twice; unloading what is not loaded; an unknown job is 113),
run the real updater in a child process against a local folder standing in for GitHub, and run `launchctl print` for real.

### Tests

`node --test orchestrate/setup/setup.test.mjs`. They run against a stand-in Mac (`fake-mac.test-helper.mjs`: a throwaway
root folder prefix, an in-memory `dscl`/`dseditgroup`, owners kept in a table) and never as root. The stand-in refuses what
the real tool refuses (a `dscl` write without root, a bad path, a missing record). The last tests run the real read-only
tools on this Mac (`dscl -read`, `dseditgroup -o checkmember`, `stat`, `ls -led`). Each `PLANT` test breaks one clause and
names the check that catches it.
