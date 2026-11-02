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
it with `--dry-run`, then put it in place once with `sudo install -o root -g wheel -m 0644 /dev/stdin /Library/orchestrate-setup.json < ~/orchestrate-setup.json` (`install` follows links, so the file goes in through stdin, never as a path) and read it back.

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
| `node setup.mjs check --config <file>` | read only: `PASS`, `FAIL` or `NEEDS ROOT` per item; exit 1 on any FAIL, exit 3 if all that could be seen passed but some items need root. Before setup it lists 44 FAILs of 48 items for one product (about 5 more for each extra product), which is expected | no |
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
`extras` (full paths of the files and folders the runner config names: its claude program and hooks; the wiring and the budget module are the copy's own code, never extras. With the base `/Library/orchestrate` the runner config names the wiring exactly `"wiring": "/Library/orchestrate/install/orchestrate/modules/M4-workshop/launcher/review-wiring.mjs"`; for the budget module use the path of its file under the same `modules/` folder), and
optionally `gitBin` (default `/usr/bin/git`) and `nodeBin` (default and advised: leave it out, so it is the node running the command; a node root may not run, such as a Homebrew one, is refused before any step; a `nodeBin` that is a link, not the program's own real file, is refused too, because the copy is made from the name). Each extra is named by its real file, not by a shortcut: a link, a missing file or a link inside a folder is refused at plan time, with no step run. Root reads the runner config through one handle, never through a link, and only if it is root's own and written by no one else; an error never shows a byte of it.
When root runs `install` for real, the `runnerConfig` file must be root's own, written by no one else, with every folder above it root's too (root takes no orders from a file others could change). A `--dry-run` as you cannot judge that, so it prints a WARNING saying so. To put the file in place: `sudo install -o root -g wheel -m 0644 /dev/stdin /Library/<name>.json < ~/review.json` (use the real path from `runnerConfig`). The file is read once; the copy root installs is the text that was checked.
Every name, path and layout rule comes from the launcher's own modules (`install-check.mjs`, `review-daemons.mjs`,
`review-updater.mjs`); `install.test.mjs` pins the two copies it cannot import (the label rule, the updater's file set).

| Command | What it does | Root? |
|---|---|---|
| `/usr/local/bin/node setup.mjs install --config <file> --dry-run` | prints every step (and every refusal, before any step) | no |
| `sudo /usr/local/bin/node setup.mjs install` | makes the root-owned `install` folder, a root-owned copy of the updater's three files and of node, the seed (`updater.json`, `review.json`, the extras), then runs the updater's `--first` run, which builds the `.v-<commit>` copy and flips the link; then checks | yes |
| `/usr/local/bin/node setup.mjs check-install --config <file> [--main <commit>]` | read only: the link is root's; the copy and every folder above it are root's alone; the commit stamp; **no access list on any install folder**; `review.json` names this copy and what it names exists | no |
| `sudo /usr/local/bin/node setup.mjs daemons place` | writes the three job files into `/Library/LaunchDaemons` (root:wheel 0644, exactly what `review-daemons.mjs` builds) | yes |
| `sudo /usr/local/bin/node setup.mjs daemons load` / `unload` | `launchctl bootstrap` / `bootout` for each job not yet loaded / loaded; load refuses unless the install check passes and the job files are there; a job loaded from an older file is taken out and loaded again (`load` records each file's fingerprint in `<base>/install/loaded-jobs.json`, root's); unload with nothing loaded is not an error | yes |
| `/usr/local/bin/node setup.mjs daemons list` / `check` | read only: `list` shows loaded or not, state and last exit. `check` FAILs on: a job file wrong or missing; a leftover job file under another label; a job not loaded; a job loaded from an older file than the one on disk; a job whose last run did not end with exit 0. It cannot see a job loaded under an old label whose file is gone: `daemons unload` under the old label first. Changing the label, `review.json` or the owner's home folder needs `daemons unload`, the change, `place`, `load` | no |

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
| `sudo /usr/local/bin/node setup.mjs users-folders` | now also makes `<base>/owner-taps` (the owner's, 0755, no access list; runner setting `ownerTaps`) | yes |
| `sudo /usr/local/bin/node setup.mjs users-folders` (same command) | also makes `<base>/watch` (orchestrate's, 0700: the runner's log and rules draft) and `<base>/watch-notes` (the owner's, 0755: the written explanations; only the owner writes, orchestrate and the summary read) (R-0b-122) | yes |
| `sudo /usr/local/bin/node setup.mjs proposals` | makes `proposalsParent` (default `/Users/Shared/orchestrate-proposals`: root's, **0711**) and one folder per product (the owner's, **0700**, one access-list entry for `orchestrate`: list/search/read, inherited). Runs behind the same folder-chain wall as every root command; the folder the parent sits in must be root's and either written by no one else or sticky (as the Mac's own `/Users/Shared` is), and the parent itself root's and not writable by others unless sticky. A file moved in from elsewhere may not be readable by `orchestrate` (it keeps its old owner and mode): copy it in instead. | yes |
| `/usr/local/bin/node setup.mjs check-proposals` | read only: owner, mode, exact access list; with `sudo` also: the owner can write, `orchestrate` reads and cannot write, `review` cannot read | no (sudo for proofs) |
| `sudo /usr/local/bin/node setup.mjs safe-directory` / `check-safe-directory` | runs `git config --global --add safe.directory <base>/mirror` **as the owner** (root never writes into their home). It reads what their git trusts from every settings file it reads (system, global, anything they include), and refuses if any entry has a `*` in it (`*`, `/path/*`): remove the line yourself where it lives. The check FAILs on a `*` even next to the mirror | yes |
| `sudo /usr/local/bin/node setup.mjs daemons reload-account` | if the `review-account` job is loaded: rewrite its file (carries `--install <copy>`), unload, load, record, and read back that it is loaded. Never loaded: nothing to do. If an earlier reload stopped after the unload (not loaded, but this tool had loaded it): it says plainly that nothing is running the job and to run `daemons load`, never "done" | yes |
| `sudo /usr/local/bin/node setup.mjs prove-token` | proves the token is watch-only against the repository the config names (`"watch": { "repo": "owner/name" }`; never typed on the command line). The token file is looked at first without following links (orchestrate's own plain 0600 file), then read **as orchestrate** (`sudo -H -u orchestrate cat`). Then: the repository is private and not archived; listing open pull requests works; a no-op change to an open one is refused with GitHub's "this token may not" answer (a rate limit or any other 403 is not proof). Output has only fixed sentences and numbers, never the token | yes (reads the file as orchestrate) |
| `sudo /usr/local/bin/node setup.mjs token` / `check-token` | types the watch-only token hidden into `<base>/keys/watch-only-token` (orchestrate's, 0600); the check reads owner, mode and size only. The old file name is removed with a plain unlink, then the new file is made exclusively and its owner and mode are set on the same open handle before the token is written (a link or hard link put in the name cannot redirect it) | yes |

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

## Part 4 — the watch-only week's rules copy and hourly job (R-0b-122)

Config: an optional `"watch": { "repo": "<owner/name>", "rulesSha256": "<64 hex>" }` in the root-owned config. Without it,
everything below is off. With only the `repo` (all `prove-token` needs) the three review jobs are exactly as before, no hourly
job is built, and `watch-rules`, `check-watch-rules` and `daemons ... --only watch-only` say "no rulesSha256 yet" and what to do.
The hash is the SHA-256 of the rules draft file (`shasum -a 256 <file>` prints it), written by whoever
edits the root config, so the owner's own Mac user cannot choose the rules the week is judged by.
The fingerprint is of the UTF-8 text of the file, so it is the same as `shasum`'s for any valid UTF-8 file (which a rules file is).

| Command | What it does | Root? |
|---|---|---|
| `node setup.mjs watch-rules --print-config-line --repo <owner/name> --rules-source <full path>` | read only, no root: prints the one config line to add (`"watch": { "repo": …, "rulesSha256": … }`), the fingerprint being that of the rules file named. Works before the config has a `watch` entry. Refuses (prints nothing) if the file is not a full path, cannot be read or is empty | no |
| `sudo /usr/local/bin/node setup.mjs watch-rules --rules-source <full path>` | the rules file is always named (the rules are the product's own policy, so Bob carries no copy of them); a relative path, an unreadable or empty file is refused. Refuses unless the file hashes to the config's `watch.rulesSha256`; writes it as `<base>/watch/rules-draft.yaml` (root's, 0644, in orchestrate's 0700 folder). Keep the file at a plain local path, not in a synced or home folder root cannot read. `--dry-run` shows the step | yes |
| `sudo node setup.mjs check-watch-rules` | read only: the copy is there, root's 0644, no access list, and hashes to the config's value. Without sudo: NEEDS ROOT (exit 3), never PASS | no (sudo to look) |
| `sudo node setup.mjs daemons place` / `load` / `check` | with a `watch` entry there is a fourth job, `<label>.watch-only`: runs as `orchestrate`, from the installed copy, `watch-run.mjs once --rules draft --rules-sha256 <hash>` every hour. `load` refuses until the rules copy is in place. `--only <job>` (also on `unload` and `list`) does that one job only, e.g. `daemons place --only watch-only`; a name that is no job of the config is refused before anything runs | yes |

The runner re-checks the hash on every pass and judges nothing if the file differs. The job's file is built with the
launcher's one plist builder and label rule (`review-daemons.mjs` exports them), so there is one of each.
