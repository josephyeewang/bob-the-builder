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
- Not in this part: the install and the background jobs (part 2); the ownerTaps and proposals folders, the account job
  reload and the Keychain token (part 3).

### Tests

`node --test orchestrate/setup/setup.test.mjs`. They run against a stand-in Mac (`fake-mac.test-helper.mjs`: a throwaway
root folder prefix, an in-memory `dscl`/`dseditgroup`, owners kept in a table) and never as root. The stand-in refuses what
the real tool refuses (a `dscl` write without root, a bad path, a missing record). The last tests run the real read-only
tools on this Mac (`dscl -read`, `dseditgroup -o checkmember`, `stat`, `ls -led`). Each `PLANT` test breaks one clause and
names the check that catches it.
