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

`base` is root's and must not sit under `/Users`, `/Applications`, `/tmp`, `/Volumes`, `/opt` or `/usr/local`, in any letter
case (the review runner refuses a wall in a folder others can write).

| Command | What it does | Root? |
|---|---|---|
| `node setup.mjs users-folders --config <file> --dry-run` | prints every step it would take; changes nothing | no |
| `sudo /usr/local/bin/node setup.mjs users-folders --config <file>` | makes the three users (ids 600-699, all different; hidden, shell `/usr/bin/false`, password `*`, own group, never admin), then the folders (owner, group, exact mode, exact access list), then runs `check` | yes |
| `node setup.mjs check --config <file>` | read only: `PASS`, `FAIL` or `SKIP` per item; exit 1 on any FAIL. Before setup it lists about 30 FAILs, which is expected. The sudo-rule item is `SKIP` unless run as root | no |
| `sudo /usr/local/bin/node setup.mjs proofs --config <file>` | runs, as the owner's user, the "cannot" proofs: the record, hooks, settings, launcher, lead-main and claude-code copies cannot be written and the robot keys cannot be read (two controls first) | yes |

- Run it twice and the second run does nothing. A run cut off at any step is finished by the next one: it writes only
  the attributes that are missing and deletes nothing.
- A user or group that exists but is wrong (an admin, a login shell, not hidden, another home, a password, an id outside
  600-699, root's id, or an id another account uses) is **refused, not changed**: the command lists the problem and changes
  nothing. A folder under the base that is wrong gets its owner, group, mode and access list put right.
- **Root never follows a link.** Before any step, every folder above the base is checked to be root's alone (no link, not
  writable by others, no access list); the same check is the first step of the run, so a change between the plan and the
  run stops it before anything is done. Each folder is then changed through an open handle (a link, or a folder swapped
  since the plan, is refused), all folders are made first, and children are handed over before their parents.
- **One outbox root.** `outboxes/` is root's 0755; under it `reviewer/` and `auditor/` belong to `review` (0755) and each
  worker role has a folder owned by the workers' user (0750) with one access-list entry letting `orchestrate` list and
  read, with inheritance. `check` compares the access list exactly: a missing or an extra entry FAILs.
- Root runs only a node program that is root's alone with every folder above it (the nodejs.org install in
  `/usr/local/bin`; a Homebrew node is refused). `--root-prefix` is for tests and is refused when running as root.
- It never sets or reads a password. An unknown argument is never printed back (it could be a secret).
- Not in this part: the install and the background jobs (part 2); the ownerTaps and proposals folders, the account job
  reload and the Keychain token (part 3).

### Tests

`node --test orchestrate/setup/setup.test.mjs`. They run against a stand-in Mac (`fake-mac.test-helper.mjs`: a throwaway
root folder prefix, an in-memory `dscl`/`dseditgroup`, owners kept in a table) and never as root. The stand-in refuses what
the real tool refuses (a `dscl` write without root, a bad path, a missing record). The last tests run the real read-only
tools on this Mac (`dscl -read`, `dseditgroup -o checkmember`, `stat`, `ls -led`). Each `PLANT` test breaks one clause and
names the check that catches it.
