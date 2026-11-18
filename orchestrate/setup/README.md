# orchestrate/setup — the always-on Mac's one-time setup

Commands for the Mac-level setup that has no other home (runbook Part A). Plain Node, no dependencies. Bob is public, so
nothing here names a product, a person or a machine: those come from a config file.

## Part 1 (R-0b-05): the Mac users and their folders

`layout.mjs` is the one list of what exists: the users `orchestrate`, `pages`, `review` and `builder` (`USERS`; `builder`
since L1079, the user the worker runner and every worker session run as), and every folder with its
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
| `sudo /usr/local/bin/node setup.mjs users-folders` | makes the users in `USERS` (ids 600-699, all different; hidden, shell `/usr/bin/false` except `builder`'s `/bin/zsh`, which its sessions' Bash tool runs, password `*`, own group with no members, never admin), then the folders (owner, group, exact mode, exact access list), then runs `check` | yes |
| `node setup.mjs check --config <file>` | read only: `PASS`, `FAIL` or `NEEDS ROOT` per item; exit 1 on any FAIL, exit 3 if all that could be seen passed but some items need root. Before setup it lists 57 FAILs of 61 items for one product (about 10 more for each extra product: its copies, outbox and rules folders, L836), which is expected | no |
| `sudo /usr/local/bin/node setup.mjs check` | the same with nothing hidden: the sudo-rule and password-hash items can be read | yes |
| `sudo /usr/local/bin/node setup.mjs proofs` | runs, as `builder` (L1079), the "cannot" proofs: the record, hooks, settings, launcher, lead-main, claude-code and install copies and the outbox folders cannot be written; the robot keys, the other users' homes, the owner's home and every production file and secret the installed `review.json`'s rules and the worker runner's `worker-runner.json` (each product's rules, when it is installed) name cannot be read; and `builder` is in no group but its own and the ones macOS gives every local user (controls first). A rules entry that names nothing on this Mac (none, a relative name, a pattern, a missing file) is NOT TRIED, which fails the run like a FAIL: containment is proven only when every line is PASS. Every place is judged by what it reaches, never by its name (#528 r3): when root finds its real place elsewhere (a link anywhere along the path), both are proven and both must be refused; a place that is not there, or that has changed between making the list and proving it, is NOT TRIED. What a place reaches includes (#528 r4) the links inside a folder of secrets that lead out (each proven as its own place), a file's other names (a file with more than one is NOT TRIED), and the folders above it, which `builder` must neither write nor own. Those folders are every one met on the way, one link at a time, a middle link's included (#528 r5); in a shared folder (`/private/tmp`, `/Users/Shared`) root itself looks at who owns the name there, without following a link. Who owns a place is always root's own look, never `test -O` (#528 r6): the place itself, every step on the way and every folder above, a link not followed; `builder` owning one is a FAIL (it could chmod a secret it owns), and so is an access-list entry that lets it, or a group it is in, write, delete, rename or change who may. Root first checks it is the very thing the list saw, with one name only; otherwise NOT TRIED. The one exception is the builder sessions' sign-in (L1261): its folder is on the worker rules' secrets but is `builder`'s own, so it is not a "cannot read" proof; instead root looks that no user but `builder` and root can read the file or its folder (NOT TRIED until `builder-signin` has made it) | yes |

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
  answers (L722). An earlier setup built from the plan-reviewer branch alone made `plan_reviewer/` the workers' user's; `users-folders` refuses to take that over, so look inside it, remove it by hand, then run `users-folders` again. Each other worker role but the two the worker runner starts has a folder owned by the workers' user, group wheel, 0750, with one access-list entry letting `orchestrate`
  list, read and clear (`delete_child`), with inheritance. The worker seals its own hand-in file 0440. `check` compares the
  access list and the group exactly: a missing or an extra entry FAILs.
  **One folder per product, too (L836).** Beside the role folders, `outboxes/<product>/` is root's 0755, and under it
  `worker/` and `script/` (the roles the worker runner starts) are the workers' user's 0750 with the same `orchestrate`
  entry. Those two roles have no flat folder (L914): `outboxes/worker/` and `outboxes/script/` left by an earlier setup
  FAIL in `check` by name, with what they hold (a hand-in there may not be taken in yet); check each holds nothing unsaved,
  then remove it by hand. Setup removes nothing.
  The worker runner writes a session's outbox at `outboxes/<product>/<role>/<session>`, so a session can be
  denied every other product's whole folder (which names a product may take: `shared/product-paths.mjs`). The review roles take no product: their
  folders, and `review-copies/`, stay as they are. `proofs` checks, per product, that the owner CAN write
  `worker-copies/<product>` and both role folders (controls) and can NOT write `outboxes/<product>` itself.
  Every "cannot write" proof shows the state now; that the owner cannot gain write (own the folder and `chmod` it) is
  `check`'s job: it wants each of these folders owned by root, orchestrate or review (never the owner), with the exact
  mode and access list.
- **The worker runner's folders (L921).** `worker-runner/` is root's 0755, so none under it can be renamed away; under it,
  each apart from the others and from every copies, outbox and mirror folder: `requests/` (the owner's, group wheel, 0700,
  with one access-list entry letting `orchestrate` only go in and add a file, `search,add_file`: the Dispatcher writes
  each request new; the runner reads and removes it), `runner/` (the owner's 0755: the runner's status, which the
  Dispatcher reads and refuses when others can write the folder, its memory, settings and lock). Its sessions' rules
  snapshots are root's, in `worker-rules/` (the `worker-rules` job writes them, L1226); a `worker-runner/snapshots/` left
  from an earlier setup is no longer read, and `check` FAILs on it (`worker-runner/` holds an entry the setup did not
  make) until the owner approves removing it: the run-sheet step "remove the leftover `<base>/worker-runner/snapshots`
  folder (`sudo rm -r`)" (L1254 m2). `proofs` checks the owner can NOT write `worker-runner/` itself.
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
  Since L836 `worker-copies/` holds one folder per product (the owner's 0755, the same entry), and each card's copy is
  `worker-copies/<product>/<card>`. The entry lets `orchestrate` remove a product's folder once it is empty; the worker
  runner then refuses that product until `users-folders` is run again (it fails safe). `check` FAILs on anything else in
  `worker-copies/`, by name: a copy made before L836 (directly under it) or the folder of a product the config no longer
  names. Setup removes nothing: check that each holds nothing unsaved (`git status`, and commits not yet pushed), then
  remove it by hand. To drop a product, take it out of `products`, then clear its `worker-copies/<product>` that way and
  remove its `outboxes/<product>` (root's, which `check` also names); its `products/<product>` folders stay until removed
  by hand as well.
- **The seal folder.** `seals/` is orchestrate's 0700: where cleanup seals a copy's bundle it could not prove saved (the
  Dispatcher config's `sealRoot`).
- It never sets or reads a password. An unknown argument is never printed back (it could be a secret).
- **The builder user (L1079).** The worker runner's job is a LaunchDaemon running as `builder` (`wiring/runner-job.mjs`),
  so a worker session holds no production credentials and cannot read the owner's home. `builder` owns what the worker
  runner writes: `worker-copies/` and each product's copies folder, `worker-runner/requests` and `runner/`,
  and each product's `worker/` and `script/` outbox folders (0750, group `orchestrate`, with the `orchestrate` read entry:
  the robot reads hand-ins and bundles there and writes nothing). The Dispatcher's `workerUid` is `builder`'s id, never the
  owner's (`dispatcherKeys`); each product's rules-in-force folder is read by `review` and `builder`. The worker runner
  refuses to start as root, as any user but `builder`, or as a user in staff or admin (`runner-main.mjs personUserProblem`, L1079), and reads the owner's
  account choice from root's copy (`accountCopy`), signing in from `builder`'s own account folders.
- Not in this part: the install and the background jobs (part 2, below); the ownerTaps and proposals folders, the account job
  reload and the watch-only token file (part 3).

### Moving the workers to the builder user (L1079)

On a Mini set up before L1079 the worker folders are the owner's own. The builder starts clean: `users-folders` takes an
owner's folder over only while it holds nothing but the table's own folders, and refuses, changing nothing, while the
worker runner's status lists a live session or any such folder holds a copy or hand-in from before. It never moves or
deletes anything. Steps, on the Mini, in a new Terminal app window, with your base in place of `/Library/orchestrate`:

1. Stop any worker runner still running as you. Paste `launchctl list | grep -i worker-runner`. If a line comes back,
   paste `launchctl bootout gui/$(id -u)/<the label it shows>` and remove its file from `~/Library/LaunchAgents`.
   *An old runner left loaded would be a second runner, as you.*
2. In the `orchestrate/setup` folder you run setup from, paste `sudo /usr/local/bin/node setup.mjs users-folders --dry-run`.
   *Shows what would change; it makes `builder` and lists any folder it refuses.*
3. For each folder it names as "still the owner's ... holds": in that folder run `git status` and `git log @{u}..` in each
   copy, so nothing unsaved is lost, then paste `mkdir -p ~/orchestrate-before-builder && sudo mv "<the folder>" ~/orchestrate-before-builder/`.
   *Moves the old work out of the base into your home, where `builder` can't read it.*
4. Paste the same command without `--dry-run`: `sudo /usr/local/bin/node setup.mjs users-folders`.
   *Makes `builder` and hands it the worker folders; it ends with `check`.*
5. Give `builder` its Claude sign-in, **after Part 2's `add-to-install`** (step 6 doesn't need it, so go on and come
   back). `/login` as `builder` does not work: `builder` never logs in to macOS, so it has no login Keychain ("A keychain
   cannot be found to store builder"). Instead (L1261) make a long-lived token as yourself and save it for `builder`:
   the steps are in Part 3, "Where the builder sessions' sign-in lives".
   *The sign-in lives in `<base>/builder-signin/claude-signin`, `builder`'s own file; the workers use it on the account
   that made it.*
6. Paste `sudo /usr/local/bin/node setup.mjs proofs`. *Must end "all N proofs PASS: containment is proven on this Mac";
   a FAIL or NOT TRIED line says what to fix.*

**Later runs too (#528 r1 m7).** The live-session check is not only for the move: every later `users-folders` run (a new
product, a fixed mode) refuses, changing nothing, while the worker runner's status lists a live session, and also when that
status file can't be read, is a link, is not a plain file, or lists an entry that is not a session (#528 r2 m3). To run it: let the sessions end (or stop the worker runner
with `sudo launchctl bootout system/<label>.worker-runner`), then run `users-folders` again. `daemons check` also FAILs
while a job file in your own `~/Library/LaunchAgents` starts the worker runner's script, whatever its name (step 1; #528 r2 m7).

The worker runner's config and job are setup's own since #537: `worker-config` writes its `worker-runner.json` and
`daemons place` its job (Part 6's table, with the `workerRunner` entry).

## Part 2: the install and the background jobs

Extra config keys (the same file): `address` (https address of the repository), `label` (starts the jobs' names),
`runnerConfig` (full path of the review runner's prepared `review.json`, whose `installRoot` is `<base>/install/orchestrate`,
and whose `"uids"` names the Mac user id of every role: `reviewer`, `auditor` and `plan_reviewer` all name `review`'s id
(`dscl . -read /Users/review UniqueID` prints it), every other role the owner's, and none root. `install` refuses, and `check-install` FAILs,
a map that leaves a role out (L726), names root, gives a runner role an id another role also names, or names a key no role is called; without `plan_reviewer` the runner refuses every plan review. Both say "couldn't read the review user" rather than pass when `review` can't be read (run `users-folders` first). **An install made before the plan reviewer** (L737 M1): its copy's `review.json` has no `plan_reviewer`, and re-running `install` does not change it (the copy is kept, and every update carries its `review.json` forward). `check-install` gives a WARNING for that, not a FAIL, so the jobs still load. To put it right: add `"plan_reviewer": <review's id>` to the `uids` of your checked `review.json` (the one `runnerConfig` names), then `sudo install -o root -g wheel -m 0644 <that file> /Library/orchestrate/install/orchestrate/review.json` (with your base), then `check-install` again. Once add-to-install lands (#243) that is the step instead, and the WARNING becomes a FAIL),
`extras` (full paths of anything else the runner config names in the copy, often none: its claude program and hooks are put in by `add-to-install`, not carried as extras, and the `--for-install` file names neither; the wiring and the budget module are the copy's own code, never extras. With the base `/Library/orchestrate` the runner config names the wiring exactly `"wiring": "/Library/orchestrate/install/orchestrate/modules/M4-workshop/launcher/review-wiring.mjs"`; the budget module is `review-config`'s own `budget` field, `modules/M11-dispatcher/budget.mjs` under the same copy), and
optionally `gitBin` (default `/usr/bin/git`) and `nodeBin` (default and advised: leave it out, so it is the node running the command; a node root may not run, such as a Homebrew one, is refused before any step; a `nodeBin` that is a link, not the program's own real file, is refused too, because the copy is made from the name). Each extra is named by its real file, not by a shortcut: a link, a missing file or a link inside a folder is refused at plan time, with no step run. Root reads the runner config through one handle, never through a link, and only if it is root's own and written by no one else; an error never shows a byte of it.
When root runs `install` for real, the `runnerConfig` file must be root's own, written by no one else, with every folder above it root's too (root takes no orders from a file others could change). A `--dry-run` reads the file with root's own rules and prints a WARNING, with the reason, only when root would refuse it (a dry run that prints no warning means root will take it). To put the file in place: keep your copy of `review.json` in a folder only you can open, run `sudo install -o root -g wheel -m 0644 /dev/stdin /Library/<name>.json < ~/review.json`, and set `runnerConfig` to that `/Library` path. The file is read once; the copy root installs is the text that was checked.
Every name, path and layout rule comes from the launcher's own modules (`install-check.mjs`, `review-daemons.mjs`,
`review-updater.mjs`); `install.test.mjs` pins the two copies it cannot import (the label rule, the updater's file set).

**The order, for the review runner's file (L731):** (1) `review-config --for-install`, then put the file in place as `runnerConfig`; (2) `install`, then `check-install`; (2b, L995) `bob`, so step 3 names the Bob file list; (3) `review-config` again without `--for-install`, put that file in place; (4) `add-to-install`; (5) `daemons place` and `load`. Jobs loaded before step 4 show FAIL in `daemons check` (the runner refuses its file until `claudeBin` is there). **On a Mac that already has a copy** (L1029 C), step 2's `install` does nothing ("already installed"), and `check-install` FAILs the role-map item (`review.json names a Mac user for every role…`) until step 4 puts the full `review.json` in. That FAIL is expected there: go on to steps 2b, 3 and 4, then run `check-install` again. If the setup config gained the `dispatcher` entry or `"robot": true` since the copy was made, the copy must be installed again first (Part 6, below).

| Command | What it does | Root? |
|---|---|---|
| `/usr/local/bin/node setup.mjs review-config --pin <x.y.z> --input <file> --out <file> [--for-install]` (`--dry-run` first) | builds the review runner's `review.json` rather than having it typed (L709). Each field has one source (`review-config.mjs` `SOURCES`): the folders, the copy's paths and the Mac users' ids come from the setup config and the Mac; the pin and the program's place in the copy from `--pin`; only three come from your `--input` file, each required, with no default: `product` (whose Record the runner reads, and whose rules snapshot from the Dispatcher launch check 12 reads, `dispatcherRules`), `machineWide` (the machine-wide Claude Code settings file; it must be `/Library/Application Support/ClaudeCode/managed-settings.json`, the only one claude 2.1.322 reads, and any other path is refused here, by both runners' configs at load, and by launch check 10, since its guard would never apply; launch check 10 refuses that file when it is missing or `{}`, since it must carry the guard. Check 10 also reads every other managed source claude reads: the `managed-settings.d/` drop-ins beside it, the managed preferences in `/Library/Managed Preferences`, and the remote settings cache where each session's claude reads it: its own `CLAUDE_CONFIG_DIR` (the second account's `.claude-b`), else its own `HOME`'s `.claude`. Each one there with content must carry the production guard itself, because only the highest source with content applies; an empty one (`{}`) counts as none, as claude reads it (claude writes `{}` as the cache when the server has no settings), but `machineWide` itself must always carry the guard (above). One that can't be read refuses, a linked drop-in too, and so does any source naming a policy helper. Known gap: when there is no remote settings cache, settings the server sends at start are never seen by check 10, and they would displace the guard. The owner confirms the account has no organization remote settings. Source list and recheck note: M4 `launcher/env-check.mjs`, checked: claude-code 2.1.316) and `rules` (`production.env_files`, `production.programs`, `production.hosts`, `secrets.paths`; an empty list says none). The input may hold nothing else. A pin other than the one the role tool lists were checked on (M10 `TOOLS_CHECKED`) is refused, the dry run included. The file is read back with the runner's own `readConfig` before it replaces `--out`; if it refuses, nothing is written and an earlier file at `--out` is kept. `budget` (M11's budget module, launch check 12) is set, with the worker runner's status file and user its running count reads; `bobManifest` is named once the `bob` step has made the list. Put it in place as root's own: `sudo install -o root -g wheel -m 0644 /dev/stdin <runnerConfig> < <the file>`. **Two forms, in this order:** with `--for-install` for a first `install` (it leaves out `claudeBin` and `hooksDir`, which a first install can't carry; the runner refuses reviews until the next step), then without it for `add-to-install`, which puts the pinned Claude Code and the hooks where the file names them | no (refused under sudo) |
| `/usr/local/bin/node setup.mjs install --config <file> --dry-run` | prints every step (and every refusal, before any step) | no |
| `sudo /usr/local/bin/node setup.mjs install` | makes the root-owned `install` folder, a root-owned copy of the updater's three files and of node, the seed (`updater.json`, `review.json`, the extras), then runs the updater's `--first` run, which builds the `.v-<commit>` copy and flips the link; then checks | yes |
| `sudo /usr/local/bin/node setup.mjs add-to-install --pin <x.y.z> --sha256 <hex>` (`--dry-run` first) | puts the pinned Claude Code and the hooks into the copy that is installed now, in place, and replaces its `review.json` with the prepared `runnerConfig`. The program comes from `<base>/claude-code/<pin>/claude` and must match the fingerprint. Take `--sha256` from the checksum the official release publishes (or from the one download you checked yourself), never from the file already in that folder: the orchestrate account can write there, so its own fingerprint proves only that it didn't change after you read it. The hooks come from the copy's own modules; `claude-code` and `hooks` join `keep`. No update, no flip, no job touched, every other file unchanged. Safe to run again: a second run finishes a cut-off one. `keep` carries the hooks across an update as they are, so an update that changes a hook makes review launches refuse by name until this runs again | yes |
| `sudo /usr/local/bin/node setup.mjs bob --from <a Bob checkout> --commit <40-hex sha>` (`--dry-run` first, without sudo) | the Bob method folder the sessions read and its pinned file list, together, from one commit (launch check 13; L994, L995; `bob-manifest.mjs`). git runs as the owner on `--from`, with replace refs off; root only reads the raw objects it prints and checks each against its id, walking the commit's folders itself, so what is installed is exactly what `--commit` names, whoever can write that checkout's git (PR-1 r1 M1). The commit must be a full 40-hex commit present there. Into `<base>/bob` (orchestrate's, 0755; its files root's) go the commit's files, less any `SKILL.md` and anything under a `skill/` or `skills/` folder (any case), as check 13 refuses them; a link, another repository (submodule) or two names that would land on one another on a disk that ignores case is refused before any change. The list is each file's sha256 as read back from the new folder, written to the copy's `bob-manifest.json` with the commit in `bob-commit.txt` (root's, 0644, both added to the updater's keep). Everything new is made beside the old first; a failing step puts the old folder back, so the old pair stays in force; a crash between the two renames leaves a pair check 13 refuses, and the next run puts it right. After a crash between the folder and the list, the next run keeps whichever folder matches the list in force. The check after a run compares the recorded commit with `--commit` and checks the updater's keep holds both names. Don't run it while the updater job is mid-update: an update that read the old keep list would leave the list behind (unload the updater job first: `daemons unload --only <its job>`, then load it again after); `add-to-install` has the same window (#243). The top folder is orchestrate's (layout.mjs), so orchestrate can rename a top-level file even though the files are root's; check 13 at each launch is what catches that. `review-config` names `bobManifest` only once the list is there. Changing Bob means running it again. The worker runner does not read the list yet (its config has no `bobManifest` field until the check-12 change); no setup step builds its config | yes |
| `sudo /usr/local/bin/node setup.mjs managed-settings` (`--dry-run` first) | the machine-wide production guard (L1031, L1044): puts `/Library/Application Support/ClaudeCode/managed-settings.json` in place, whose one hook runs `<base>/machine-wide-guard/production-write-guard.mjs --machine-wide --snapshot <base>/machine-wide-guard/rules.json` for **every Claude session on this Mac, the owner's own included**. It blocks production names only (L1044 M1): a production settings file from the runner config's `rules` named on a file tool's path or in a command, a production program and a production host. **A production program is refused by default (#487 r5, L1075):** any word of the raw line, here-document bodies and `$(…)` included, naming one blocks the line, unless the whole line is one of three allowed shapes: (1) one `git commit` / `git tag` / `gh pr|issue create|comment|edit` whose words are literal text, its message from a quoted here-document (`-F - <<'EOF'`, or `-m "$(cat <<'EOF'` … `EOF` / `)"` with nothing else inside) or a literal `-m '…'`; (2) one `grep` / `rg` / `ag` with literal words, piped into `head`, `tail`, `wc`, `sort` or `uniq` at most (no `rg --pre`); (3) one `command -v` / `which` / `type` with plain names. Nothing else may be on the line (no `;`, `&&`, `||`, other pipe, redirection, second `$(…)` or backtick). A slashed word that is an existing folder or a file no one may run names no program (`pnpm exec vitest src/lib/supabase`, `for f in supabase/migrations/*.sql`), but `./<p>`, `../<p>` and `…bin/<p>` always count, and so does a relative path that does not exist. The trade, accepted knowingly: `npm i vercel`, `ls supabase`, `git grep vercel`, `command -v vercel || npm i -g vercel` and inline code naming one (`python3 - <<EOF … from supabase import …`) are refused on this Mac: run them in a Terminal window, or write the code to a file. The block names the allowed shapes and the `sudo rm` way out. There are no runner or text-only lists to keep up (r2–r4 grew them; L1075 retired them). A wildcard is judged in the folder the shell expands it in only when that is certain: in the line's first command, unquoted, with no folder change (`cd`, `pushd`, `chdir`, `z`) and no `find`/`rsync`/`git` and the like, so `ls -d .*` in a project passes; otherwise by name alone (#487 r2 m1, r4 m1). It never applies the role guard's other shell rules, so everyday commands naming no production program (`$(…)`, loops, `./script`, `bash run-slot.sh`) run as before; a name built at run time (`$VAR`, `$(printf …)`, `${x##*/}`) is not seen (the ruled trade; role sessions keep the full role guard). **The guard has its own folder** `<base>/machine-wide-guard` (root's 0755; the guard script, `lib.mjs`, `snapshot.mjs` and `rules.json`, each root's 0644), outside `<base>/install`, so no reinstall or update touches it (L1044 M2). In order, refusing at the first step that fails, with nothing live changed: (1) copies the three scripts from the installed copy's `hooks/` and writes the rules copy (the `production` block alone) into a side folder `machine-wide-guard/.next`, and reads them back with the guard's own checks (root's alone, every folder above root's, no link, one name, the same bytes); (2) runs the guard there: a harmless call must pass and a production call must be blocked by the guard's own rule (a crash is not a block); (3) moves the files into the folder, then reads back and runs the guard where it now lives; (4) only then writes `managed-settings.json` (root:wheel 0644), and the after-check runs launch check 10 itself and checks every file's owner and mode, that the copy holds the runner config's production rules now, and that the hook names this folder. Refused, untouched: a `managed-settings.json` setup did not write; a config whose `rules` are malformed; the guard's scripts or node not root's. A copy the guard can't read blocks **every** call and names the way out (below); so does a guard script that can't run at all. Run it after `add-to-install` (it copies the guard from the installed copy), and **again after any change to the runner config's `rules`** or to the guard's code on main (`--dry-run` says "nothing to do: already installed" when neither changed) | yes |
| `/usr/local/bin/node setup.mjs check-install --config <file> [--main <commit>] [--watch-only]` | read only (`--watch-only` leaves out the review runner's lines, its role-to-user map and files, as the watch job's start gate does, L1026): the link is root's; the copy and every folder above it are root's alone; the commit stamp; **no access list on any install folder**; `review.json` names this copy and what it names exists. Once the config names `hostLockPath`, a last line points to `check-dispatcher` | no |
| `/usr/local/bin/node setup.mjs check-dispatcher --config <file>`, or with sudo | read only: the Dispatcher's lines (below). Its own command, so a host.lock problem never stops `daemons load --only <job>` for another job, or the watch cutover, which wait on check-install | no; sudo for the host.lock read |
| `/usr/local/bin/node setup.mjs dispatcher-keys --config <file>` | read only: prints the Dispatcher config's ten worker and cleanup keys as JSON, from this config: `reviewRoot` (`<base>/review`), `mirror` (`<base>/mirror`), `sealRoot` (`<base>/seals`), `outboxRoot` (`<base>/outboxes`, the top folder), `copiesRoot` (`<base>/worker-copies`, the top folder), `hostLockPath`, and `hostLockUid` (the owner's Mac user id, read on this Mac: the Dispatcher reads host.lock only when the file it opened is that user's). Also `workerRequestsDir` (`<base>/worker-runner/requests`), `workerStatusFile` (`<base>/worker-runner/runner/status.json`) and `workerUid` (`builder`'s user id: the worker runner runs as `builder`, L1079; the owner's id is refused). Without `hostLockPath`, or with no such owner on this Mac, it says so and exits 1 | no |
| `sudo /usr/local/bin/node setup.mjs daemons place` | writes the config's job files (three, and the watch, robot and Dispatcher jobs when it has them) into `/Library/LaunchDaemons` (root:wheel 0644, exactly what `review-daemons.mjs` builds), each written whole beside its name and renamed over it. launchd starts every job file there at boot, with no `load` to refuse it, so `place` refuses on exactly the checks `load` makes for the jobs it places (the install check, and each optional job's own checks below) | yes |
| `sudo /usr/local/bin/node setup.mjs daemons load` / `unload` | `launchctl bootstrap` / `bootout` for each job not yet loaded / loaded; load refuses unless the install check passes and the job files are there; a job loaded from an older file is taken out and loaded again (`load` records each file's fingerprint in `<base>/install/loaded-jobs.json`, root's); unload with nothing loaded is not an error | yes |
| `/usr/local/bin/node setup.mjs daemons list` / `check` | read only: `list` shows loaded or not, state and last exit. `check` FAILs on: a job file wrong or missing; a leftover job file under another label; a job not loaded; a job loaded from an older file than the one on disk; a job whose last run did not end with exit 0; a job whose current run has been going over 30 minutes (a hung run keeps the last exit green); `ps` answering with something unreadable counts as a FAIL, `ps` printing nothing (the run ended meanwhile) does not. It cannot see a job loaded under an old label whose file is gone: `daemons unload` under the old label first. Changing the label, `review.json` or the owner's home folder needs `daemons unload`, the change, `place`, `load` | no |

**The way out of the machine-wide guard (L1031 guard c).** Every Claude session on this Mac runs the guard, so a broken rules copy
stops them all, this one included, and Claude can't undo it. To switch it off:
1. Open the **Terminal** app (not Claude).
2. Paste, press Return, and type the Mac password when asked:
   ```
   sudo rm "/Library/Application Support/ClaudeCode/managed-settings.json"
   ```
   This removes the machine-wide settings file, so Claude stops running the guard.
3. Start Claude again. When the cause is fixed, `sudo /usr/local/bin/node setup.mjs managed-settings` puts the guard back.

**A reinstall and the machine-wide guard (L1044 M2).** The guard runs from its own folder, `<base>/machine-wide-guard`, not from the
installed copy, so removing `<base>/install` (Part 6's reinstall) leaves it running unchanged, with the rules it was last given: every
session stays guarded through the reinstall and nothing is locked out. After `add-to-install`, run `managed-settings` again only if the
rules or the guard's code changed; `managed-settings --dry-run` says whether it is needed, and the after-check names each guard file that
differs from the installed one (#487 r2 m3). If the guard's folder is ever removed by
hand, every Claude session is blocked with the way out above.

**The Dispatcher's lines: check-dispatcher (L748).** The config's `hostLockPath` is the full path of the owner's `host.lock`,
in the owner's home (`/Users/<owner>/...`; spaces are fine), or, as the owner's copier's copy, exactly
`<base>/host-lock/host.lock` (L1210; no other place under the base). check-dispatcher says:
- the review runner's folder holds its `launches` folder (the runner makes it on its first run; the Dispatcher won't start without it);
- with a `dispatcher` entry, the `dispatcher.json` the job reads (the copy's, or the base's until there is a copy) names
  `outboxRoot` and `copiesRoot` as exactly the top roots (L871). A missing key, another path, or a product's own folder
  under the root (every outbox or copy would be looked for one level too deep) FAILs, by name. An
  existing `dispatcher.json` without them won't start the Dispatcher until `dispatcher-config` is run again;
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
| `sudo /usr/local/bin/node setup.mjs users-folders` (same command) | also makes `<base>/host-lock` (the owner's, 0755, no access list; L1210): the owner's host.lock copier (`host-lock-copy.mjs`, run as the owner) writes `host.lock` and its stamp `host.lock.copied` there, 0644; `orchestrate` reads them, and no one but the owner writes. Set `hostLockPath` to `<base>/host-lock/host.lock` with `hostLockSource` | yes |
| `sudo /usr/local/bin/node setup.mjs users-folders` (same command) | also makes `<base>/watch` (orchestrate's, 0700: the runner's log and rules draft) and `<base>/watch-notes` (the owner's, 0755: the written explanations; only the owner writes, orchestrate and the summary read) (R-0b-122) | yes |
| `sudo /usr/local/bin/node setup.mjs proposals` | makes `proposalsParent` (default `/Users/Shared/orchestrate-proposals`: root's, **0711**) and one folder per product (the owner's, **0700**, one access-list entry for `orchestrate`: list/search/read, inherited). Runs behind the same folder-chain wall as every root command; the folder the parent sits in must be root's and either written by no one else or sticky (as the Mac's own `/Users/Shared` is), and the parent itself root's and not writable by others unless sticky. A file moved in from elsewhere may not be readable by `orchestrate` (it keeps its old owner and mode): copy it in instead. | yes |
| `/usr/local/bin/node setup.mjs check-proposals` | read only: owner, mode, exact access list; with `sudo` also: the owner can write, `orchestrate` reads and cannot write, `review` cannot read | no (sudo for proofs) |
| `sudo /usr/local/bin/node setup.mjs safe-directory` / `check-safe-directory` | runs `git config --global --add safe.directory <base>/mirror` **as the owner** (root never writes into their home). It reads what their git trusts from every settings file it reads (system, global, anything they include), and refuses if any entry has a `*` in it (`*`, `/path/*`): remove the line yourself where it lives. The check FAILs on a `*` even next to the mirror | yes |
| `sudo /usr/local/bin/node setup.mjs daemons reload-account` | refuses (no steps, exit 1) unless the install check passes, as `daemons load` does. Already loaded from the file as built: nothing to do, and its closing check still runs. Otherwise, if the `review-account` job is loaded: rewrite its file (carries `--install <copy>`), unload, load, record, and read back that it is loaded. Not loaded (never loaded, or an earlier reload stopped after the unload): it says plainly that the account job is not loaded and to run `daemons load`, exit 1, never "done". A failed load during the reload stops with that one instruction | yes |
| `sudo /usr/local/bin/node setup.mjs prove-token` | proves the token **cannot write pull requests** against the repository the config names (`"watch": { "repo": "owner/name" }`; never typed on the command line). The token file is looked at first without following links (orchestrate's own plain 0600 file), then read **as orchestrate** (`sudo -H -u orchestrate cat`). Then: the repository is private and not archived; listing open pull requests works; a no-op change to an open one is refused with GitHub's "this token may not" answer (a rate limit or any other 403 is not proof); and it makes one real read of each kind the watch job makes (`WATCH_READS` in `modules/M6-merge-gate/watch-only.mjs`), on main's latest commit with a pull request, so it stops if the key lacks one, or if no such commit is found among main's latest 50. A read GitHub refused with a 403 (not a rate limit) or a 404 says to give the key that permission; a 429, a rate-limit 403, a 5xx, no answer or an empty answer says GitHub didn't answer properly and to run it again; each is a FAIL. The check runs, which the job reads with the watcher App's token (L624), are proven with that token: as `orchestrate`, the installed copy's `watch-run.mjs checks` mints it through `token.mjs` from the config's `watch.app` (the job's own arguments) and reads the check runs on the same pull request's head; no App in the config, no key file, a failed mint or a failed read is a FAIL that says which, and with no commit to try it on it is NOT TRIED (not a pass). The App's token stays inside that process. Output has only fixed sentences and numbers, never a token. **It does not prove the token cannot change code or that it reaches one repository**: after a PASS it prints what to check by eye on GitHub's token page (one repository; Contents, Pull requests and Commit statuses all read-only; nothing else; not Checks, which the watcher App holds) | yes (reads the file as orchestrate) |
| `sudo -k -u orchestrate /usr/local/bin/node setup.mjs approve-rules <product> [--dry-run]` | the owner approves the rules version now on the product's GitHub `main`, for the Dispatcher's rules reader (M10's approval list, `approved-rules.json` in the Dispatcher's `rulesStateDir`; L1127). Run from the owner's own login, in the Terminal app: it refuses unless it runs as `orchestrate` through sudo by the owner of root's setup config. The guard is sudo asking the owner's password (`-k` makes it ask every time): only `orchestrate` can write the list. SUDO_UID and the retyped name are second checks against a mistaken run, not guards: a script can set one and answer the other through a pseudo-terminal (L1132 m1). It reads `main`'s commit and its `orchestrate/policy.yaml` itself (read only, the Dispatcher's token), checks the file as the reader does, and shows the product, the repository, the commit, the blob, whether it parses and M10's module checks, what the list holds, and the file's first 25 lines. Then the product's name must be typed again at the terminal (standard input not a terminal, no terminal, or anything else, is a no). `main` is read again (moved: refused) and the list again (changed: refused); the blob is added at the end of the product's list in a new private file renamed over the old, and the reader's own check must then approve it. Already last on the list: nothing to do. A version the reader holds that the list doesn't name is refused (the reader could never move forward from it), and so is a last good copy that can't be read. `--dry-run` stops before the question. Never as root, never `--config` | no (sudo -k -u orchestrate) |
| `sudo /usr/local/bin/node setup.mjs products-entry <product> [--dry-run]` | root adds the test product's line to the Dispatcher's `products.json` (its `dispatcher` entry's `productsFile`; L1199, L1200), built from root's setup config only, never typed by hand: `product` one of `products`, `owner`/`repo` from `github.repos.<product>` (`"owner/name"`), `joe_github_id` from `github.ownerId` (the owner's GitHub id, a number; never read from the product's repository, whose rules it is the trust root for). Before writing, it reads `main`'s commit and its `orchestrate/policy.yaml` (read only, approve-rules' own read, through the token file the `dispatcher` entry names) and prints both, so the owner can match them to what `approve-rules` shows next. It refuses unless those rules parse and say `product.test_product: true` (the test product only, as the worker runner's gate) and their `accounts.joe.github_id` is `github.ownerId`; any read or parse that fails refuses, with no fallback. That read is a filter, not an approval: nothing goes into the rules state, and the worker runner still checks the approved rules at every start. The list's folder must be root's or orchestrate's, written by no one else, with no access list, and every folder above it root's alone. The list as it is must be a plain file of root's or orchestrate's that no one else can write and that the reader takes; another product's line is kept as written (with any fields of its own), a different line for this product is refused (it only adds). The new list is a root:wheel 0644 file renamed over the old one (orchestrate reads it and can't edit it in place; it owns the folder, `<base>/private`, so it could replace the file: the same trust as before, L1212), after the list is read again unchanged, and read back through the reader. Already there: nothing to do. `--dry-run` stops before writing. Never `--config` | yes |
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

### Where the builder sessions' sign-in lives (L1261)
**Why.** The worker sessions run as the hidden `builder` user, which never logs in to macOS, so it has no login Keychain:
`/login` in a builder session fails with "A keychain cannot be found to store builder". Joe's decision (L1261, not to be
revisited): a long-lived Claude sign-in token, in a file only `builder` can read, handed by the worker runner to each
session's claude in its environment (`CLAUDE_CODE_OAUTH_TOKEN`).

**Where.** `<base>/builder-signin/claude-signin` (layout.mjs `builderSigninPath`): builder's own 0600 file, one name, in
builder's own 0700 folder (`users-folders` makes it), right under the base, which is root's, as is every folder above it.
It is not in `keys/` (orchestrate's), not in the worker copies, and not in builder's home (the sessions' HOME). Every
worker session's settings deny the folder (worker-config puts it on the deny list and in the worker rules' `secrets.paths`,
so the secret-file hook refuses it too).

**Make it, or replace it** (each step on the Mini):
1. In a Terminal window, as yourself (not sudo): `claude setup-token`. It opens the browser to sign in and prints a
   long-lived token (it starts `sk-ant-oat`). Copy it. Make it on the account the workers should spend.
2. In the same window, from the installed copy: `sudo /usr/local/bin/node setup.mjs builder-signin` (try `--dry-run` first: it reads
   nothing). Paste the token at the prompt; nothing shows as you paste. It is checked for shape (a wrong paste is refused
   and not repeated), then saved whole or not at all. The same token again changes nothing.
3. `sudo /usr/local/bin/node setup.mjs check-builder-signin` (or `sudo /usr/local/bin/node setup.mjs daemons check --only worker-runner`, which shows
   the same row): the folder, owner, mode, size and access list; the token itself is never opened.
4. After a setup update that adds this (L1261), on a Mac already set up: `sudo /usr/local/bin/node setup.mjs users-folders`
   first (it makes the sign-in's folder, which step 2 needs), then `sudo /usr/local/bin/node setup.mjs worker-config` again,
   so the runner's config names the file and the new deny entries; `daemons check` says so until then.
5. The live proof, as builder: `sudo -H -u builder <installRoot>/bin/node <installRoot>/setup/live-proofs/builder-signin.mjs --config <installRoot>/worker-runner.json`.
   It starts the pinned claude once with no tools and asks it to reply OK; PASS means the sign-in works there.

**How the runner uses it.** Before each start and each lock-down job (the install and save-work runs), the runner, as
builder, reads the file fresh through one handle without following a link, and refuses it unless it and its folder are
builder's own (0600, 0700, one name), every folder above is root's alone, and it holds one token. Any problem holds the
start, told once in the runner's log per reason (and once when it reads fine). The token goes into that claude's
environment, never onto a command line (`ps` shows command lines to every Mac user) and never into a log.

**Who can read it (accepted, L1261).** Anything running as `builder` can read the token: every worker session, and every
program one runs, including the lock-down claude's install and test commands and any third-party package script they
run. They inherit it in their environment, and the file is `builder`'s own anyway. What limits where it can go is the
walls: the `builder` user itself (another Mac user's `ps` does not show `builder`'s environment; only `builder` and root
can), the network wall, and the deny lists (every session's settings and the secret-file hook refuse the file's folder).
Possible later narrowing, not adopted: Claude Code's subprocess environment scrub (it forces the permission mode back to
default) and handing the token on an open file instead (unproven on the pin). Both were read in a newer release than
the pin and expire on upgrade; which release, and the dates, are in wiring/builder-signin.mjs (the one place they are kept).

**Accounts.** The workers ignore the owner's account switch (a/b): they run in account a's folder on whichever account
made the token.
**A lapsed or revoked token** shows up only when a session starts (its claude fails to sign in) or when the live proof
runs: the runner checks the file, not the token.

**Revoke it.** On claude.ai, in the account's settings, where its sign-ins and tokens are listed (the place as of the
time of writing; re-check); then make a new one as above. Deleting the file stops new starts at once.
**How long it lasts.** About a year, per Anthropic's docs at the time of writing; re-check. The runner checks the file,
not whether the token still works: a lapsed or revoked token passes the file check and the session's claude then fails
to sign in. Replace it as above.

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
| `sudo bash <a private copy of the reviewed watch-cutover.sh>` the first time; after that also `sudo bash /Library/orchestrate/install/orchestrate/setup/watch-cutover.sh` | the watch job's cutover to the watcher App in one paste (L643): the updater once (b), `watch-app` with the App and the rules pin (a), `watch-rules` from the copy in place after its fingerprint is checked (a2), `daemons place` and `load --only watch-only` (c), then `check-watch-rules`, `check-install --watch-only` and `daemons check --only watch-only` (d); each step's dry run first; it stops at the first FAIL with one plain line. It then starts one watch pass and shows the end of the job's logs, failing on an HTTP 403, a pass that did not end with exit 0, or one still running after 3 minutes. Its values (the App, the installation, the key name, the pin) are at its top. Run from outside the copy (the first time, since the copy before step b has no such file), it runs step b, then hands over to the copy's own file, only when that file is byte for byte the one bash started from (resolved before step b); root never runs steps a to d from a file anyone else can write, and they all use the copy the link named when they began. `watch-cutover.harness.sh` runs it against a stand-in install (its test runs that). It never reads the key. |
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

The robot App (L600, L727): `robot.json` may name it with four keys, all or none (the wiring's own `appProblem`):
`appId` (the App's id), `appInstallation` (its installation's number on the alert repository), `alertRepo` (owner/name:
the repository where alert issues go, where the App is installed; never Bob's repository) and `alertOwner` (the GitHub
login the issues are assigned to). Some but not all, or a bad value: `place` and `load` refuse and `check` FAILs. With all four, the
App's key must be in the robot key folder under token.mjs's default name, `<base>/keys/robot-app.pem`: orchestrate's own
plain 0600 file of a key's size, no access list (the same rule as the watcher App's key). The mode must be exactly 0600:
0400 is refused too, so a key copied in read-only needs `chmod 600`. Missing or open: `place` and `load` refuse
(no alert, not even the store-free one, could be sent) and `check` FAILs (with sudo; without, the key is listed as
NEEDS ROOT and check does not exit 0; a `--dry-run` of place or load without sudo prints it as NOT CHECKED). With none of the four, no key is asked for and the deliver pass refuses as not
wired, so alerts stay queued.
Setup checks the key file's owner, mode and size only; it never reads the key, so it does not prove the key is the robot
App's or that a token can be minted from it. A wrong key (another App's, or one replaced later) passes `load` and `check`
and fails at the job's first mint. After any key swap, confirm one test alert reaches the phone, as at first setup.

Loading it on the always-on Mac is an owner-run step. It waits for the robot's config (the Dispatcher's keys, C) and
for the passes it runs to be wired.

## Part 6 — the Dispatcher's config and job (R-0b-162; LEAD-CALLS L748, L757)

`dispatcher-setup.mjs`. Off unless the setup config has a `dispatcher` entry, which names what setup can't know itself and
nothing else: `{ "product": "<one of products>" }`, and, only to choose other places than setup's, `productsFile` (M10's
products.json; default `<base>/private/products.json`, which root puts there with `products-entry`), `rulesStateDir` (M10's state folder; default
`<base>/private/rules-state`), `tokenFile` (orchestrate's read-only GitHub token file; default `<base>/keys/watch-only-token`,
where `token` puts it) and `approvalsStateDir` (M2's state folder; default `<base>/private/approvals`). `dispatcher-config`
prints the four paths it uses and which are setup's defaults, so the robot's `robot.json` can name the same ones. Plus an
optional `runDeadlineMs` of at most the Dispatcher's default (`RUN_DEADLINE_MS` in M11 `main.mjs`, which the robot job
judges it by). Each path is full and written plainly, outside the install. The entry needs `hostLockPath` too.
Every other key of the Dispatcher's config setup writes itself, from the layout: the copy and its wiring, the lock
(`<base>/home/orchestrate/dispatcher.lock`, in orchestrate's home, which only it can write), the Record (`<base>/products/<product>/store`,
owned by `orchestrate`, whose uid is `ownerUid`), the review runner's requests folder, status file, user and log, and the
keys `dispatcher-keys` prints (among them `hostLockUid`, the owner's Mac user id: the Dispatcher reads host.lock only when the
file it opened is the owner's).
`outboxRoot` and `copiesRoot` (L871) are the TOP `<base>/outboxes` and `<base>/worker-copies`, the folders `users-folders`
makes, never a product's own folder under them: the Dispatcher's pass and undo-starts look for a session's outbox at
`<outboxRoot>/<product>/<role>/<session>`, and cleanup for a copy at `<copiesRoot>/<product>/<card>`
(`shared/product-paths.mjs`). Their values come from `layout.mjs` (`dispatcherKeys`), the one place. A key setup writes that
its own wiring (`wiring/dispatcher-wiring.mjs` beside it) doesn't take is refused, never dropped (the Dispatcher refuses to
start on an unknown key). **An existing `dispatcher.json` without the two keys won't start the Dispatcher until
`dispatcher-config` is run again**; check-dispatcher says exactly that. When a `dispatcher.json` differs from what
`dispatcher-config` writes, `dispatcher-config`'s own check, `daemons place` and `load`, and `daemons check` name the keys
that are missing, extra or other than setup's (the first five).

| Command | What it does | Root? |
|---|---|---|
| `sudo node setup.mjs dispatcher-config` (`--dry-run`) | writes `<base>/dispatcher.json` (root:wheel 0644), every key `wiring/dispatcher-wiring.mjs` takes, and nothing else (a `dispatcher.json` written before `outboxRoot` and `copiesRoot` were keys, L887, is refused at start until this is run again); once there is an installed copy that keeps it (and is root's alone), the copy's `dispatcher.json` as well. Each file is written whole beside its name and renamed over it, so a reader never finds it missing or half written. Twice does nothing. It closes with a check of both. While the Dispatcher job is loaded or placed (it reads the copy's file on every pass, and starts at boot), it first makes the checks `load` makes against the new config: the robot match and check-dispatcher. If either fails it changes neither file, and says to put that right, or to take the job out (`daemons unload --only dispatcher`, delete its job file), run it again, then place and load. The owner's Mac user (host.lock's owner) may not have the uid of root, orchestrate, review or pages | yes |
| `sudo node setup.mjs worker-config` (`--dry-run`) | with a `workerRunner` entry (`{ "product": "<one of products>" }`, L1112) and the `dispatcher` entry: writes the installed copy's `worker-runner.json` (root:wheel 0644), the config `wiring/runner-main.mjs` reads as `builder`. Nothing in it is typed: the folders come from the layout (the worker runner's three folders, the top outbox and copies roots, the builder's home, the product's Record, the rules snapshot root's `worker-rules` job writes, `worker-rules/<product>.json`, with `snapshotOwner` 0 so every hook takes it only as root's); the uids from the Mac; the rules, the pin and claude, the hooks, the machine-wide file, the Bob folder and list, the account copy and check 12's module from the copy's full `review.json` (after `review-config` and `add-to-install`), which must name this product's Record; the repository from the Dispatcher's `products.json`. The sessions' deny list adds the robot keys, the private folder, the Dispatcher's rules-state and approvals folders and the owner's home as slip-catchers (the wall is ownership and mode). It refuses, changing nothing, when any source is missing, when the copy's `updater.json` can't be read, or when the runner's own check would refuse the result. Written into the copy only, then `worker-runner.json` is added to the copy's `updater.json` keep so every update carries it: `install` neither seeds nor keeps it (it is built from the full `review.json`, which only exists after `install`, and the updater refuses a keep item the install did not seed), so the order is `install` → `review-config` → `add-to-install` → `worker-config`. The file goes in before the keep list, each whole or not at all: a run cut off between them leaves the file not yet kept (updates are fine; `daemons place` and `load` refuse), and running it again finishes it. Don't run it while the updater job is mid-update (as for `bob` and `add-to-install`). The runner reads it at start, so a loaded job takes a change after `daemons unload --only worker-runner` and `load`; `daemons place` and `load` refuse while the copy's file is not the one this command writes now, or its updater does not keep it | yes |
| `sudo node setup.mjs install` | with the entry, refuses unless `<base>/dispatcher.json` is there, root's 0644, and the config this setup writes now; then carries it into the copy, and the updater keeps it on every update (it is one of `keep`), as `review.json` | yes |
| `sudo node setup.mjs daemons place` / `load` / `check` (also `--only dispatcher`) | a job `<label>.dispatcher`: runs as `orchestrate`, from the installed copy, `modules/M11-dispatcher/main.mjs <copy>/dispatcher.json`, every 60 s and once at load, `HOME` orchestrate's home and `Umask 63`, logs `dispatcher.out.log` / `dispatcher.err.log` (orchestrate's). Built by M11's `loginJobPlist`, as the robot job. `load` refuses, and `check` FAILs, unless the copy's `dispatcher.json` is root's alone and exactly what `dispatcher-config` writes now, and the copy keeps it. With the robot job on, the copy's `robot.json` must name the same Record (product, Record folder and owner, products file, rules state, token file) and the Dispatcher's lock as its `dispatcherLockFile`, which is also checked when only the robot job is loaded or checked. The Dispatcher's lock's folder must be orchestrate's, not writable by others, under root's folders. `place` and `load` also run check-dispatcher first and refuse on any FAIL in it, and `check` FAILs on one. A NOT TRIED line (host.lock in a folder macOS guards) does not stop the load, because only the job's own read can prove it. `daemons check` reads a Dispatcher run as stuck only past its deadline and the watchdog's margin (about 35 minutes). `daemons unload --only dispatcher` works even after the entry is gone | yes |
| `sudo node setup.mjs dispatcher-config`, then `daemons place` / `load` / `check` (also `--only sensors`) | the Sensors job, on exactly when the Dispatcher is (L1049). `dispatcher-config` also writes `<base>/sensors.json` and the copy's `sensors.json` (root:wheel 0644, written the same way, twice does nothing): every key `wiring/sensors-wiring.mjs` takes, the Dispatcher's Record, products file, rules state and token file, the owner's answer file `<base>/owner-answer/owner-answer.json` and the owner's uid. The job `<label>.sensors` runs as `orchestrate`, `modules/M12-sensors/loop.mjs <copy>/sensors.json`, every 60 s and once at load, `HOME` orchestrate's home and `Umask 63`, its own logs. `load` refuses, and `check` FAILs, unless the copy's `sensors.json` is exactly what `dispatcher-config` writes now, root's alone and kept by the updater, and check-dispatcher passes (the Sensors write the Record the Dispatcher reads). With the Sensors in the list, `daemons check` also FAILs unless the owner's answer is fresh (the owner's own plain file, not writable by others, written within 10 minutes), and gives a WARNING when it says no one is signed in | yes |
| `node setup.mjs owner-job place` / `load` / `unload` / `check`, **as the owner, without sudo** | the owner's answer job (L1051), in the owner's own login session, never root's or orchestrate's: `~/Library/LaunchAgents/<label>.owner-answer.plist` (the owner's, 0644), `wiring/owner-answer.mjs --to <base>/owner-answer/owner-answer.json` from the installed copy, every 300 s and at load, `PATH` with `~/.local/bin` first (where `claude` is), logs `~/Library/Logs/orchestrate-owner-answer.*.log`. It runs `claude` as the owner to read who is signed in and the usage, and writes only the answer. `place` writes the file whole and, if the job is loaded, loads it again from the new file; `load` needs the owner's login session open; `check` FAILs on a file that is not exactly the built one, a job not loaded, a last exit that is not 0, or an answer that is not fresh. Root is refused (root never writes in the owner's home), and so is any user but the owner | no |

A copy installed before the entry existed has an updater that does not keep `dispatcher.json`, and one installed before
`"robot": true` does not keep `robot.json`: an updater's keep list is fixed at the first install. `install --dry-run` (and
`install`) on such a copy, and `dispatcher-config --dry-run`, print a WARNING naming the files it won't keep and the way out
(L1029 B); `check-dispatcher` and `daemons load` refuse a copy that won't keep `dispatcher.json`. The copy must be installed again, and **that reinstall comes first**,
before the pinned Claude Code and `add-to-install`, since a new install throws both away: unload the jobs, remove
`<base>/install`, put the `--for-install` `review.json` at `runnerConfig`, run `install`, then put the full `review.json` back
and run `add-to-install` (Part 2's order, steps 3 to 5), then `worker-config` and `bob` again, if set up (a new install
throws away `worker-runner.json` and the Bob list too). The machine-wide guard, if placed, keeps running from its own folder
through the reinstall; after `add-to-install`, run `managed-settings` again if the guard's code changed (Part 2, "A reinstall and the
machine-wide guard").

**On the always-on Mac (owner-run steps):**
1. Add `hostLockPath` and the `dispatcher` entry to the setup config, and put it in place.
2. `sudo node setup.mjs users-folders`, then `sudo node setup.mjs dispatcher-config`.
3. Install (again, if the copy is older than the entry), then `sudo node setup.mjs check-install` and `sudo node setup.mjs check-dispatcher`.
   check-dispatcher fails until the review runner has made its `launches` folder on its first run, and a full `daemons place`
   or `load` refuses until check-dispatcher passes. So on a Mac whose runner has never run:
   `sudo node setup.mjs daemons place --only review-runner`, then `sudo node setup.mjs daemons load --only review-runner`,
   wait a minute, and run check-dispatcher again.
4. check-dispatcher passes; then, as the owner, without sudo: `node setup.mjs owner-job place`, `owner-job load`, and after a
   minute `owner-job check` (the answer is fresh). Then `sudo node setup.mjs daemons place`, then `daemons load`, then `daemons check`.
5. Prove the job's own read of host.lock: its log must show no "not known" for host.lock. host.lock stays in the synced
   folder, because the lock between the Macs needs the sync. **If macOS's privacy protection stops the job's read there**,
   the fallback is a small job of the owner's own that copies host.lock to a plain folder outside the guarded ones, with
   `hostLockPath` pointing at the copy (the copy is the owner's file, so the owner check still holds). **The copier** (L1029 E,
   `host-lock-copy.mjs`): add `hostLockSource` (the synced host.lock) to the setup config, and set `hostLockPath` to the copy,
   `<base>/host-lock/host.lock` (L1210). users-folders makes that folder, the owner's, 0755, as it makes `owner-answer`: the
   owner's home is often 0750, which orchestrate can't go into, and the base is not. The same owner's uid writes the copy as
   before; only the place moved. (A folder of the owner's in their home still works when orchestrate can go into every folder
   above it; check-dispatcher's host.lock row FAILs when orchestrate can't read the copy.) The job runs `host-lock-copy.mjs` from the installed copy, so
   install (or update) the copy first. Then, without sudo: `node setup.mjs host-lock-copier > ~/Library/LaunchAgents/<label>.host-lock-copy.plist`
   (it prints the job file; the steps it prints are on stderr), and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.host-lock-copy.plist`.
   Then run `dispatcher-config` again, so the job's `dispatcher.json` names the copy too (with the Dispatcher's job in place,
   that is step 6's sequence); check-dispatcher FAILs while `dispatcher.json` names another `hostLockPath`.
   The job runs as the owner, every 60 s, from the installed copy, with the setup config as its one argument. Each run copies
   the synced file (0644; no copy when the synced file is gone, which the Dispatcher reads as no host claimed) and writes
   a stamp beside the copy (`host.lock.copied`). A run that can't read the synced file writes nothing and says why in
   `host-lock-copy.err.log`, beside the copy. **check-dispatcher FAILs when the stamp is older than 5 minutes** (or missing,
   or not the owner's), so a copier that stopped is told, never read as a current copy; while it FAILs, `daemons place`
   and `load` wait too. **If the log says EPERM**, macOS is guarding the synced folder from the owner's job too. **Never give
   the installed copy's `bin/node` Full Disk Access**: the Dispatcher, robot and watch jobs run that same node as orchestrate,
   so the grant would open Dropbox, the Desktop and Documents to all of them. Instead give the copier a node of its own (L1041):
   1. As the owner, without sudo: `mkdir -m 0700 ~/.orchestrate/bin` and `cp <installRoot>/bin/node ~/.orchestrate/bin/node`,
      then `chmod 0700 ~/.orchestrate/bin/node` (the owner's alone: nothing that runs as orchestrate can run it).
   2. Add `"hostLockCopierNode": "/Users/<owner>/.orchestrate/bin/node"` to the setup config (a full path in the owner's
      home; the config refuses it without `hostLockSource`). Print the job file again with `host-lock-copier`: it refuses
      unless that node is a plain file of the owner's, mode 0700, and the job file then names that node, not the installed one.
   3. Reload the job: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<label>.host-lock-copy.plist`, save the new
      text over it, and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.host-lock-copy.plist`.
   4. System Settings → Privacy & Security → Full Disk Access → + → press Cmd-Shift-G, paste
      `/Users/<owner>/.orchestrate/bin/node`, add it and turn it on. Grant that path only.
   5. Prove both sides on the Mac: a minute later the copier's err log has no new EPERM and check-dispatcher's stamp row
      passes; and the orchestrate jobs' node is still refused the synced file:
      `sudo -u orchestrate <installRoot>/bin/node -e "require('fs').readFileSync(process.argv[1])" "<hostLockSource>"`
      must fail with EPERM. If it reads the file, the grant reached the shared node: remove it and stop.
   When an update changes the installed node, the copier keeps its own until you copy it again (steps 1, 3 and 4; macOS
   may ask again for the new file). The Dispatcher's own refusal of an old or missing copy (no starts, one alert) comes
   with the Dispatcher's change that reads the stamp (L1041); until that lands, check-dispatcher's stamp row is the guard.
6. To change a path the Dispatcher and the robot share while both jobs are in place: `dispatcher-config` refuses, since the
   copy's `robot.json` still names the old one. So: `sudo node setup.mjs daemons unload --only dispatcher`, delete the
   Dispatcher's job file (and a `.<label>.dispatcher.plist.new` beside it, if a cut-off write left one; `daemons check` names
   any such file), change the entry and `robot.json`, then `dispatcher-config`, install, `daemons place`, `daemons load`.

## Part 7 — the secret scanner the push step runs (L1083)

The push step scans every new commit with gitleaks before anything leaves the Mac (`modules/M4-workshop/git/gitleaks.mjs`).
It runs the pinned program by full path, with the Do-plane's own rules and an empty ignore file, and refuses to push
without them. This part puts those three files in place and proves them. The paths are `scannerPaths(cfg)` in
`layout.mjs` (no config key names them): `<base>/scanner/gitleaks`, `gitleaks.toml` and `gitleaksignore`, all root's.
The pin is gitleaks 8.30.1 for Apple silicon (`scanner-setup.mjs` holds both hashes); a new version takes new rules
too, so it is a code change, never a config edit.

1. Download `gitleaks_8.30.1_darwin_arm64.tar.gz` and `gitleaks_8.30.1_checksums.txt` from gitleaks' 8.30.1 release
   page on GitHub, into a new empty folder.
2. In that folder: `shasum -a 256 gitleaks_8.30.1_darwin_arm64.tar.gz` must print
   `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`, the same line the checksums file has for it.
   Anything else: stop.
3. `tar -xzf gitleaks_8.30.1_darwin_arm64.tar.gz gitleaks` takes the program out. Do not run it.
4. `sudo /usr/local/bin/node setup.mjs scanner --from <full path of that gitleaks>` (`--dry-run` first shows the steps).

| Command | What it does | Root? |
|---|---|---|
| `sudo /usr/local/bin/node setup.mjs scanner --from <full path> [--dry-run]` | reads the named program once, refuses it unless its bytes hash to the pin (`ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f`, the program inside the checked tarball), and writes those same bytes as `<base>/scanner/gitleaks` (root:wheel 0755). Beside it, the push step's own rules (`DO_PLANE_TOML`, copied from the code, never retyped) as `gitleaks.toml` and an empty `gitleaksignore`, both root:wheel 0644. A file already exactly right is left; one that drifted (bytes, mode, owner, a second name, an access list) is written again. A scanner folder that is not root's 0755, or has an access list, is refused, never taken over; an empty one of root's (a run cut off before it was secured) is secured again. Then the file rows of `check-scanner` | yes |
| `node setup.mjs check-scanner` | read only, **without sudo** (it runs the downloaded program, which never runs as root; with sudo it refuses). The folder root:wheel 0755; each file root:wheel, its mode, one name, its hash; no access list on any. Only when all of that passes, the push step's own check (`checkScanner`, which the push runs before every scan): the program's hash, owner, mode and one name (a link is not followed), the rules byte for byte, the ignore file empty, and the program run once with `version`, which must say 8.30.1. Anything else FAILs (exit 1) | no |

## Part 8 — the builder wall (R-0b-179; L1149, L1150, L1193, L1215; v2 2026-11-16)

**What it changes.** As root, it turns on the Mac's packet filter (pf) with four rules of its own. Then the `builder`
user, which runs the worker runner and every worker session, can reach on this Mac only its **own** listeners in its own
port range, **47000-47999** (one home: `shared/builder-ports.mjs`). It can't reach the owner's dev servers, databases or
Claude ports, or root's local services, on 127.0.0.1, ::1 or the Mac's own address. Everyone else's traffic is untouched,
except that no other user's listener in 47000-47999 gets anything (L1154). macOS's own `/etc/pf.conf` is never edited:
the rules go into an anchor under the `com.apple/*` one it already has. What it places, all root's:
- the rules file `/private/etc/pf.anchors/orchestrate.builder` (0644);
- `<base>/builder-wall/` (0700), which keeps the pf on-switch's reference number (`pf-token`);
- the job `/Library/LaunchDaemons/<label>.builder-wall.plist` (0644). At load, at boot and every 5 minutes, it loads the
  rules and keeps pf on.

**Why v2 (a port range, not a tag).** v1 marked the builder's packets with a pf tag on the way out and blocked marked
packets on the way in. That tag shape was **disproved on macOS 27.0.1 on 2026-11-16** (Joe's wall-diag runs): a tag set on
the way out of loopback is not seen on the way in, so v1 blocked nothing. pf does see who owns the socket (the sender on
the way out, the receiver on the way in), so v2 tells the builder's traffic by port: on loopback the builder may only
open connections into 47000-47999, and only the builder's own sockets may listen there.

**What it costs.**
- Any server the builder runs that must be reached on loopback has to listen in 47000-47999. The builder can't reach even
  its own listener outside the range: a worker's test that starts a dev server on a port the system picks and then calls
  it will fail. (The read-back proves this cost is paid, row vii.)
- Claude Code's own network proxy listens on a port it picks, outside the range, so builder sessions use the builder's
  allow-list proxy instead (below).
- No other user (the owner included) can use a listener of its own in 47000-47999, or even reach it. `place` refuses
  while one is there; `check` shows a `WARN` row (it fails nothing) if one has started since.
- Builder UDP on loopback stays inside 47000-47999 **both ways**: a builder program can send UDP only to a port in the
  range, so a UDP server of the builder's can't answer a program outside it (the owner's, or a builder program on a port
  the system picked). This was chosen over letting the builder answer (PR #617 review, M1): that rule let a builder
  program hold a two-way UDP conversation with any user's program on a port the system picked. Nothing the builder needs
  is lost: the proxy is TCP, and name lookups go to macOS's own resolver over a local file socket, not loopback UDP.
  `place` refuses if the Mac's ephemeral range (49152-65535) has moved.
- **Not covered: local file sockets (Unix sockets).** pf sees only network traffic. A builder program running outside
  Claude Code's sandbox (a worker's install or test step) can connect to any Unix socket whose file it may write, for
  example a Homebrew Postgres's `/tmp/.s.PGSQL.5432`. Open item for the lead; no code here yet.

**The builder's allow-list proxy** (`builder-proxy.mjs`, setup's `builder-proxy` job, on exactly when the config's
`workerRunner` entry is). It runs as `builder` and listens on 127.0.0.1 and ::1 at two fixed ports in the range: **47000**
for a session's shell, **47001** for a worker's install step. Every role file the worker runner writes points the shell
at it (`httpProxyPort` and `socksProxyPort`, both the same port; one port serves HTTP and SOCKS5). It lets through only
the hosts the session's own settings allow, read from the installed `worker-runner.json` the same way the settings read
them (`render-settings.mjs` `phaseHosts`): the session port the products' hosts, the install port those plus the registry
hosts. It refuses any other host, an IP address in place of a name, a name with a user name or password in it, and a
name whose address is on this Mac or a private network. Ports: a tunnel (an `https://` CONNECT or any SOCKS request) may
go only to 443 or 22 (git over ssh); port 80 is reached only by a plain `http://` request through the HTTP side, whose
request is checked. So a SOCKS client that wants plain HTTP must use the HTTP proxy instead (the same port). It never passes on or writes down
a proxy password, and its log (`<base>/logs/builder-proxy.out.log`) has only the time, port, host, allow or deny, and
bytes; why it stopped or would not start goes to `<base>/logs/builder-proxy.err.log`. It caps connections at 64 at once,
the request head at 16 KB, and each connection at 2 GB each way. A name whose address is one of the Mac's own, or on a
network the Mac is on, is refused too. Plain `http://` requests: the `Host` line must name the same host as the address
(or the request is refused), and one connection carries one request (a second one sent on it is refused, never passed on).
A request head with a lone line-break character, a line that starts with a space or tab, or a field name that is not
plain letters, digits and the usual punctuation followed straight by its colon is refused too. Routing headers that a server might obey in place
of `Host` (`Forwarded`, `X-Forwarded-*`, `X-Host`, `X-Original-URL`, `X-Rewrite-URL`) are dropped. An `Upgrade` header is
passed on but harmless: `Connection` becomes `close`, and any bytes the program sends after a 101 reply end the connection.
- **What it can't stop (domain fronting).** For `https://` the proxy only opens a tunnel to a listed name; the encrypted
  request inside is the program's own. On a shared delivery network (a CDN) a program can open the tunnel to a listed
  name and ask, inside, for another site served by the same network. Claude Code's own proxy has the same limit; only a
  proxy that decrypts the traffic could see it.
- **What it can't stop (ssh as a relay).** Port 22 is open to every listed host. If a listed host allows ssh port
  forwarding and the session holds a login for it, ssh to that host can carry traffic on to anywhere. The list is
  ours, so keep it to hosts we trust for ssh.
- (checked: claude-code 2.1.316; Principle 9, re-check on upgrade) With both ports set, Claude Code starts no proxy
  of its own and no longer filters by `allowedDomains` (it says so: "will never apply"), so this proxy is the filter.
  Setting only one of the two starts Claude Code's own proxy for the other.
- Claude's own traffic to Anthropic (api.anthropic.com) is **not** affected: the claude program talks to Anthropic itself,
  not from the sandboxed shell and not over loopback, so neither the wall nor this proxy sees it.
- A cost: the proxy can't tell which product's session is asking, so one product's session may reach another product's
  listed hosts (all of them are on the rules' list).
- `sudo /usr/local/bin/node setup.mjs daemons check --only builder-proxy` adds a row per port: listening on 127.0.0.1 and
  [::1], as `builder`, on no other address (NEEDS ROOT without sudo).
- The live proof: `sudo /usr/local/bin/node <base>/install/orchestrate/setup/live-proofs/builder-proxy.mjs --config
  <base>/install/orchestrate/worker-runner.json`, run after the job is loaded. As `builder`, it reaches a listed host
  through the proxy (a), and is refused a host on no list (b). Part (c), going direct from a builder session's sandboxed
  shell fails, says NOT DONE until the builder can sign in to Claude Code (PR #616).

The code, with its known limits, is `builder-wall.mjs` (its header).

**Why it matters for the worker runner.** Before every session start, the worker runner reads the wall's status file
`<base>/builder-wall-status/status.json` (`wiring/wall-gate.mjs`). It holds every start unless that file says ok, for
`builder`'s uid and for this copy's rules, and is at most 10 minutes old (two of the check job's 5-minute beats).
`place` writes that file first. After that, setup's `builder-wall-check` job (`daemons.mjs`, on exactly when the
config's `workerRunner` entry is) rewrites it at load and every 5 minutes. **Until `place` has run, the status never
says ok, and the worker runner starts nothing.**

**When.** Run it after the install and `add-to-install` (Part 2), with the `builder` user made (Part 1, L1079), and
before `daemons load` loads the worker runner. Always run the **installed copy's** script, as below: the status names
the rules of the script that wrote it, and the worker runner compares them with the copy's.

1. **The dry run, without sudo.** `/usr/local/bin/node <base>/install/orchestrate/setup/builder-wall.mjs place --dry-run`
   prints a `would:` line for each step, changing nothing: the folder check, the rules file (for `builder`'s uid), the
   token folder, the job file, and the job's load. A `refused:` line says why it won't run; with one, nothing would change.
2. **The real run.** `sudo /usr/local/bin/node <base>/install/orchestrate/setup/builder-wall.mjs place`. It prints a
   `doing:` line per step, then waits up to 15 seconds for the job's first run. Then it reads the wall back, one line per
   row, and writes the status. **Check:** the exit is 0, and the last row line is `all 75 PASS` (`all 63 PASS` on a Mac
   with no address but loopback; one row then says only 127.0.0.1 and ::1 were probed). The read-back counts its own
   rows: one skipped adds a `FAIL  the read-back ran all … of its rows` line. The rows, in order, `<uid>` being `builder`'s:
   - `PASS  the job <label>.builder-wall ran once and finished well (within 15 seconds of loading)`
   - `PASS  /private/etc/pf.anchors/orchestrate.builder is the wall's rules for uid <uid>, root's 0644`
   - `PASS  pf is on (iii)`
   - `PASS  the pf token in <base>/builder-wall/pf-token is held (iii): pf stays on while the job holds it`
   - `PASS  the main ruleset reaches com.apple/* (iv)`
   - `PASS  com.apple/100.orchestrate.builder holds exactly the wall's rules (iv)`
   - `PASS  the Mac's ephemeral port range is inside 49152-65535, clear of the builder's ports (iv)`
   - `PASS  no other user's socket listens in the builder user's ports 47000:47999`. This one row may instead be
     `WARN  … — <the socket, its uid and pid>: the wall cuts it off …`: a program of another user started listening in
     the range after `place`. It fails nothing (it hurts only that program), but move that program to another port.
   - then, for TCP and for UDP, and for each of `IPv4 (127.0.0.1)`, `IPv6 (::1)`, `IPv4 (127.0.0.1, listening on 0.0.0.0)`,
     `IPv6 (::1, listening on ::)` and `this Mac's own address (<address>)`, seven rows for TCP and six for UDP (`<where>`
     is e.g. `TCP IPv4 (127.0.0.1)`):
     `PASS  builder reaches its own listener in its ports on <where> (v; the proxy path)`,
     `PASS  the owner reaches its own listener on <where> (ii)`,
     `PASS  the owner reaches the builder user's listener in its ports on <where> and hears its answer (vi)` (TCP only),
     `PASS  the owner still reaches its own listener on <where> after (i) (ii)`,
     `PASS  builder can NOT reach the owner's listener outside its ports on <where> (i)`,
     `PASS  builder can NOT reach the owner's listener in its ports on <where> (i)`,
     `PASS  builder can NOT reach its own listener outside its ports on <where> (vii; the documented cost)`, and for UDP on
     `IPv4 (127.0.0.1)` and `IPv6 (::1)` one more:
     `PASS  builder, from a port in its ports, can NOT reach the owner's listener on an ephemeral port on <where> (viii)`.

   `place` refuses before changing anything when the Mac's ephemeral port range is not inside 49152-65535, or when a
   program that is not `builder`'s already listens in 47000-47999 (the line names it).
   Any `FAIL` row means the wall did not hold, or blocked the owner or `builder`'s own proxy. `place` then takes the wall
   out again by itself and says what it undid. Its `done:` lines list each step, and a `NOT done:` line names a step to do
   by hand (the way out, below). It writes the status as not ok and exits 1. Nothing stays half on.
3. **The check afterwards.** Once `daemons load` has loaded the `builder-wall-check` job with the worker runner:
   `sudo /usr/local/bin/node setup.mjs daemons check --only builder-wall-check` must print every line PASS. Then, as the owner, without sudo,
   read the status file with the worker runner's own judgment (the same function its gate runs, from the copy, with
   `<base>` filled in twice):
   ```
   C=<base>/install/orchestrate S=<base>/builder-wall-status/status.json U="$(id -u builder)" /usr/local/bin/node --input-type=module -e '
   const { C, S, U } = process.env;
   const { readFileSync } = await import("node:fs");
   const g = await import(C + "/wiring/wall-gate.mjs");
   const w = await import(C + "/setup/builder-wall.mjs");
   const k = await import(C + "/modules/M4-workshop/launcher/install-check.mjs");
   const why = g.wallProblem({ file: S, wall: g.wallFrom(w), uid: Number(U), chain: (p) => k.chainProblem(p, { owner: 0 }), readRoot: (p) => readFileSync(p, "utf8"), now: Date.now });
   console.log(why ? "FAIL  " + why : "PASS  the builder wall status is ok, for builder (uid " + U + ") and the rules of this copy, at most 10 minutes old"); process.exit(why ? 1 : 0);'
   ```
   **Check:** one `PASS` line, exit 0: the file is root's all the way up, ok, for `builder`'s uid, for this copy's rules,
   and at most 10 minutes old. A `FAIL` line gives the reason the worker runner would hold a start. The status `place`
   wrote passes for 10 minutes on its own, so run this after `daemons load` to see the check job's own status. To recheck
   the wall at any time, run `sudo /usr/local/bin/node <base>/install/orchestrate/setup/builder-wall.mjs check`. It runs
   the same read-back (`all 74 PASS`, or `all 62 PASS` with no address but loopback; a `(1 with a WARN)` after it is the
   row above), changes no rule, and writes the status.
4. **The way out** (also printed after every run). With `<label>` and `<base>` from the setup config:
   ```
   sudo launchctl bootout system/<label>.builder-wall
   sudo rm /Library/LaunchDaemons/<label>.builder-wall.plist
   sudo /sbin/pfctl -a com.apple/100.orchestrate.builder -F rules
   sudo /sbin/pfctl -X "$(sudo cat <base>/builder-wall/pf-token)"
   ```
   These unload the job (so it doesn't come back at boot), empty the wall's rules, and release the wall's hold on pf
   (pf stays on only if something else holds it). If `<base>/builder-wall/pf-enable-unread` is there, the job once got no
   readable token from `pfctl -E`. Find that hold with `sudo pfctl -s References` and release it with `sudo pfctl -X <number>`.
   **The worker runner then holds every start** (the check job keeps writing ok false), until the wall is placed again
   or both jobs are unloaded: `sudo /usr/local/bin/node setup.mjs daemons unload --only worker-runner`, then
   `sudo /usr/local/bin/node setup.mjs daemons unload --only builder-wall-check`. The proxy too, once
   the worker runner is unloaded: `sudo /usr/local/bin/node setup.mjs daemons unload --only builder-proxy` (a builder
   session's shell reaches the internet only through it).

| Command | What it does | Root? |
|---|---|---|
| `/usr/local/bin/node <base>/install/orchestrate/setup/builder-wall.mjs place --dry-run` | prints each step `place` would take; changes nothing | no |
| `sudo /usr/local/bin/node <base>/install/orchestrate/setup/builder-wall.mjs place` | puts the rules, the token folder and the job in place, loads the job (which turns pf on and holds it), waits for its first run, reads the wall back and writes the status. Any FAIL takes the wall out again. Safe to run again: what is already right is left, and the job is reloaded | yes |
| `sudo /usr/local/bin/node <base>/install/orchestrate/setup/builder-wall.mjs check` | the read-back alone, and the status. The `builder-wall-check` job runs this every 5 minutes | yes |

## Part 9 — the worker sessions' rules, written by root (L1225, L1226, L1227)

**What it changes.** Setup's `worker-rules` job (`worker-rules.mjs`, on exactly when the config's `workerRunner` entry
is) runs as root at load and every minute. Each run writes every worker product's rules snapshot to
`<base>/worker-rules/<product>.json`, root's 0644, in that folder, root's 0755, which it makes itself. The rules come
from the copy's `worker-runner.json`, the same file the worker runner loads, so there is one source. Root writes the
file, so nothing the `builder` user runs (a session, a product's own install or test command) can change the rules its
sessions' safety checks read.

**It writes only while the worker runner is running.** Each run asks launchd for the worker runner's job by its exact
label, takes the pid from that answer, and asks `ps` whose that pid is and what state it is in. It writes only when the
job is running as `builder` and the process is not stopped (`kill -STOP`), traced or a zombie (L1238). Otherwise, or
when launchd's or ps's answer can't be read, it writes nothing and says why in `worker-rules.err.log`. Worker sessions
outlive a runner restart by design, so a stopped runner shows as its sessions' snapshots going stale: after 5 minutes
their safety checks refuse every call; a runner started again holds every start until the next write. A run that writes nothing
only because the runner is not loaded or not running ends with exit 0 (the runner is just off); any other reason ends
with exit 1, which `daemons check` shows. A product the runner's config gives no rules is skipped (its sessions are
refused) and said, with exit 1; the other products are still written. **Known limit:** a runner that hangs without
stopping (its process still asleep or runnable) is not caught, and `builder`, the runner's own user, can cause such a
hang on purpose (by attaching to the runner or tying up its event loop). It is on the cutover checklist. One way is
closed: the runner's job starts node with `--disable-sigusr1`, so a signal can't start node's debugger in it (L1242).
That option needs node 22.14 or later (23.7 or later on 23); an older node refuses it, and the runner does not start.

**What reads it.** Nothing yet. The worker runner's check 8 and the sessions' safety checks move to it in the next
change (L1226 PR (ii)); until then the job only writes.

| Command | What it does | Root? |
|---|---|---|
| `/usr/local/bin/node <base>/install/orchestrate/setup/worker-rules.mjs write --dry-run` | says which files one run would write, or why it would write none; writes nothing | no |
| `sudo /usr/local/bin/node <base>/install/orchestrate/setup/worker-rules.mjs write` | one run, as the job does it | yes |
| `sudo /usr/local/bin/node setup.mjs daemons unload --only worker-rules` | takes the job out; the snapshots then go stale within 5 minutes | yes |

**Check afterwards** (L1238), once the worker runner is running:
1. `sudo /usr/local/bin/node setup.mjs daemons check --only worker-rules` PASSes: the job file is exact, it is loaded, and its last run ended with exit 0.
2. `stat -f '%Su:%Sg %Lp' <base>/worker-rules/<product>.json` prints `root:wheel 644`.
3. `cat <base>/worker-rules/<product>.json` shows a `written_at` within the last minute or two (the job writes every minute); run it again a minute later and it has moved on.
