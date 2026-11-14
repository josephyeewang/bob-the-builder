// products-entry.mjs — `setup.mjs products-entry <product>` (L1199 (2), L1200): root adds the test product's line
// to the Dispatcher's products.json, from setup values only, never a hand edit.
//
//   sudo /usr/local/bin/node <the installed copy>/setup/setup.mjs products-entry <product> [--dry-run]
//
// WHY A COMMAND. products.json is the Dispatcher's list of products: { product, owner, repo, joe_github_id } each
// (M10 reader.mjs checkProducts). Root puts it in the Dispatcher's private folder and the Dispatcher trusts it:
// joe_github_id is whose approval counts on a product's first rules load (reader.mjs), and owner/repo is the
// repository every card's rules and pushes come from. A hand-typed line is the easiest place for a wrong id or
// repository to slip in, so the line is built here from root's setup config and checked as the reader checks it.
//
// THE VALUES, all from root's setup config, none from the command line but the product's name:
//   products          the product must be one of them
//   github.ownerId    the owner's GitHub id (a number): the entry's joe_github_id. Never read from the product's
//                     repo: it is the trust root for that repo's rules, so the repo can't name it
//   github.repos      { "<product>": "owner/name" }: the entry's owner and repo
//   dispatcher        its productsFile (the file written) and tokenFile (the read-only key the read below uses,
//                     whichever the entry names, L1200 (c))
//
// WHAT IT DOES, in order, each a refusal (exit 2 before reading anything, 1 after; nothing written) when it fails:
//   1. who: root (the file is root's), with the orchestrate user there (the token's and the private folder's owner).
//   2. the entry: built from the values above; the product one of the config's products. The list's folder must be
//      a plain folder of root's or orchestrate's that no one else can write.
//   3. the list as it is: a missing file is an empty list; one there is read as approve-rules reads its list (a plain
//      file of root's or orchestrate's that no one else can write, one name, under 1 MB) and must pass the reader's
//      own check. A line for another product is kept as it is. A line for this product that differs is refused:
//      this command only adds, it never changes a line.
//   4. GitHub main, read only (approve-rules' own read, through the Dispatcher entry's token): the commit and the
//      rules blob, printed so the owner can match them to what approve-rules shows later (L1200 (b)).
//   5. the test product (L1199, as #537's runner gate): the rules on main must parse (M10's parser) and say
//      product.test_product: true (shared/rules.mjs exactFlag, as every reader of the flag), and their
//      accounts.joe.github_id must be github.ownerId (first-cutover.mjs's own cross-check). Any read or parse that
//      fails refuses (L1200 (d)): there is no fallback to the config.
//   6. written (not with --dry-run): the old list with this line added at the end, as a new root:wheel 0644 file in
//      the same folder, renamed over the old one; the list is read again first and must not have changed since 3.
//   7. read back through the reader's own readProducts: the line is there, as built.
//
// WHAT IT IS NOT (L1200 (a)). Step 5 is a filter, not an approval: it writes nothing to the rules state, and the
// rules it read are not adopted by anything. Approving a rules version is approve-rules' job, by the owner, and
// #537's runner gate still checks product.test_product on the approved rules snapshot at every start. A product
// whose rules on main later stop saying test_product keeps its products.json line, and is held there.

import { closeSync, constants, fchmodSync, fchownSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { RULES_PATH, checkProducts, readProducts } from '../modules/M10-rules/reader.mjs';
import { parsePolicy } from '../modules/M10-rules/policy.mjs';
import { readOnlyClient, tokenFile } from '../modules/M6-merge-gate/watch-only.mjs';
import { exactFlag } from '../shared/rules.mjs';
import { isRepoName } from './layout.mjs';
import { readUser } from './users-folders.mjs';
import { mainRules, readListFile } from './approve-rules.mjs';
import { DISPATCHER_OFF, DISPATCHER_USER } from './dispatcher-setup.mjs';

export const GITHUB_KEYS = Object.freeze(['ownerId', 'repos']);

/**
 * The setup config's `github` entry → { ownerId, repos }, or a throw. ownerId a positive whole number; repos an
 * object of the config's products, each owner/name (layout.mjs isRepoName, the one check).
 */
export function parseGithub(raw, cfg) {
  if (raw === undefined) throw new Error('config: there is no "github" entry: add { "ownerId": <your GitHub id, a number>, "repos": { "<product>": "owner/name" } }');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: github must be an object with ownerId and repos');
  const extra = Object.keys(raw).filter((k) => !GITHUB_KEYS.includes(k));
  if (extra.length) throw new Error(`config: github has keys it does not take: ${extra.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}`);
  if (!Number.isSafeInteger(raw.ownerId) || raw.ownerId <= 0) throw new Error('config: github.ownerId must be the owner\'s GitHub id, a whole number (not in quotes)');
  const r = raw.repos;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('config: github.repos must be an object of "<product>": "owner/name"');
  for (const [p, v] of Object.entries(r)) {
    if (!cfg.products.includes(p)) throw new Error(`config: github.repos names ${JSON.stringify(p.slice(0, 64))}, which is not one of the config's products`);
    if (!isRepoName(v)) throw new Error(`config: github.repos.${p} must look like owner/name`);
  }
  return Object.freeze({ ownerId: raw.ownerId, repos: Object.freeze({ ...r }) });
}

/** The products.json line for `product` from the setup config → the entry, or a throw. */
export function entryFor(cfg, githubRaw, product) {
  if (!cfg.products.includes(product)) throw new Error(`${product} is not one of the setup config's products`);
  const g = parseGithub(githubRaw, cfg);
  const repo = g.repos[product];
  if (repo === undefined) throw new Error(`config: github.repos has no repository for ${product}`);
  const [owner, name] = repo.split('/');
  return Object.freeze({ product, owner, repo: name, joe_github_id: g.ownerId });
}

/**
 * The list file as it is: { text: null } when there is none, else { text }; approve-rules' own read (one handle,
 * never a link, a plain file with one name, under 1 MB), taking root or orchestrate as its owner. Else a throw.
 */
export const readProductsFile = (file, { uids }) => readListFile(file, { uids, whose: `root or ${DISPATCHER_USER}` });

/**
 * Why the list's folder can't take the file, or null: a plain folder (not a link) of root's or orchestrate's,
 * written by no one else.
 */
export function folderProblem(dir, { uids, lstat = lstatSync }) {
  let st; try { st = lstat(dir); } catch (e) { return `${dir} can't be read (${e?.code ?? e}): run users-folders first`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} is not a plain folder`;
  if (!uids.includes(st.uid)) return `${dir} belongs to uid ${st.uid}, not to root or ${DISPATCHER_USER}`;
  if (st.mode & 0o022) return `${dir} is open to writes by others than root or ${DISPATCHER_USER} (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

/**
 * The new list's text as a new root:wheel 0644 file in the same folder, flushed, then renamed over the list; the folder
 * flushed too. `uid` and `gid` are root's and wheel's (0); a test passes its own.
 */
export function writeProductsFile(file, text, { uid = 0, gid = 0 } = {}) {
  const tmp = `${file}.${process.pid}.new`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fchownSync(fd, uid, gid); fchmodSync(fd, 0o644); writeSync(fd, text); fsyncSync(fd); } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
  closeSync(fd);
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
  const dfd = openSync(dirname(file), constants.O_RDONLY);
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

/**
 * The real ports, as root: the read-only client through the Dispatcher entry's token (orchestrate's file), the
 * list file. Tests pass their own.
 */
export function realPorts(io, { fetchFn } = {}) {
  return {
    gh: (path, uid) => readOnlyClient({ token: tokenFile(path, { uid }), fetchFn }),
    folderProblem: (dir, uids) => folderProblem(dir, { uids }),
    readList: (file, uids) => readProductsFile(file, { uids }),
    writeList: writeProductsFile,
    readBack: (file) => readProducts(file),
  };
}

const same = (a, b) => a.product === b.product && a.owner === b.owner && a.repo === b.repo && a.joe_github_id === b.joe_github_id;

/**
 * The command. `io` is setup's (euid, rootUid, at, run for dscl); `cfg` root's parsed install config (with its
 * `dispatcher` entry); `githubRaw` the config's `github` entry as written; `ports` as realPorts. → exit code:
 * 0 written (or already there), 1 refused after looking, 2 refused before reading anything.
 */
export async function productsEntry({ io, cfg, githubRaw, product, dry = false, ports, out, err }) {
  // 1. who.
  if (io.euid() !== io.rootUid) { err(`refused: products.json is root's file: run this with sudo (sudo … products-entry ${product})`); return 2; }
  const orch = readUser(io, DISPATCHER_USER);
  if (!orch.exists || !Number.isInteger(orch.uid) || orch.uid <= 0) { err(`refused: setup has not made the ${DISPATCHER_USER} user yet (run users-folders first)`); return 2; }

  // 2. the entry.
  if (!cfg.dispatcher) { err(`refused: ${DISPATCHER_OFF}; its productsFile and tokenFile are what this uses`); return 2; }
  let entry; try { entry = entryFor(cfg, githubRaw, product); } catch (e) { err(`refused: ${e.message}`); return 2; }
  const file = io.at(cfg.dispatcher.productsFile);
  const uids = [io.rootUid, orch.uid];
  const fp = ports.folderProblem(dirname(file), uids);
  if (fp) { err(`refused: the list's folder: ${fp}`); return 2; }

  // 3. the list as it is.
  let before; let list;
  try { before = ports.readList(file, uids); list = before.text === null ? [] : checkProducts(JSON.parse(before.text)); } catch (e) { err(`refused: ${file} can't be used (${e instanceof SyntaxError ? 'it is not valid JSON' : e.message}). Nothing written.`); return 1; }
  const had = list.find((p) => p.product === product);
  if (had && !same(had, entry)) { err(`refused: ${file} already lists ${product} as ${had.owner}/${had.repo} with GitHub id ${had.joe_github_id}, which is not what the setup config says (${entry.owner}/${entry.repo}, ${entry.joe_github_id}). This command only adds a line; it never changes one. Nothing written.`); return 1; }
  try { checkProducts([...list.filter((p) => p !== had), entry]); } catch (e) { err(`refused: the list with this line added would be refused by the reader (${e.message}). Nothing written.`); return 1; }

  // 4. GitHub main, read only.
  out(`product      ${product} (${entry.owner}/${entry.repo}), owner's GitHub id ${entry.joe_github_id}`);
  let m; try { m = await mainRules(ports.gh(io.at(cfg.dispatcher.tokenFile), orch.uid), entry); } catch (e) { err(`refused: GitHub main can't be read (${e.message}). Nothing written.`); return 1; }
  out(`main         commit ${m.commit}`);
  out(`rules file   ${RULES_PATH}, blob ${m.blob}`);

  // 5. the test product.
  const parsed = parsePolicy(m.text);
  if (!parsed.ok) { err(`refused: main's rules can't be parsed (${parsed.reason}). Nothing written.`); return 1; }
  const p = parsed.policy;
  if (exactFlag(p.product?.test_product) !== true) { err(`refused: main's rules do not say product.test_product: true (it is ${JSON.stringify(p.product?.test_product ?? null)}); this command adds only the test product. Nothing written.`); return 1; }
  if (p.accounts?.joe?.github_id !== entry.joe_github_id) { err(`refused: main's rules name the owner's GitHub id ${p.accounts?.joe?.github_id}, but the setup config's github.ownerId is ${entry.joe_github_id}. Nothing written.`); return 1; }
  out('checks       the rules parse, say product.test_product: true, and name the same GitHub id (a filter only: nothing is approved)');
  out(`the line     ${JSON.stringify(entry)}`);
  if (had) { out(`already listed: ${file} has this line. Nothing written.`); return 0; }
  out(`the list     ${list.length ? `${list.length} other product(s), kept as they are` : before.text === null ? 'no file yet: it is made' : 'empty'}`);
  if (dry) { out('dry run: nothing written.'); return 0; }

  // 6. written.
  let now; try { now = ports.readList(file, uids); } catch (e) { err(`refused: ${file} can't be read again (${e.message}). Nothing written.`); return 1; }
  if (now.text !== before.text) { err(`refused: ${file} changed while this was reading. Nothing written; run it again.`); return 1; }
  const next = [...list.map((x) => ({ ...x })), { ...entry }];
  try { ports.writeList(file, `${JSON.stringify(next, null, 2)}\n`); } catch (e) { err(`refused: ${file} could not be written (${e?.code ?? e.message})`); return 1; }

  // 7. read back.
  let got; try { got = ports.readBack(file).find((x) => x.product === product); } catch (e) { err(`FAIL  ${file} was written, but the reader can't read it (${e.message}): look at it`); return 1; }
  if (!got || !same(got, entry)) { err(`FAIL  ${file} was written, but the reader does not find this line in it: look at it`); return 1; }
  out(`written: ${file} now lists ${product}. Next: approve-rules ${product}, which shows the same commit if main has not moved.`);
  return 0;
}
