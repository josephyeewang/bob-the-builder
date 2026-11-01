# orchestrate/setup — the always-on Mac's one-time setup

Commands for the Mac-level setup that has no other home (runbook Part A). Plain Node, no dependencies. Bob is public, so
nothing here names a product, a person or a machine: those come from a config file.

## Part 1 (R-0b-05): the three Mac users and their folders

`layout.mjs` is the one list of what exists: the users `orchestrate`, `pages` and `review`, and every folder with its
owner and exact mode (v4 §14.1.4). `setup.mjs` makes them and checks them.

### The config: root reads only its own file

Root takes its orders from **one file at a fixed place, `/Library/orchestrate-setup.json`, and only if it is root's own**:
opened without following a link, a plain file, owned by root, written by no one else, in folders only root writes.
Anything else is refused before a single step (a file in your home folder, which your own user can change between your
read-back and the run, is never read by root; `--config` is refused under `sudo`). You write a copy in your home, look at
it with `--dry-run`, then put it in place once with `sudo install -o root -g wheel -m 0644` and read it back.

```json
{ "base": "/Library/orchestrate", "owner": "<your Mac user>", "products": ["<product>"] }
```

`base` is root's and must not sit under `/Users`, `/Applications`, `/tmp`, `/Volumes`, `/opt` or `/usr/local`, in any letter
case (the review runner refuses a wall in a folder others can write).

A config that does not parse is reported as "not valid JSON": the file's own text is never shown.

| Command | What it does | Root? |
|---|---|---|
| `node setup.mjs users-folders --config <file> --dry-run` | prints every step it would take; changes nothing (`--config` names your editable copy; there is no `--config` under `sudo`) | no |
| `sudo /usr/local/bin/node setup.mjs users-folders` | makes the three users (ids 600-699, all different; hidden, shell `/usr/bin/false`, password `*`, own group with no members, never admin), then the folders (owner, group, exact mode, exact access list), then runs `check` | yes |
| `node setup.mjs check --config <file>` | read only: `PASS`, `FAIL` or `NEEDS ROOT` per item; exit 1 on any FAIL, exit 3 if all that could be seen passed but some items need root. Before setup it lists 42 FAILs of 46 items for one product (about 5 more for each extra product), which is expected | no |
| `sudo /usr/local/bin/node setup.mjs check` | the same with nothing hidden: the sudo-rule and password-hash items can be read | yes |
| `sudo /usr/local/bin/node setup.mjs proofs` | runs, as the owner's user, the "cannot" proofs: the record, hooks, settings, launcher, lead-main and claude-code copies, the outbox folders cannot be written and the robot keys cannot be read (two controls first) | yes |

- Run it twice and the second run does nothing. A run cut off at any step is finished by the next one: it writes only
  the attributes that are missing and deletes nothing. The safe settings of a user (no shell, hidden, no password) are
  written before its number, so a cut-off user is never a usable account.
- **A base folder this setup did not make is never taken over.** Right after root makes the base it writes a root-owned
  note in it (`.made-by-setup`). A base that already exists without that note (made by someone else, with anything in it)
  is refused with nothing changed, and so is any folder under the base owned by someone other than root or the user it is
  for. If a run is cut off in the instant between making the base and writing the note, delete the empty base folder and run again.
  `check` also FAILs on any entry in a folder only root writes that the setup did not make.
- A user or group that exists but is wrong (an admin, a login shell, not hidden, another home, a password, an id outside
  600-699, root's id, an id another account uses, or a group with members) is **refused, not changed**: the command lists
  the problem and changes nothing. A folder under the base that is wrong (and root's or the right user's) gets its owner,
  group, mode and access list put right.
- **Root never follows a link.** Before any step, every folder above the base is checked to be root's alone (no link, not
  writable by others, no access list); the same check is the first step of the run, so a change between the plan and the
  run stops it before anything is done. Each folder is then changed through an open handle (a link, or a folder swapped
  since the plan, is refused), all folders are made first, and children are handed over before their parents. A folder
  whose children belong to different users (`products/<product>`) is root's, so none of them can rename another's away.
- **One outbox root.** `outboxes/` is root's 0755; under it `reviewer/` and `auditor/` belong to `review` (0755) and each
  worker role has a folder owned by the workers' user, group wheel, 0750, with one access-list entry letting `orchestrate`
  list, read and clear (`delete_child`), with inheritance. The worker seals its own hand-in file 0440. `check` compares the
  access list and the group exactly: a missing or an extra entry FAILs.
- Root runs only a node program that is root's alone with every folder above it (the nodejs.org install in
  `/usr/local/bin`; a Homebrew node is refused). The real guard is the absolute path of that program and its owner: the
  program checks itself, and refuses under `sudo` for every command (`check` included). `--root-prefix` is for tests and
  is refused when running as root.
- It never sets or reads a password. An unknown argument is never printed back (it could be a secret).
- Not in this part: the install and the background jobs (part 2, below); the ownerTaps and proposals folders, the account job
  reload and the watch-only token file (part 3).

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
| `sudo node setup.mjs install` | makes the root-owned `install` folder, a root-owned copy of the updater's three files and of node, the seed (`updater.json`, `review.json`, the extras), then runs the updater's `--first` run, which builds the `.v-<commit>` copy and flips the link; then checks | yes |
| `node setup.mjs check-install --config <file> [--main <commit>]` | read only: the link is root's; the copy and every folder above it are root's alone; the commit stamp; **no access list on any install folder**; `review.json` names this copy and what it names exists | no |
| `sudo node setup.mjs daemons place` | writes the three job files into `/Library/LaunchDaemons` (root:wheel 0644, exactly what `review-daemons.mjs` builds) | yes |
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
the real tool refuses (a `dscl` write without root, a bad path, a missing record, the password hash for anyone but root).
The last tests run the real read-only tools on this Mac (`dscl -read`, `dseditgroup -o checkmember`, `stat`, `ls -led`).
Each `PLANT` test breaks one clause and names the check that catches it.

## Part 3 — taps, proposals, git trust, the account job reload, the watch-only token

| Command | What it does | Root? |
|---|---|---|
| `sudo node setup.mjs users-folders` | now also makes `<base>/owner-taps` (the owner's, 0755, no access list; runner setting `ownerTaps`) | yes |
| `sudo /usr/local/bin/node setup.mjs proposals` | makes `proposalsParent` (default `/Users/Shared/orchestrate-proposals`: root's, **0711**) and one folder per product (the owner's, **0700**, one access-list entry for `orchestrate`: list/search/read, inherited) | yes |
| `node setup.mjs check-proposals` | read only: owner, mode, exact access list; with `sudo` also: the owner can write, `orchestrate` reads and cannot write, `review` cannot read | no (sudo for proofs) |
| `sudo node setup.mjs safe-directory` / `check-safe-directory` | runs `git config --global --add safe.directory <base>/mirror` **as the owner** (root never writes into their home); refuses if they trust `*` | yes |
| `sudo node setup.mjs daemons reload-account` | if the `review-account` job is loaded: rewrite its file (carries `--install <copy>`), unload, load. Not loaded: nothing to do | yes |
| `sudo /usr/local/bin/node setup.mjs prove-token --repo <owner/name>` | proves the token's reach on GitHub: listing open pull requests works, a no-op change to an open one is refused (403). Output never shows the token | yes (reads the file) |
| `sudo node setup.mjs token` / `check-token` | types the watch-only token hidden into `<base>/keys/watch-only-token` (orchestrate's, 0600); the check reads owner, mode and size only | yes |

Why the proposals parent is 0711 root's and the folders use an access list, not a group: the owner's own group (`staff`) holds
every ordinary user of the Mac. The parent sits in a folder everyone can write into, so the base wall cannot be used; instead
root makes it itself, refuses one that already exists and is not root's, and a first step re-checks it. Open for the lead:
the proposals deny rule (R-0b-128 item 4) and the read-back's "block in rendered settings" wait for that row.

### Where the watch-only token lives (proposal, the lead decides)
The three users never log in, so none has a login Keychain. (Lead-approved: a file.) Options: (a) **a file in `keys/`** — orchestrate's 0600 file in
its own 0700 folder; the job reads it directly and passes it to GitHub as a header, never as an argument. (b) a file Keychain
for orchestrate — needs an unlock password, which would have to sit in another file next to it: same protection, more
moving parts, and `security add-generic-password -w <value>` would show the token in the process list. (c) the owner's
Keychain — the owner's AI sessions (workers) could reach it: refused. **Recommended: (a).** Built as (a).
The token text is never printed, logged, put in a step's text or an error, or given to a program as an argument; the
tests assert that over the output, the step list, the Mac's call log and every program call.

Checked on macOS 27.0.1 (these notes expire with an OS upgrade): `dscl . -read` of a missing key prints `No such key` on
stderr with exit 0; opening a link with `O_NOFOLLOW|O_DIRECTORY` gives `ENOTDIR` (Linux: `ELOOP`).
