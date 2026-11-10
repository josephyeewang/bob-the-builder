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
| `node setup.mjs check --config <file>` | read only: `PASS`, `FAIL` or `NEEDS ROOT` per item; exit 1 on any FAIL, exit 3 if all that could be seen passed but some items need root. Before setup it lists 51 FAILs of 55 items for one product (about 9 more for each extra product: its copies and outbox folders, L836), which is expected | no |
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
- **One outbox root.** `outboxes/` is root's 0755; under it one folder for each role the review runner starts
  (`reviewer/`, `auditor/` and `plan_reviewer/`, `RUNNER_ROLES`) belongs to `review` (0755), so no worker can write their
  answers (L722). An earlier setup built from the plan-reviewer branch alone made `plan_reviewer/` the workers' user's; `users-folders` refuses to take that over, so look inside it, remove it by hand, then run `users-folders` again. Each worker role has a folder owned by the workers' user, group wheel, 0750, with one access-list entry letting `orchestrate`
  list, read and clear (`delete_child`), with inheritance. The worker seals its own hand-in file 0440. `check` compares the
  access list and the group exactly: a missing or an extra entry FAILs.
- Root runs only a node program that is root's alone with every folder above it (the nodejs.org install in
  `/usr/local/bin`; a Homebrew node is refused). The real guard is the absolute path of that program and its owner: the
  program checks itself, and refuses under `sudo` for every command (`check` included). `--root-prefix` is for tests and
  is refused when running as root.
- **The workers' copies (L747, L751).** `worker-copies/` is the owner's 0755, group wheel, with one access-list entry letting
  `orchestrate` list, read and delete (`list`, `search`, the read-attribute rights and `delete_child`, inherited by every
  file and folder made under it), so cleanup can check a card's copy and remove it. It can't add or write anything. The
  entry has no `read` (a folder shows it as `list`, so the exact check would never pass; a file made under it shows `read`)
  and no `delete` (with it, `orchestrate` could remove the empty copies folder itself). The entry reaches only what is made
  after it is set: copies that were already there need it added by hand. Cleanup's git runs only on the mirror
  (orchestrate's own), never inside a copy, so no `safe.directory` is needed for it.
- **The seal folder.** `seals/` is orchestrate's 0700: where cleanup seals a copy's bundle it could not prove saved (the
  Dispatcher config's `sealRoot`).
- It never sets or reads a password. An unknown argument is never printed back (it could be a secret).
- Not in this part: the install and the background jobs (part 2, below); the ownerTaps and proposals folders, the account job
  reload and the watch-only token file (part 3).

## Part 2: the install and the background jobs

Extra config keys (the same file): `address` (https address of the repository), `label` (starts the jobs' names),
`runnerConfig` (full path of the review runner's prepared `review.json`, whose `installRoot` is `<base>/install/orchestrate`,
and whose `"uids"` names the Mac user id of every role: `reviewer`, `auditor` and `plan_reviewer` all name `review`'s id
(`dscl . -read /Users/review UniqueID` prints it), every other role the owner's, and none root. `install` refuses, and `check-install` FAILs,
a map that leaves a role out (L726), names root, gives a runner role an id another role also names, or names a key no role is called; without `plan_reviewer` the runner refuses every plan review. Both say "couldn't read the review user" rather than pass when `review` can't be read (run `users-folders` first). **An install made before the plan reviewer** (L737 M1): its copy's `review.json` has no `plan_reviewer`, and re-running `install` does not change it (the copy is kept, and every update carries its `review.json` forward). `check-install` gives a WARNING for that, not a FAIL, so the jobs still load. To put it right: add `"plan_reviewer": <review's id>` to the `uids` of your checked `review.json` (the one `runnerConfig` names), then `sudo install -o root -g wheel -m 0644 <that file> /Library/orchestrate/install/orchestrate/review.json` (with your base), then `check-install` again. Once add-to-install lands (#243) that is the step instead, and the WARNING becomes a FAIL),
`extras` (full paths of anything else the runner config names in the copy, often none: its claude program and hooks are put in by `add-to-install`, not carried as extras, and the `--for-install` file names neither; the wiring and the budget module are the copy's own code, never extras. With the base `/Library/orchestrate` the runner config names the wiring exactly `"wiring": "/Library/orchestrate/install/orchestrate/modules/M4-workshop/launcher/review-wiring.mjs"`; for the budget module use the path of its file under the same `modules/` folder), and
optionally `gitBin` (default `/usr/bin/git`) and `nodeBin` (default and advised: leave it out, so it is the node running the command; a node root may not run, such as a Homebrew one, is refused before any step; a `nodeBin` that is a link, not the program's own real file, is refused too, because the copy is made from the name). Each extra is named by its real file, not by a shortcut: a link, a missing file or a link inside a folder is refused at plan time, with no step run. Root reads the runner config through one handle, never through a link, and only if it is root's own and written by no one else; an error never shows a byte of it.
When root runs `install` for real, the `runnerConfig` file must be root's own, written by no one else, with every folder above it root's too (root takes no orders from a file others could change). A `--dry-run` reads the file with root's own rules and prints a WARNING, with the reason, only when root would refuse it (a dry run that prints no warning means root will take it). To put the file in place: keep your copy of `review.json` in a folder only you can open, run `sudo install -o root -g wheel -m 0644 /dev/stdin /Library/<name>.json < ~/review.json`, and set `runnerConfig` to that `/Library` path. The file is read once; the copy root installs is the text that was checked.
Every name, path and layout rule comes from the launcher's own modules (`install-check.mjs`, `review-daemons.mjs`,
`review-updater.mjs`); `install.test.mjs` pins the two copies it cannot import (the label rule, the updater's file set).

**The order, for the review runner's file (L731):** (1) `review-config --for-install`, then put the file in place as `runnerConfig`; (2) `install`, then `check-install`; (3) `review-config` again without `--for-install`, put that file in place; (4) `add-to-install`; (5) `daemons place` and `load`. Jobs loaded before step 4 show FAIL in `daemons check` (the runner refuses its file until `claudeBin` is there).

| Command | What it does | Root? |
|---|---|---|
| `/usr/local/bin/node setup.mjs review-config --pin <x.y.z> --input <file> --out <file> [--for-install]` (`--dry-run` first) | builds the review runner's `review.json` rather than having it typed (L709). Each field has one source (`review-config.mjs` `SOURCES`): the folders, the copy's paths and the Mac users' ids come from the setup config and the Mac; the pin and the program's place in the copy from `--pin`; only three come from your `--input` file, each required, with no default: `product` (whose Record the runner reads), `machineWide` (the machine-wide Claude Code settings file; on a Mac usually `/Library/Application Support/ClaudeCode/managed-settings.json`) and `rules` (`production.env_files`, `production.programs`, `production.hosts`, `secrets.paths`; an empty list says none). The input may hold nothing else. A pin other than the one the role tool lists were checked on (M10 `TOOLS_CHECKED`) is refused, the dry run included. The file is read back with the runner's own `readConfig` before it replaces `--out`; if it refuses, nothing is written and an earlier file at `--out` is kept. `budget` and `bobManifest` are left out until something makes them. Put it in place as root's own: `sudo install -o root -g wheel -m 0644 /dev/stdin <runnerConfig> < <the file>`. **Two forms, in this order:** with `--for-install` for a first `install` (it leaves out `claudeBin` and `hooksDir`, which a first install can't carry; the runner refuses reviews until the next step), then without it for `add-to-install`, which puts the pinned Claude Code and the hooks where the file names them | no (refused under sudo) |
| `/usr/local/bin/node setup.mjs install --config <file> --dry-run` | prints every step (and every refusal, before any step) | no |
| `sudo /usr/local/bin/node setup.mjs install` | makes the root-owned `install` folder, a root-owned copy of the updater's three files and of node, the seed (`updater.json`, `review.json`, the extras), then runs the updater's `--first` run, which builds the `.v-<commit>` copy and flips the link; then checks | yes |
| `sudo /usr/local/bin/node setup.mjs add-to-install --pin <x.y.z> --sha256 <hex>` (`--dry-run` first) | puts the pinned Claude Code and the hooks into the copy that is installed now, in place, and replaces its `review.json` with the prepared `runnerConfig`. The program comes from `<base>/claude-code/<pin>/claude` and must match the fingerprint. Take `--sha256` from the checksum the official release publishes (or from the one download you checked yourself), never from the file already in that folder: the orchestrate account can write there, so its own fingerprint proves only that it didn't change after you read it. The hooks come from the copy's own modules; `claude-code` and `hooks` join `keep`. No update, no flip, no job touched, every other file unchanged. Safe to run again: a second run finishes a cut-off one. `keep` carries the hooks across an update as they are, so an update that changes a hook makes review launches refuse by name until this runs again | yes |
| `/usr/local/bin/node setup.mjs check-install --config <file> [--main <commit>]` | read only: the link is root's; the copy and every folder above it are root's alone; the commit stamp; **no access list on any install folder**; `review.json` names this copy and what it names exists. Once the config names `hostLockPath`, a last line points to `check-dispatcher` | no |
| `/usr/local/bin/node setup.mjs check-dispatcher --config <file>`, or with sudo | read only: the Dispatcher's lines (below). Its own command, so a host.lock problem never stops `daemons load --only <job>` for another job, or the watch cutover, which wait on check-install | no; sudo for the host.lock read |
| `/usr/local/bin/node setup.mjs dispatcher-keys --config <file>` | read only: prints the Dispatcher config's seven worker and cleanup keys as JSON, from this config: `reviewRoot` (`<base>/review`), `mirror` (`<base>/mirror`), `sealRoot` (`<base>/seals`), `outboxRoot` (`<base>/outboxes`, the top folder), `copiesRoot` (`<base>/worker-copies`, the top folder), `hostLockPath`, and `hostLockUid` (the owner's Mac user id, read on this Mac: the Dispatcher reads host.lock only when the file it opened is that user's). Without `hostLockPath`, or with no such owner on this Mac, it says so and exits 1 | no |
| `sudo /usr/local/bin/node setup.mjs daemons place` | writes the config's job files (three, and the watch, robot and Dispatcher jobs when it has them) into `/Library/LaunchDaemons` (root:wheel 0644, exactly what `review-daemons.mjs` builds), each written whole beside its name and renamed over it. launchd starts every job file there at boot, with no `load` to refuse it, so `place` refuses on exactly the checks `load` makes for the jobs it places (the install check, and each optional job's own checks below) | yes |
| `sudo /usr/local/bin/node setup.mjs daemons load` / `unload` | `launchctl bootstrap` / `bootout` for each job not yet loaded / loaded; load refuses unless the install check passes and the job files are there; a job loaded from an older file is taken out and loaded again (`load` records each file's fingerprint in `<base>/install/loaded-jobs.json`, root's); unload with nothing loaded is not an error | yes |
| `/usr/local/bin/node setup.mjs daemons list` / `check` | read only: `list` shows loaded or not, state and last exit. `check` FAILs on: a job file wrong or missing; a leftover job file under another label; a job not loaded; a job loaded from an older file than the one on disk; a job whose last run did not end with exit 0; a job whose current run has been going over 30 minutes (a hung run keeps the last exit green); `ps` answering with something unreadable counts as a FAIL, `ps` printing nothing (the run ended meanwhile) does not. It cannot see a job loaded under an old label whose file is gone: `daemons unload` under the old label first. Changing the label, `review.json` or the owner's home folder needs `daemons unload`, the change, `place`, `load` | no |

**The Dispatcher's lines: check-dispatcher (L748).** The config's `hostLockPath` is the full path of the owner's `host.lock`,
in the owner's home (`/Users/<owner>/...`; spaces are fine). check-dispatcher says:
- the review runner's folder holds its `launches` folder (the runner makes it on its first run; the Dispatcher won't start without it);
- host.lock is the owner's (not orchestrate's), one plain file with one name, no bigger than the Dispatcher reads
  (`HOST_LOCK_MAX` in `wiring/worker-ports.mjs`), and `orchestrate` can read it. As root it reads it as `orchestrate`;
  without sudo that line is NEEDS ROOT. When the read fails it says why, in plain words: a folder above it `orchestrate`
  can't go into (it names the folder; the folders of the path as written and of its real place, through links), the file's
  own permissions (naming the file's mode, for example 600), macOS privacy protection (when macOS answered "Operation not permitted" and the permissions allow the
  read), or else the read's own error. A missing host.lock passes when `orchestrate` can reach its folder: the Dispatcher
  reads that as no host claimed. A folder that is not there is a wrong path, and fails.
- whether the Dispatcher's background job can read it. macOS judges a read by the app it runs from, so a read from the
  Terminal proves nothing for the job when host.lock is in a folder macOS guards (a synced cloud folder under
  `~/Library/CloudStorage` or `~/Library/Mobile Documents`, Desktop, Documents, Downloads, or another disk under
  `/Volumes`). There this line is NOT TRIED, which counts as a FAIL: keep host.lock outside those folders, or prove the read
  from the job itself. That holds when host.lock is missing too: the job would be refused the read, not told the file is
  missing, so it would say "not known" on every pass. The place is judged on its real path, as the disk spells it (a
  config spelling `library/cloudStorage` is still the guarded folder), after any links.
The mirror and `seals/` are rows of the folder table, so `check` compares their owner and mode.

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
Each `PLANT` test breaks one clause and names the check that catches it. `dispatcher-check.test.mjs` covers the Dispatcher's keys: the seal folder, the copies' access list on the real `chmod` and `ls`, `hostLockPath`, `dispatcher-keys` and each reason check-dispatcher gives for a host.lock orchestrate can't read.

## Part 3 — taps, proposals, git trust, the account job reload, the watch-only token

| Command | What it does | Root? |
|---|---|---|
| `sudo /usr/local/bin/node setup.mjs users-folders` | now also makes `<base>/owner-taps` (the owner's, 0755, no access list; runner setting `ownerTaps`) | yes |
| `sudo /usr/local/bin/node setup.mjs users-folders` (same command) | also makes `<base>/owner-answer` (the owner's, 0755, no access list; L727): the owner's Sensors job (`wiring/owner-answer.mjs --to <base>/owner-answer/owner-answer.json`, run as the owner) writes `owner-answer.json` there, 0644; `orchestrate` lists and reads it, and no one but the owner writes. Point the Sensors' answer file at that path | yes |
| `sudo /usr/local/bin/node setup.mjs users-folders` (same command) | also makes `<base>/watch` (orchestrate's, 0700: the runner's log and rules draft) and `<base>/watch-notes` (the owner's, 0755: the written explanations; only the owner writes, orchestrate and the summary read) (R-0b-122) | yes |
| `sudo /usr/local/bin/node setup.mjs proposals` | makes `proposalsParent` (default `/Users/Shared/orchestrate-proposals`: root's, **0711**) and one folder per product (the owner's, **0700**, one access-list entry for `orchestrate`: list/search/read, inherited). Runs behind the same folder-chain wall as every root command; the folder the parent sits in must be root's and either written by no one else or sticky (as the Mac's own `/Users/Shared` is), and the parent itself root's and not writable by others unless sticky. A file moved in from elsewhere may not be readable by `orchestrate` (it keeps its old owner and mode): copy it in instead. | yes |
| `/usr/local/bin/node setup.mjs check-proposals` | read only: owner, mode, exact access list; with `sudo` also: the owner can write, `orchestrate` reads and cannot write, `review` cannot read | no (sudo for proofs) |
| `sudo /usr/local/bin/node setup.mjs safe-directory` / `check-safe-directory` | runs `git config --global --add safe.directory <base>/mirror` **as the owner** (root never writes into their home). It reads what their git trusts from every settings file it reads (system, global, anything they include), and refuses if any entry has a `*` in it (`*`, `/path/*`): remove the line yourself where it lives. The check FAILs on a `*` even next to the mirror | yes |
| `sudo /usr/local/bin/node setup.mjs daemons reload-account` | refuses (no steps, exit 1) unless the install check passes, as `daemons load` does. Already loaded from the file as built: nothing to do, and its closing check still runs. Otherwise, if the `review-account` job is loaded: rewrite its file (carries `--install <copy>`), unload, load, record, and read back that it is loaded. Not loaded (never loaded, or an earlier reload stopped after the unload): it says plainly that the account job is not loaded and to run `daemons load`, exit 1, never "done". A failed load during the reload stops with that one instruction | yes |
| `sudo /usr/local/bin/node setup.mjs prove-token` | proves the token **cannot write pull requests** against the repository the config names (`"watch": { "repo": "owner/name" }`; never typed on the command line). The token file is looked at first without following links (orchestrate's own plain 0600 file), then read **as orchestrate** (`sudo -H -u orchestrate cat`). Then: the repository is private and not archived; listing open pull requests works; a no-op change to an open one is refused with GitHub's "this token may not" answer (a rate limit or any other 403 is not proof); and it makes one real read of each kind the watch job makes (`WATCH_READS` in `modules/M6-merge-gate/watch-only.mjs`), on main's latest commit with a pull request, so it stops if the key lacks one, or if no such commit is found among main's latest 50. A read GitHub refused with a 403 (not a rate limit) or a 404 says to give the key that permission; a 429, a rate-limit 403, a 5xx, no answer or an empty answer says GitHub didn't answer properly and to run it again; each is a FAIL. The check runs, which the job reads with the watcher App's token (L624), are proven with that token: as `orchestrate`, the installed copy's `watch-run.mjs checks` mints it through `token.mjs` from the config's `watch.app` (the job's own arguments) and reads the check runs on the same pull request's head; no App in the config, no key file, a failed mint or a failed read is a FAIL that says which, and with no commit to try it on it is NOT TRIED (not a pass). The App's token stays inside that process. Output has only fixed sentences and numbers, never a token. **It does not prove the token cannot change code or that it reaches one repository**: after a PASS it prints what to check by eye on GitHub's token page (one repository; Contents, Pull requests and Commit statuses all read-only; nothing else; not Checks, which the watcher App holds) | yes (reads the file as orchestrate) |
| `sudo /usr/local/bin/node setup.mjs token` / `check-token` | types the watch-only token hidden into `<base>/keys/watch-only-token` (orchestrate's, 0600; written at a side name and renamed over the old one, so a failed write keeps the token that works); the check reads owner, mode and size only. A leftover side name is removed as a name only; the new file is made there exclusively, never through a link, and its owner and mode are set on the same open handle before the token is written; a write that fails removes the side file, and only the rename touches the token's own name | yes |

Why the proposals parent is 0711 root's and the folders use an access list, not a group: the owner's own group (`staff`) holds
every ordinary user of the Mac. The parent sits in a folder everyone can write into (a sticky one), so the base wall alone does not cover it: the wall
runs first, and then root also checks that folder and every folder above it, makes the parent itself, refuses one that already exists and is not root's, and a first step re-checks it. Open for the lead:
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

Config: an optional `"watch": { "repo": "<owner/name>", "rulesSha256": "<64 hex>", "app": { "id": "<digits>", "installation": "<digits>", "keyFile": "<name>" } }` in the root-owned config. Without it,
everything below is off. With only the `repo` (all `prove-token` needs) the three review jobs are exactly as before, no hourly
job is built, and `watch-rules`, `check-watch-rules` and `daemons ... --only watch-only` say "no rulesSha256 yet" and what to do.
The hash is the SHA-256 of the rules draft file (`shasum -a 256 <file>` prints it), written by whoever
edits the root config, so the owner's own Mac user cannot choose the rules the week is judged by.
The fingerprint is of the UTF-8 text of the file, so it is the same as `shasum`'s for any valid UTF-8 file (which a rules file is).

| Command | What it does | Root? |
|---|---|---|
| `node setup.mjs watch-rules --print-config-line --repo <owner/name> --rules-source <full path>` | read only, no root: prints the one config line to add (`"watch": { "repo": …, "rulesSha256": … }`), the fingerprint being that of the rules file named. The line ends in a comma, ready to go above another key; as the config's last key, drop that comma. Works before the config has a `watch` entry. Refuses (prints nothing) if the file is not a full path, cannot be read or is empty, or if the repository is not a name the config itself would take (one owner/name check for both, `isRepoName` in layout.mjs) | no |
| `sudo /usr/local/bin/node setup.mjs watch-rules --rules-source <full path>` | the rules file is always named (the rules are the product's own policy, so Bob carries no copy of them); a relative path, an unreadable or empty file is refused. Refuses unless the file hashes to the config's `watch.rulesSha256`; writes it as `<base>/watch/rules-draft.yaml` (root's, 0644, in orchestrate's 0700 folder). Keep the file at a plain local path, not in a synced or home folder root cannot read. `--dry-run` shows the step | yes |
| `sudo /usr/local/bin/node setup.mjs watch-app --app-id <id> --app-installation <id> --app-key-name <name> [--rules-sha256 <hex>] [--dry-run]` | names the read-only watcher App the hourly job reads check runs as (L627): writes `"app": { "id", "installation", "keyFile" }` into the config's `watch` entry, keeping every other entry, by writing the new file beside it (root:wheel 0644) and renaming it over in one step. The key must already be in the keys folder (`<base>/keys/<name>`, orchestrate's, 0600), and the run checks the config still holds the text it planned from. The same App already named: nothing to do. A different one: replaced, and the step says which it named. `--rules-sha256` also sets `watch.rulesSha256`, refused unless the rules copy in place hashes to it (L633: a re-pin made in the job file alone is brought back into the config, so `daemons place` rebuilds the same pin) | yes |
| `sudo node setup.mjs check-watch-rules` | read only: the copy is there, root's 0644, no access list, and hashes to the config's value; and the watcher App's key is orchestrate's own plain 0600 file of a key's size, with one name and no access list (never read). It checks the key file only and asks GitHub nothing: `prove-token` is what proves the App can read the check runs. No `app` in the config: FAIL, because without it every pass reports the check runs not known. Without sudo: NEEDS ROOT (exit 3), never PASS | no (sudo to look) |
| `sudo bash <a private copy of the reviewed watch-cutover.sh>` the first time; after that also `sudo bash /Library/orchestrate/install/orchestrate/setup/watch-cutover.sh` | the watch job's cutover to the watcher App in one paste (L643): the updater once (b), `watch-app` with the App and the rules pin (a), `watch-rules` from the copy in place after its fingerprint is checked (a2), `daemons place` and `load --only watch-only` (c), then `check-watch-rules`, `check-install` and `daemons check --only watch-only` (d); each step's dry run first; it stops at the first FAIL with one plain line. It then starts one watch pass and shows the end of the job's logs, failing on an HTTP 403, a pass that did not end with exit 0, or one still running after 3 minutes. Its values (the App, the installation, the key name, the pin) are at its top. Run from outside the copy (the first time, since the copy before step b has no such file), it runs step b, then hands over to the copy's own file, only when that file is byte for byte the one bash started from (resolved before step b); root never runs steps a to d from a file anyone else can write, and they all use the copy the link named when they began. `watch-cutover.harness.sh` runs it against a stand-in install (its test runs that). It never reads the key. |
| `sudo node setup.mjs daemons place` / `load` / `check` | with a `watch` entry that has `rulesSha256` there is a fourth job, `<label>.watch-only`: runs as `orchestrate`, from the installed copy, `watch-run.mjs once --rules draft --rules-sha256 <hash>` every hour, with `--app-id`, `--app-installation` and `--app-key-file <base>/keys/<keyFile>` when the config names the App (all three or none). `place` and `load` refuse until the rules copy is in place. `--only <job>` (also on `unload` and `list`) does that one job only, e.g. `daemons place --only watch-only`; a name that is no job of the config is refused before anything runs | yes |

The runner re-checks the hash on every pass and judges nothing if the file differs. The job's file is built with the
launcher's one plist builder and label rule (`review-daemons.mjs` exports them), so there is one of each.

## Part 5 — the robot job (R-0b-162 B; LEAD-CALLS L236, L238, L610)

`robot-setup.mjs`. Off unless the setup config says `"robot": true`; then the config's `extras` must carry the robot's
prepared config as a file named `robot.json`, which the install puts in the copy and every update keeps (as it keeps
`review.json`). A config without `"robot"` places exactly the jobs it did before.

| Command | What it does | Root? |
|---|---|---|
| `sudo node setup.mjs daemons place` / `load` / `check` (also `--only robot`) | a job `<label>.robot`: runs as `orchestrate` (the Record's owner and the key folder's), from the installed copy, `wiring/robot-main.mjs <copy>/robot.json`, every 60 s and once at load, logs `robot.out.log` / `robot.err.log` in the log folder (orchestrate's, as every job with a user). Built by M11's `loginJobPlist`, the Dispatcher's builder. `place` and `load` refuse, and `check` FAILs, unless the copy's `robot.json` is root's alone and holds the values setup knows: `wiring` = the copy's `wiring/robot-wiring.mjs`, `ownerUid` = orchestrate's, `keyDir` = `<base>/keys`, `installRoot` (if given) = the copy, `lockFile` = `<base>/home/orchestrate/robot.lock` (orchestrate's home, which only it can write), `dispatcherLockFile` a full path, different, outside the install, in a folder that is orchestrate's or root's, so no worker can plant a lock there; both written plainly (no `.`, `..` or doubled `/`); each lock's folder there as a plain folder (not a link), written by no group or other, with no access list, and every folder above it root's; no key the robot job does not take. The job file also sets `HOME` (orchestrate's home) and `Umask 63`, as the watch job. The rest is the job's own start check: a refused start exits 1, and a round that cannot take its lock (a missing or unwritable folder, a lock held by another user's process, or one of its own held longer than any round may run) exits 3 with one log line naming the lock and the cause. A last exit that is not 0 is what `check` fails on; a round that finds the last one still running exits 0. `daemons unload --only robot` (and `list --only robot`) work even after the config turns the robot off, so a job left loaded can come out alone. A robot job placed or loaded while the config leaves it off fails a full `check`, as does one under an old label. With a `dispatcher` entry, `robot.json` must name the same `productsFile`, `rulesStateDir` and `tokenFile` that `dispatcher-config` prints (`uses …`), or `place` and `load` refuse both jobs | yes |

Loading it on the always-on Mac is an owner-run step. It waits for the robot's config (the Dispatcher's keys, C) and
for the passes it runs to be wired.

## Part 6 — the Dispatcher's config and job (R-0b-162; LEAD-CALLS L748, L757)

`dispatcher-setup.mjs`. Off unless the setup config has a `dispatcher` entry, which names what setup can't know itself and
nothing else: `{ "product": "<one of products>" }`, and, only to choose other places than setup's, `productsFile` (M10's
products.json; default `<base>/private/products.json`, which root puts there), `rulesStateDir` (M10's state folder; default
`<base>/private/rules-state`), `tokenFile` (orchestrate's read-only GitHub token file; default `<base>/keys/watch-only-token`,
where `token` puts it) and `approvalsStateDir` (M2's state folder; default `<base>/private/approvals`). `dispatcher-config`
prints the four paths it uses and which are setup's defaults, so the robot's `robot.json` can name the same ones. Plus an
optional `runDeadlineMs` of at most the Dispatcher's default (`RUN_DEADLINE_MS` in M11 `main.mjs`, which the robot job
judges it by). Each path is full and written plainly, outside the install. The entry needs `hostLockPath` too.
Every other key of the Dispatcher's config setup writes itself, from the layout: the copy and its wiring, the lock
(`<base>/home/orchestrate/dispatcher.lock`, in orchestrate's home, which only it can write), the Record (`<base>/products/<product>/store`,
owned by `orchestrate`, whose uid is `ownerUid`), the review runner's requests folder, status file, user and log, and the five
keys `dispatcher-keys` prints (among them `hostLockUid`, the owner's Mac user id: the Dispatcher reads host.lock only when the
file it opened is the owner's).

| Command | What it does | Root? |
|---|---|---|
| `sudo node setup.mjs dispatcher-config` (`--dry-run`) | writes `<base>/dispatcher.json` (root:wheel 0644), every key `wiring/dispatcher-wiring.mjs` takes, and nothing else (a `dispatcher.json` written before `outboxRoot` and `copiesRoot` were keys, L887, is refused at start until this is run again); once there is an installed copy that keeps it (and is root's alone), the copy's `dispatcher.json` as well. Each file is written whole beside its name and renamed over it, so a reader never finds it missing or half written. Twice does nothing. It closes with a check of both. While the Dispatcher job is loaded or placed (it reads the copy's file on every pass, and starts at boot), it first makes the checks `load` makes against the new config: the robot match and check-dispatcher. If either fails it changes neither file, and says to put that right, or to take the job out (`daemons unload --only dispatcher`, delete its job file), run it again, then place and load. The owner's Mac user (host.lock's owner) may not have the uid of root, orchestrate, review or pages | yes |
| `sudo node setup.mjs install` | with the entry, refuses unless `<base>/dispatcher.json` is there, root's 0644, and the config this setup writes now; then carries it into the copy, and the updater keeps it on every update (it is one of `keep`), as `review.json` | yes |
| `sudo node setup.mjs daemons place` / `load` / `check` (also `--only dispatcher`) | a job `<label>.dispatcher`: runs as `orchestrate`, from the installed copy, `modules/M11-dispatcher/main.mjs <copy>/dispatcher.json`, every 60 s and once at load, `HOME` orchestrate's home and `Umask 63`, logs `dispatcher.out.log` / `dispatcher.err.log` (orchestrate's). Built by M11's `loginJobPlist`, as the robot job. `load` refuses, and `check` FAILs, unless the copy's `dispatcher.json` is root's alone and exactly what `dispatcher-config` writes now, and the copy keeps it. With the robot job on, the copy's `robot.json` must name the same Record (product, Record folder and owner, products file, rules state, token file) and the Dispatcher's lock as its `dispatcherLockFile`, which is also checked when only the robot job is loaded or checked. The Dispatcher's lock's folder must be orchestrate's, not writable by others, under root's folders. `place` and `load` also run check-dispatcher first and refuse on any FAIL in it, and `check` FAILs on one. A NOT TRIED line (host.lock in a folder macOS guards) does not stop the load, because only the job's own read can prove it. `daemons check` reads a Dispatcher run as stuck only past its deadline and the watchdog's margin (about 35 minutes). `daemons unload --only dispatcher` works even after the entry is gone | yes |

A copy installed before the entry existed has an updater that does not keep `dispatcher.json`: `dispatcher-config` and
`check` say so, and the copy must be installed again (unload the jobs, remove `<base>/install`, run `install`).

**On the always-on Mac (owner-run steps):**
1. Add `hostLockPath` and the `dispatcher` entry to the setup config, and put it in place.
2. `sudo node setup.mjs users-folders`, then `sudo node setup.mjs dispatcher-config`.
3. Install (again, if the copy is older than the entry), then `sudo node setup.mjs check-install` and `sudo node setup.mjs check-dispatcher`.
   check-dispatcher fails until the review runner has made its `launches` folder on its first run, and a full `daemons place`
   or `load` refuses until check-dispatcher passes. So on a Mac whose runner has never run:
   `sudo node setup.mjs daemons place --only review-runner`, then `sudo node setup.mjs daemons load --only review-runner`,
   wait a minute, and run check-dispatcher again.
4. check-dispatcher passes; then `sudo node setup.mjs daemons place`, then `daemons load`, then `daemons check`.
5. Prove the job's own read of host.lock: its log must show no "not known" for host.lock. host.lock stays in the synced
   folder, because the lock between the Macs needs the sync. **If macOS's privacy protection stops the job's read there**,
   the fallback is a small job of the owner's own that copies host.lock to a plain folder outside the guarded ones, with
   `hostLockPath` pointing at the copy (the copy is the owner's file, so the owner check still holds). It is not built yet.
6. To change a path the Dispatcher and the robot share while both jobs are in place: `dispatcher-config` refuses, since the
   copy's `robot.json` still names the old one. So: `sudo node setup.mjs daemons unload --only dispatcher`, delete the
   Dispatcher's job file (and a `.<label>.dispatcher.plist.new` beside it, if a cut-off write left one; `daemons check` names
   any such file), change the entry and `robot.json`, then `dispatcher-config`, install, `daemons place`, `daemons load`.
