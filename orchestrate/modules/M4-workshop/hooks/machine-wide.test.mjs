// L1031: the production-write guard's machine-wide form, `--machine-wide --snapshot <root's copy>`, as managed-settings.json
// runs it for every session on the Mac. The copy is written once by setup.mjs managed-settings and never refreshed, so it has
// no age limit, but it must be root's alone (here a test's own uid stands in for root, `ownerUid`; the real form always
// means 0). A copy the guard can't use blocks every call, naming the way out (guard b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync, linkSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, runHook, MANAGED_FILE, MACHINE_WIDE_WAY_OUT, shellCommands, unreadable } from './lib.mjs';
import { makeSnapshot, readSnapshot, rootChainProblem } from './snapshot.mjs';
import { decide } from './production-write-guard.mjs';
import { CLAUDE_FILE } from '../launcher/env-check.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ME = process.getuid();
const RULES = { production: { env_files: ['/srv/app/prod-settings.conf'], programs: ['vercel'], hosts: ['prod.example.com'] }, secrets: { paths: [] } };
const HARMLESS = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/' };
const PROD = { tool_name: 'Bash', tool_input: { command: 'vercel deploy' }, cwd: '/' };
const YEAR = 365 * 24 * 3600 * 1000;

/** A folder of this test's own (owner ME, 0755, every folder above it root's or ME's and written by no one else) holding the copy. */
function copyAt(body = makeSnapshot(RULES), mode = 0o644) {
  const d = realpathSync(tempDir('orch-mw-')); chmodSync(d, 0o755);
  const f = join(d, 'machine-wide-rules.json'); writeFileSync(f, body); chmodSync(f, mode);
  return { d, f };
}
const wide = (snapshot, ownerUid = ME) => ({ machineWide: true, snapshot, ownerUid });
const wayOut = (r) => { assert.equal(r.block, true); assert.ok(r.reason.endsWith(MACHINE_WIDE_WAY_OUT), r.reason); };
// A block by rule is no lock-out: it never says every session is blocked (#487 r5: it may name the sudo rm way out, L1075).
const ruleBlock = (r, c) => { assert.equal(r.block, true, c); assert.ok(!r.reason.includes(MACHINE_WIDE_WAY_OUT) && !r.reason.includes('blocked until it is put right'), `a block by rule is no lock-out: ${c}`); };

test('L1031: the machine-wide form is exactly --machine-wide --snapshot <full path>, and only a hook that opts in takes it', () => {
  assert.deepEqual(parseArgs(['--machine-wide', '--snapshot', '/a/b.json'], { machineWide: true }), { machineWide: true, snapshot: '/a/b.json' });
  for (const bad of [['--machine-wide', '--snapshot'], ['--machine-wide', '--snapshot', 'rel.json'], ['--machine-wide', '--snapshot', '/a', '--role', 'x'],
    ['--machine-wide', 'yes', '--snapshot', '/a'], ['--machine-wide', '--role', '/a']]) {
    assert.throws(() => parseArgs(bad, { machineWide: true }), /machine-wide form|absolute/, bad.join(' '));
  }
  assert.throws(() => parseArgs(['--machine-wide', '--snapshot', '/a/b.json']), /no machine-wide form/, 'a hook that does not opt in refuses it');
  // The role form is unchanged, for a hook that opts in too.
  assert.equal(parseArgs(['--role', 'r', '--outbox', '/o', '--snapshot', '/s'], { machineWide: true }).role, 'r');
  assert.equal(MANAGED_FILE, CLAUDE_FILE, 'one name for the machine-wide file: the way out names the file check 10 reads');
});

test('L1031 guard b: a hook error in the machine-wide form blocks and names the way out; the role form\'s does not', async () => {
  const run = async (argv, opts) => { let code; let err = ''; await runHook(() => { throw new Error('boom'); }, { argv, stdin: [Buffer.from('{}')], exit: (c) => { code = c; }, stderr: (t) => { err += t; } }, opts); return { code, err }; };
  const a = await run(['--machine-wide', '--snapshot', '/a/b.json'], { machineWide: true });
  assert.equal(a.code, 2); assert.match(a.err, /boom/); assert.ok(a.err.includes(MACHINE_WIDE_WAY_OUT));
  const b = await run(['--machine-wide', '--snapshot', 'rel'], { machineWide: true });   // a bad argument, too
  assert.equal(b.code, 2); assert.ok(b.err.includes(MACHINE_WIDE_WAY_OUT));
  const c = await run(['--role', 'r', '--outbox', '/o', '--snapshot', '/s'], { machineWide: true });
  assert.equal(c.code, 2); assert.ok(!c.err.includes('sudo rm'), 'a role session\'s hook error is the loop\'s to put right, not a machine-wide lock-out');
  const d = await run(['--machine-wide', '--snapshot', '/a/b.json'], {});
  assert.equal(d.code, 2); assert.ok(!d.err.includes('sudo rm'), 'a hook with no machine-wide form refuses it as a bad argument');
});

test('L1031: root\'s copy is read with no age limit: a year-old copy still guards, where a role snapshot that old is stale', () => {
  const { f } = copyAt(makeSnapshot(RULES, new Date(Date.now() - YEAR)));
  assert.deepEqual(decide(HARMLESS, wide(f)), { block: false });
  assert.match(decide(PROD, wide(f)).reason, /"vercel" reaches production/);
  assert.match(decide(HARMLESS, { snapshot: f }).reason, /stale/, 'the role form keeps its 5-minute limit');
});

test('L1031 guard b: a missing, unreadable or broken copy blocks every call, harmless ones too, naming the way out', () => {
  const { d, f } = copyAt();
  wayOut(decide(HARMLESS, wide(join(d, 'missing.json'))));
  const bad = copyAt('{"rules":{"production":{}},"hash":"x","written_at":"2026-01-01T00:00:00Z"}');
  wayOut(decide(HARMLESS, wide(bad.f)));
  const noBlock = copyAt(makeSnapshot({ secrets: { paths: [] } }));
  wayOut(decide(HARMLESS, wide(noBlock.f)));
  chmodSync(f, 0o000);
  if (ME !== 0) wayOut(decide(HARMLESS, wide(f)));   // root reads a 0000 file, so only a non-root run sees it unreadable
  // The role form's own refusal is unchanged: no way-out text.
  assert.ok(!decide(HARMLESS, { snapshot: join(d, 'missing.json') }).reason.includes('sudo rm'));
});

test('L1031: the copy must be root\'s alone: another owner, a group- or other-writable copy or folder above, a link or a second name is refused', () => {
  const { d, f } = copyAt();
  assert.deepEqual(decide(HARMLESS, wide(f)), { block: false }, 'the good copy passes');
  wayOut(decide(HARMLESS, wide(f, ME + 1)));   // owned by someone other than root
  assert.match(decide(HARMLESS, wide(f, ME + 1)).reason, /not root's alone/);
  for (const m of [0o664, 0o646]) { chmodSync(f, m); assert.match(decide(HARMLESS, wide(f)).reason, /rules copy is not root's alone/, m.toString(8)); }
  chmodSync(f, 0o644);
  chmodSync(d, 0o775); assert.match(decide(HARMLESS, wide(f)).reason, /the folder .* above the machine-wide rules copy is not root's alone/); chmodSync(d, 0o755);
  const link = join(d, 'link.json'); symlinkSync(f, link);
  wayOut(decide(HARMLESS, wide(link)));
  const second = join(d, 'second.json'); linkSync(f, second);
  assert.match(decide(HARMLESS, wide(f)).reason, /2 names/);
  assert.equal(rootChainProblem('/no/such/folder/x.json'), 'rules snapshot is missing or unreadable');
  // readSnapshot without ownerUid (every role hook, launch check 8) never judges the owner.
  assert.equal(readSnapshot(second, { maxAgeMs: Infinity }).ok, false, 'the second name is still refused');
});

test('L1031: the real guard script, run as managed-settings.json runs it, blocks with the way out when root does not own the copy', () => {
  const { f } = copyAt();
  const r = spawnSync(process.execPath, [join(HERE, 'production-write-guard.mjs'), '--machine-wide', '--snapshot', f], { input: JSON.stringify(HARMLESS), encoding: 'utf8' });
  if (ME === 0) { assert.equal(r.status, 0, r.stderr); return; }
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not root's alone/);
  assert.ok(r.stderr.includes(`sudo rm "${CLAUDE_FILE}"`), r.stderr);
  // Every other hook refuses the form.
  const s = spawnSync(process.execPath, [join(HERE, 'secret-file-block.mjs'), '--machine-wide', '--snapshot', f], { input: JSON.stringify(HARMLESS), encoding: 'utf8' });
  assert.equal(s.status, 2); assert.match(s.stderr, /no machine-wide form/);
});

test('L1031: a folder written by others above the copy is refused, whoever owns it', () => {
  const { d } = copyAt();
  const sub = join(d, 'sub'); mkdirSync(sub); chmodSync(sub, 0o757);
  const f = join(sub, 'c.json'); writeFileSync(f, makeSnapshot(RULES)); chmodSync(f, 0o644);
  assert.match(rootChainProblem(f, ME), /folder .*sub above/);
});

test('L1044 M1: the machine-wide form blocks production names only; everyday shell shapes the role guard refuses pass for every session', () => {
  const { d, f } = copyAt();
  const bash = (command, cwd = d) => decide({ tool_name: 'Bash', cwd, tool_input: { command } }, wide(f));
  for (const c of ['TMPDIR=$(getconf DARWIN_USER_TEMP_DIR) node --test x.test.mjs', 'bash ~/x/run-slot.sh node --test a', 'echo $PATH', 'for f in a b; do echo $f; done',
    './scripts/check.sh', 'find . -name x -exec rm {} \;', 'ls | xargs wc -l', 'W=/a; cd $W', 'cd /tmp && rm -rf .', 'git status', 'eval "$X"', 'source ./env.sh']) {
    assert.deepEqual(bash(c), { block: false }, c);
    assert.equal(decide({ tool_name: 'Bash', cwd: d, tool_input: { command: c } }, { snapshot: join(d, 'role.json') }).block, true, `the role form still refuses or has no snapshot: ${c}`);
  }
  // No cwd key at all (a default parameter would fill one in: lane 2 plant 20 missed it that way).
  assert.deepEqual(decide({ tool_name: 'Bash', tool_input: { command: 'ls' } }, wide(f)), { block: false }, 'a call with no working folder is no reason to block every session');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'vercel deploy' } }, wide(f)).block, true, 'with no working folder, a production name still blocks');
  for (const c of ['cat /srv/app/prod-settings.conf', 'vercel deploy --prod', 'npx vercel deploy', 'pnpm dlx vercel', 'curl https://prod.example.com/x', 'echo $(cat /srv/app/prod-settings.conf)',
    'for f in a; do vercel deploy; done', 'cp prod-settings.conf /tmp/x', 'X=/srv/app/prod-settings.conf; cat $X', 'cat /srv/app/{prod-settings,x}.conf', 'VERCEL=1 bash -c "vercel deploy"', 'sh -lc "cd x && npx vercel"', 'eval vercel deploy', '/bin/bash -c "bash -c \\"vercel\\""']) {
    ruleBlock(bash(c), c);
  }
});

test('L1044 A10, A11: in the machine-wide form, file tools on a production settings file and a production host in a URL are blocked', () => {
  const { d, f } = copyAt();
  for (const tool_name of ['Read', 'Edit', 'Write', 'MultiEdit']) {
    assert.match(decide({ tool_name, cwd: d, tool_input: { file_path: '/srv/app/prod-settings.conf' } }, wide(f)).reason, /is a production settings file/, tool_name);
    assert.match(decide({ tool_name, cwd: d, tool_input: { file_path: '/SRV/App/Prod-Settings.conf' } }, wide(f)).reason ?? '', /is a production settings file/, `${tool_name}, letter case`);
    assert.deepEqual(decide({ tool_name, cwd: d, tool_input: { file_path: join(d, 'notes.md') } }, wide(f)), { block: false }, tool_name);
  }
  // #487 r2 m2: the other path keys toolPaths reads, NotebookEdit's notebook_path and Grep's path.
  for (const [tool_name, key] of [['NotebookEdit', 'notebook_path'], ['Grep', 'path']]) {
    assert.match(decide({ tool_name, cwd: d, tool_input: { [key]: '/srv/app/prod-settings.conf', pattern: 'x' } }, wide(f)).reason ?? '', /is a production settings file/, tool_name);
    assert.match(decide({ tool_name, cwd: d, tool_input: { [key]: '/SRV/app/PROD-settings.conf', pattern: 'x' } }, wide(f)).reason ?? '', /is a production settings file/, `${tool_name}, letter case`);
    assert.deepEqual(decide({ tool_name, cwd: d, tool_input: { [key]: join(d, 'notes.ipynb'), pattern: 'x' } }, wide(f)), { block: false }, tool_name);
  }
  assert.match(decide({ tool_name: 'WebFetch', cwd: d, tool_input: { url: 'https://PROD.example.com/admin' } }, wide(f)).reason, /production host/);
  assert.deepEqual(decide({ tool_name: 'WebFetch', cwd: d, tool_input: { url: 'https://docs.example.com/' } }, wide(f)), { block: false });
  assert.match(decide({ tool_name: 'Bash', cwd: d, tool_input: { command: 'ssh deploy@prod.example.com' } }, wide(f)).reason, /production host/);
});

// #487 r2 M1 (L1057 option a): a shape the role guard refuses runs in the machine-wide form, but not with a production
// program named anywhere in it; a plain command keeps the narrow read.
const WRAPPED = ['timeout 300 vercel deploy --prod', 'gtimeout 300 vercel deploy', 'sudo -u deploy vercel deploy', 'nice -n 5 vercel deploy',
  'echo deploy | xargs -n 1 vercel', 'caffeinate -i vercel deploy', 'arch -arm64 vercel deploy', 'script -q /dev/null vercel deploy',
  'watch -n 60 vercel deploy', 'dotenv -- vercel deploy', 'env -S "vercel deploy"', 'su -c "vercel deploy" deploy', 'flock /tmp/l vercel deploy',
  'stdbuf -oL vercel deploy', 'xcrun vercel deploy', 'setsid vercel deploy', 'doas vercel deploy', 'noglob vercel deploy',
  'find . -name x -exec vercel deploy \\;', 'echo "vercel deploy --prod" | bash', 'bash <<< "vercel deploy"', 'bash <<EOF\nvercel deploy\nEOF',
  'python3 -c "import os; os.system(\'vercel deploy\')"', 'node -e "cp.execSync(\'vercel deploy\')"',
  'osascript -e \'do shell script "vercel deploy"\'', 'timeout 300 ./node_modules/.bin/vercel deploy', 'timeout 300 npx vercel@latest deploy',
  'timeout 300 v\'e\'rcel deploy', 'timeout 300 VERCEL deploy'];
test('#487 r2 M1: in the machine-wide form, a wrapper, a string handed to a shell or code handed to an interpreter that names a production program is blocked', () => {
  const { d, f } = copyAt();
  const bash = (command) => decide({ tool_name: 'Bash', cwd: d, tool_input: { command } }, wide(f));
  for (const c of WRAPPED) {
    const r = bash(c);
    assert.equal(r.block, true, c); assert.match(r.reason, /names the production program "vercel"/, c);
    ruleBlock(r, c);
  }
  // The same shapes naming a production settings file (#487 r3, the class of M1): a string handed to a shell is read word
  // by word, and code handed to an interpreter word-like run by run.
  for (const c of ['bash -c "cat /srv/app/prod-settings.conf"', 'bash -c "cd /srv/app && cat prod-settings.conf"', 'sh -c "cat p*.conf"',
    'eval "cd /srv/app; cat prod-settings.conf"', 'timeout 5 cat /srv/app/prod-settings.conf', 'python3 -c "open(\'/srv/app/prod-settings.conf\').read()"',
    'node -e "fs.readFileSync(\'prod-settings.conf\')"', 'echo "cat /srv/app/prod-settings.conf" | bash']) {
    assert.match(bash(c).reason ?? '', /production settings file/, c);
  }
  // Wrapped shapes with no production program still pass, and so do the allowed shapes (#487 r5, L1075).
  for (const c of ['grep vercel x', 'which vercel', 'cat vercel.json', 'git commit -m "fix vercel config"', 'ls vercel-notes',
    'timeout 300 npm test', 'find . -name x -exec rm {} \\;', 'ls | xargs wc -l', 'python3 -c "print(1)"', 'python3 -c "print(a[0]*2)"', 'echo hi | bash', 'sudo -u me ls']) {
    assert.deepEqual(bash(c), { block: false }, c);
  }
});

test('#487 r2 m1: in the machine-wide form, a wildcard is judged in the folder it is read in, when that folder is certain', () => {
  const p = realpathSync(tempDir('orch-mw-prod-'));
  const { d, f } = copyAt(makeSnapshot({ production: { env_files: [join(p, '.prodsettings')], programs: ['vercel'], hosts: ['prod.example.com'] }, secrets: { paths: [] } }));
  const bash = (command, cwd = d) => decide({ tool_name: 'Bash', cwd, tool_input: { command } }, wide(f));
  for (const c of ['ls -d .*', 'cp *.* x', 'grep X .p*', 'ls .p*', `ls ${d}/.p*`]) assert.deepEqual(bash(c), { block: false }, `a project folder: ${c}`);
  const link = join(d, 'via'); symlinkSync(p, link);
  for (const [c, cwd] of [['ls -d .*', p], [`cat ${p}/.p*`, d], ['cat ../' + p.split('/').pop() + '/.p*', p], [`cd ${p} && ls -d .*`, d], [`pushd ${p}; cat .p*`, d],
    [`bash -c "cd ${p} && cat .p*"`, d], [`bash -c 'cat .p*'`, p], ['eval cat .p*', p], ['timeout 5 cat .p*', d], ['cat via/.p*', d], ['cat ~/.p*', d], ['cat */.p*', d],
    // A pattern a program matches in another folder: quoted, escaped, after `=`, or handed to find and the like.
    [`find ${p} -name '.p*'`, d], [`find ${p} -name .p*`, d], ['ls \'.p*\'', d], ['ls .p\\*', d], ['grep -r --include=.p* X /srv', d], [`rsync -a ${p}/ x --include .p*`, d],
    [`(cd ${p} && cat .p*)`, d], [`ls .p*; find ${p} -name '.p*'`, d]]) {
    assert.equal(bash(c, cwd).block, true, `${c} (in ${cwd})`); assert.match(bash(c, cwd).reason, /production settings file/, c);
  }
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'cat .p*' } }, wide(f)).block, true, 'no working folder: judged by name, as before');
  // The role form is unchanged: a wildcard matches by name in any folder.
  assert.equal(decide({ tool_name: 'Bash', cwd: d, tool_input: { command: 'ls .p*' } }, { snapshot: f, maxAgeMs: Infinity }).block, true);
});

// #487 r5 m2: in the role form, a stray line equal to a here-document's end word hid the commands up to the real end
// from `unreadable`, which looked for bodies again in text whose bodies were already taken out (lib.mjs bodiesTaken).
test('#487 r5 m2: the role form refuses a production call between a stray end-word line and the real end', () => {
  const { d, f } = copyAt(makeSnapshot({ ...RULES, production: { ...RULES.production, programs: PROGRAMS } }));
  const role = (command) => decide({ tool_name: 'Bash', cwd: d, tool_input: { command } }, { snapshot: f, maxAgeMs: Infinity });
  for (const c of ["cat > a <<'EOF'\nA\nEOF\ntimeout 300 vercel deploy\nEOF", "cat > a <<'EOF'\nA\nEOF\nsudo -u joe vercel deploy\nEOF",
    "cat > a <<EOF\nA\nEOF\ntimeout 300 vercel deploy\nEOF", "git commit -F - <<'M'\nx\nM\nnice -n 5 vercel deploy\nM"]) {
    assert.equal(role(c).block, true, c);
  }
  assert.ok(unreadable("cat > a <<'EOF'\nA\nEOF\ntimeout 300 vercel deploy\nEOF"), 'unreadable sees the wrapper after the stray end line');
  // The plain here-document still passes the role form.
  assert.deepEqual(role("cat > a <<'EOF'\nA\nEOF"), { block: false });
});

// #487 r5 (LEAD-CALLS L1075): the machine-wide form refuses by default. Any word of the raw line, here-document bodies and
// `$( )` included, naming a production program refuses it, unless the whole line is one of three allowed shapes or the
// word is a path that can't be the program. Every r3 and r4 probe is kept here and must refuse.
const HD = (head, body) => `${head} <<'EOF'\n${body}\nEOF`;
const MSG = (head, body) => `${head} "$(cat <<'EOF'\n${body}\nEOF\n)"`;
const PROGRAMS = ['vercel', 'supabase', 'psql'];
const MUST_REFUSE = {
  // r3 M1 (L1066's families): runners the plain read did not take as a command.
  'r3: package runners': ['pnpm vercel deploy --prod', 'yarn vercel deploy --prod', 'pnpm --dir /x dlx vercel deploy', 'npm --prefix /x exec vercel deploy',
    'bun x vercel deploy', 'bun run vercel deploy', 'corepack pnpm dlx vercel deploy', "npx concurrently 'vercel deploy'"],
  'r3: interpreters reading -': [HD('python3 -', "import os\nos.system('vercel deploy --prod')"), HD('python3 -u -', "os.system('vercel deploy')"),
    'echo "os.system(\'vercel deploy\')" | python3 -', 'echo "x(\'vercel deploy\')" | node -', HD('node -', "x('vercel deploy')")],
  'r3: other runners': ['tmux new-session -d vercel deploy', "tmux send-keys -t x 'vercel deploy' Enter", 'screen -dmS x vercel deploy',
    'git bisect run vercel deploy', "git rebase --exec 'vercel deploy'", 'git rebase -x "vercel deploy" main', "git rebase --exec='vercel deploy' main",
    'fd -x vercel deploy', 'fd -e ts -X vercel deploy', 'fd --exec vercel deploy', 'watchexec -- vercel deploy', "nodemon --exec 'vercel deploy'", 'ls | entr vercel deploy',
    "echo 'vercel deploy' | at now", "echo 'vercel deploy' | batch", "echo '* * * * * vercel deploy' | crontab -", 'launchctl asuser 501 vercel deploy',
    'ssh localhost vercel deploy', "ssh host 'cd app && vercel deploy'", "lua -e 'os.execute(\"vercel deploy\")'", "Rscript -e 'system(\"vercel deploy\")'",
    "pwsh -c 'vercel deploy'", "expect -c 'spawn vercel deploy'"],
  // r4 M1: a here-document earlier in the line hid what came after it (lib.mjs shellCommands, fixed too).
  'r4 M1: after a here-document': ['timeout 300 vercel deploy --prod', 'gtimeout 300 vercel deploy', 'caffeinate -i vercel deploy', 'sudo -u joe vercel deploy',
    'nice -n 5 vercel deploy', 'script -q /dev/null vercel deploy', 'watch vercel deploy', 'arch -arm64 vercel deploy', 'flock /tmp/l vercel deploy', 'stdbuf -oL vercel deploy',
    'xcrun vercel deploy', 'dotenv -- vercel deploy', "su joe -c 'vercel deploy'", 'doas vercel deploy', 'find . -exec vercel deploy \\;', 'python3 -c "os.system(\'vercel deploy\')"',
    'node -e "x(\'vercel deploy\')"', 'osascript -e \'do shell script "vercel deploy"\'', 'perl -e \'system("vercel deploy")\'', 'awk \'BEGIN{system("vercel deploy")}\'',
    "echo 'vercel deploy' | sh", "sh <<< 'vercel deploy'", HD('bash', 'vercel deploy'), HD('python3', "os.system('vercel deploy')")]
    .flatMap((tail) => [`${HD('git commit -F -', 'msg')}\n${tail}`, `${HD('cat > notes.md', 'x')}\n${tail}`]),
  // r4 M2 (a): a one-line "cat body" the shell runs the middle of; (b) a wrapper's option value taken for the program.
  'r4 M2': ["git commit -m \"$(cat <<'EOF'; vercel deploy --prod; EOF)\"", "git tag -m \"$(cat <<'EOF'; vercel deploy; EOF)\"",
    "git commit --message=\"$(cat <<'EOF'; vercel deploy; EOF)\"", "gh issue comment 5 -b \"$(cat <<'EOF'; vercel deploy; EOF)\"",
    "sudo git commit -m \"$(cat <<'EOF'; vercel deploy; EOF)\"", "env git commit -m \"$(cat <<'EOF'; psql -c 'drop table x'; EOF)\"",
    "git commit -m \"$(cat <<'EOF'\nx\nEOF\nvercel deploy\nEOF\n)\"", 'env -u grep vercel deploy', 'exec -a grep vercel deploy', 'sudo -p grep vercel deploy',
    'echo x | xargs -I grep vercel deploy', 'env -u which vercel deploy', 'exec -a rg vercel deploy', 'sudo -p type vercel deploy'],
  // r4 M3: runners still off the list.
  'r4 M3': ['npm -w docs exec vercel deploy', 'npm -w test exec -- vercel deploy', 'npm --tag test exec vercel deploy', 'npm --node-options test exec vercel deploy',
    HD('python3 /dev/stdin', "os.system('vercel deploy')"), HD('python3 /dev/fd/0', "os.system('vercel deploy')"), 'python3 /dev/stdin <<< "os.system(\'vercel deploy\')"',
    HD('node /dev/stdin', "x('vercel deploy')"), HD('R --no-save', 'system("vercel deploy")'), HD('expect', 'spawn vercel deploy'), HD('expect -f -', 'spawn vercel deploy'),
    HD('pwsh', 'vercel deploy'), HD('bun -', "x('vercel deploy')"), "lua5.4 -e 'os.execute(\"vercel deploy\")'", 'node --eval="x(\'vercel deploy\')"',
    'uv run -- vercel deploy', 'uv run python -c "os.system(\'vercel deploy\')"', 'uvx vercel deploy', 'op run -- vercel deploy', 'doppler run -- vercel deploy',
    'dotenvx run -- vercel deploy', 'infisical run -- vercel deploy', 'mise exec -- vercel deploy', 'mise x -- vercel deploy', 'asdf exec vercel deploy',
    'direnv exec . vercel deploy', 'poetry run vercel deploy', 'pipx run vercel deploy', "make -f /dev/null --eval='x:;vercel deploy' x", "vim -c '!vercel deploy'",
    "gdb -batch -ex 'shell vercel deploy'", "sqlite3 :memory: '.shell vercel deploy'", 'chronic vercel deploy', 'zellij run -- vercel deploy', 'dtach -n /tmp/s vercel deploy',
    'abduco -n s vercel deploy', 'mosh host vercel deploy', 'autossh host vercel deploy', "chokidar '*.ts' -c 'vercel deploy'", "onchange '*.ts' -- vercel deploy"],
  // r4 m2, m3: the install-if-missing line (the ruled trade), and a for-in word whose trailing slash the loop takes off.
  'r4 m2, m3': ['command -v vercel || npm i -g vercel', 'command -v supabase || brew install supabase/tap/supabase', 'which vercel || npm i -g vercel',
    'for f in node_modules/.bin/vercel/; do timeout 5 ${f%/} deploy; done', 'ls -l $(which vercel)', 'which supabase | xargs ls -l'],
  // r5 m4 (P14, P9): the lookup shape takes only -v and -V; the message shape only gh pr|issue create, comment and edit.
  'r5 m4': ['command -p vercel deploy', 'command -x vercel deploy', 'command -- vercel deploy',
    MSG('gh pr merge 5 --body', 'vercel'), MSG('gh pr review 5 --approve --body', 'vercel'), MSG('gh pr close 5 --comment', 'vercel'),
    MSG('gh issue close 5 --comment', 'vercel'), MSG('gh pr ready 5 --body', 'vercel'), MSG('gh issue delete 5 --body', 'vercel')],
  // r4 m4 (D31): git's -C value is not its subcommand.
  'r4 m4 D31': ['git -C /x bisect run vercel deploy', "git -C /x rebase -x 'vercel deploy' main", 'git -C commit bisect run vercel deploy'],
  // r2 M1: wrappers, strings handed to a shell, inline code.
  'r2 M1': ['timeout 300 vercel deploy --prod', 'echo deploy | xargs -n 1 vercel', 'env -S "vercel deploy"', 'setsid vercel deploy', 'noglob vercel deploy',
    'echo "vercel deploy --prod" | bash', 'bash <<< "vercel deploy"', 'timeout 300 ./node_modules/.bin/vercel deploy', 'timeout 300 npx vercel@latest deploy',
    "timeout 300 v'e'rcel deploy", 'timeout 300 v\\ercel deploy', 'timeout 300 VERCEL deploy', 'eval vercel deploy', 'VERCEL=1 bash -c "vercel deploy"'],
  // Near misses of the allowed shapes: anything else on the line, a substitution, a runner option, a second command.
  'near misses': [`${MSG('git commit -m', 'Fix vercel')} && git push`, `${MSG('git commit -m', 'Fix vercel')}; true`, 'git commit -m "$(vercel whoami)"',
    'git commit -m "x `vercel whoami`"', 'git commit -F - <<EOF\n$(vercel deploy)\nEOF', HD('git commit -F -', 'vercel') + '\ntrue', `${MSG('git commit -m', 'x')}\ntimeout 5 vercel deploy`, `${HD('git commit -F -', 'vercel')} | cat`,
    'git -c core.fsmonitor=vercel commit -m x', 'GIT_EDITOR=vercel git commit', 'git log --grep vercel', 'git grep vercel', 'git commit -m vercel > out',
    'rg --pre vercel x', 'rg --pre=vercel x', 'rg --hostname-bin=vercel x', 'ag --pager vercel x', 'grep vercel x | sh', 'grep vercel x | sort --compress-program=vercel',
    'grep x y | sort --com=vercel', 'grep vercel x; vercel deploy', 'grep vercel $(git ls-files)', 'rg supabase $(git ls-files)', 'grep vercel x > out',
    'which vercel | xargs ls -l', 'command -v vercel; vercel deploy', 'type vercel && vercel deploy', 'which ./vercel', 'command vercel', 'npm i vercel', 'pnpm add -D supabase'],
};
const ALLOWED = [MSG('git commit -m', 'Fix Vercel build config\n\nCo-Authored-By: x'), MSG('git commit -m', 'Move to Supabase auth'), MSG('git tag -a v1 -m', 'vercel'),
  "git commit --message=\"$(cat <<'EOF'\nvercel\nEOF\n)\"", `${MSG('gh pr create --title "Vercel" --body', 'Runs psql against staging')}`, MSG('gh issue comment 5 --body', 'vercel'),
  HD('git commit -F -', 'vercel deploy $(x) `y`'), HD('gh pr edit 5 --body-file -', 'supabase'), "git -C /x commit -F - <<'M'\nvercel\nM\n", "git commit -am 'vercel'",
  'git commit -m "fix vercel config"', "git -C /x commit -m 'supabase'",
  'grep vercel x', 'rg supabase src/', "rg -n 'supabase.from' src/", 'grep -rn vercel . | head -20', 'rg -l vercel | wc -l', 'grep -c psql *.sql | sort -rn | head -5', 'ag supabase',
  'grep -e x -e vercel src/', 'egrep "vercel|supabase" README.md',
  'command -v vercel', 'which vercel psql supabase', 'type -a vercel', 'command -V supabase'];
for (const [family, cases] of Object.entries(MUST_REFUSE)) {
  test(`#487 r5 (L1075): in the machine-wide form, ${family} naming a production program are refused`, () => {
    const { d, f } = copyAt(makeSnapshot({ ...RULES, production: { ...RULES.production, programs: PROGRAMS } }));
    const bash = (command) => decide({ tool_name: 'Bash', cwd: d, tool_input: { command } }, wide(f));
    for (const c of cases) {
      const r = bash(c);
      assert.equal(r.block, true, c); assert.match(r.reason, /names the production program "(vercel|supabase|psql)"/, c);
      ruleBlock(r, c);
    }
  });
}
test('#487 r5 (L1075): the three allowed shapes may name a production program; the same lines naming none pass too', () => {
  const { d, f } = copyAt(makeSnapshot({ ...RULES, production: { ...RULES.production, programs: PROGRAMS } }));
  const bash = (command) => decide({ tool_name: 'Bash', cwd: d, tool_input: { command } }, wide(f));
  for (const c of ALLOWED) assert.deepEqual(bash(c), { block: false }, c);
  for (const c of ['ls', 'git status', 'npm test', 'timeout 300 npm test', HD('python3 -', 'print(1)'), 'npm i -D eslint', 'cat vercel.json', 'ls vercel-notes', 'sudo -u me ls'])
    assert.deepEqual(bash(c), { block: false }, c);
  // The block names the allowed shapes and the way to switch the guard off.
  const r = bash('timeout 300 vercel deploy --prod');
  for (const part of ['git commit', 'grep / rg / ag', 'command -v / which / type', `sudo rm "${MANAGED_FILE}"`]) assert.ok(r.reason.includes(part), part);
});
test('#487 r5 (L1075): a slashed word that is an existing folder or a file no one may run is no program; one that may run still refuses', () => {
  const { d, f } = copyAt(makeSnapshot({ ...RULES, production: { ...RULES.production, programs: PROGRAMS } }));
  for (const p of ['supabase/migrations', 'src/lib/supabase', 'utils/supabase', 'node_modules/.bin', 'docs']) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, 'node_modules/.bin/vercel'), '#!/bin/sh\n'); chmodSync(join(d, 'node_modules/.bin/vercel'), 0o755);
  writeFileSync(join(d, 'docs/vercel'), 'notes\n'); chmodSync(join(d, 'docs/vercel'), 0o644);
  // A folder under a bin folder still counts: a session may cd to where that path is the program.
  mkdirSync(join(d, 'vendor/bin/supabase'), { recursive: true });
  const tool = join(d, 'tools'); mkdirSync(tool); writeFileSync(join(tool, 'supabase'), '#!/bin/sh\n'); chmodSync(join(tool, 'supabase'), 0o755);
  const bash = (command, cwd = d) => decide({ tool_name: 'Bash', cwd, tool_input: { command } }, wide(f));
  for (const c of ['pnpm exec vitest src/lib/supabase', 'npx eslint src/lib/supabase', 'npx prettier --check supabase/', 'npm run lint -- src/lib/supabase',
    'for f in src/lib/supabase/*; do echo $f; done', 'for f in supabase/migrations/*.sql; do echo $f; done', 'git log -- supabase/', 'git add supabase/ vercel.json',
    'ls supabase/', 'ls -la src/lib/supabase utils/supabase', 'cat docs/vercel', `ls ${d}/src/lib/supabase`, 'ls /no/such/folder/vercel']) {
    assert.deepEqual(bash(c), { block: false }, c);
  }
  for (const c of ['./node_modules/.bin/vercel deploy', 'node_modules/.bin/vercel deploy', 'timeout 5 node_modules/.bin/vercel deploy', `${tool}/supabase db push`,
    'cd node_modules/.bin && ./vercel deploy', `cd ${tool} && ./supabase db push`, 'cd /opt/homebrew && bin/supabase db push', '../supabase x', 'ls supabase',
    'mkdir -p newdir/supabase', 'for f in node_modules/.bin/vercel/; do ${f%/} deploy; done', `for f in ${tool}/supabase/*; do \${f%/*} x; done`,
    'vendor/bin/supabase db push', 'ls ./vendor/bin/supabase', 'ls ~/x/supabase', 'ls ${HOME}/x/supabase', 'tmux new -d -s web "cd ~/proj/supabase && npm run dev"']) {
    assert.equal(bash(c).block, true, c);
  }
  // With no working folder a relative path can't be read, so it counts.
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'ls src/lib/supabase' } }, wide(f)).block, true);
});
test('#487 r5 (L1075): shellCommands reads on past a here-document\'s end line, and the role form refuses what came after it', () => {
  assert.deepEqual(shellCommands("cat <<'A'\nx\nA\ntimeout 5 vercel deploy"), [['cat'], ['timeout', '5', 'vercel', 'deploy']]);
  assert.deepEqual(shellCommands("git commit -F - <<'EOF'\nmsg\nEOF\ntimeout 5 ls\nA\nls"), [['git', 'commit', '-F', '-'], ['timeout', '5', 'ls'], ['A'], ['ls']]);
  assert.match(unreadable(`${HD('git commit -F -', 'msg')}\ntimeout 300 npm test`) ?? '', /timeout/);
  assert.match(unreadable(`${HD('cat > n.md', 'x')}\npython3 -c "print(1)"`) ?? '', /python3/);
  assert.equal(unreadable(HD('git commit -F -', 'msg')), null);
});

// The chdir/z cases are also caught by the first-command rule (a wildcard after `chdir p &&` is never in the first command),
// so a plant taking chdir or z off the folder changers alone is not caught here: the list is a second guard.
test('#487 r4 m1 (L1066): chdir and z change folder, and a wildcard is judged by its folder only in the first command of the line', () => {
  const p = realpathSync(tempDir('orch-mw-prod-'));
  const { d, f } = copyAt(makeSnapshot({ production: { env_files: [join(p, '.prodsettings')], programs: ['vercel'], hosts: ['prod.example.com'] }, secrets: { paths: [] } }));
  const bash = (command, cwd = d) => decide({ tool_name: 'Bash', cwd, tool_input: { command } }, wide(f));
  for (const c of [`chdir ${p} && cat .p*`, `z ${p} && cat .p*`, `zi app; cat .p*`, 'true; cat .p*', 'ls && cat .p*', 'ls | cat .p*', 'echo "$(cat .p*)"']) {
    assert.equal(bash(c).block, true, c); assert.match(bash(c).reason, /production settings file/, c);
  }
  for (const c of ['cat .p*', 'cat .p* | wc -l', 'ls -d .* && echo done', 'cat x .p*; true']) assert.deepEqual(bash(c), { block: false }, `first command, in a project folder: ${c}`);
});

test('L1044 A1, A2: the root chain is judged all the way up: a folder written by others two levels above the copy is refused', () => {
  const { d } = copyAt();
  const mid = join(d, 'a'); const low = join(mid, 'b'); mkdirSync(low, { recursive: true }); chmodSync(low, 0o755);
  const f = join(low, 'c.json'); writeFileSync(f, makeSnapshot(RULES)); chmodSync(f, 0o644);
  chmodSync(mid, 0o755); assert.deepEqual(decide(HARMLESS, wide(f)), { block: false }, 'a clean chain passes');
  chmodSync(mid, 0o775); assert.match(rootChainProblem(f, ME), /folder .*\/a above/); wayOut(decide(HARMLESS, wide(f)));
  chmodSync(mid, 0o755); chmodSync(d, 0o757); assert.match(rootChainProblem(f, ME), new RegExp(`folder ${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} above`));
  chmodSync(d, 0o755);
  if (ME !== 0) assert.match(rootChainProblem(f, ME + 1), /not root's alone/, 'a chain owned by someone neither root nor the stand-in');
});

test('L1044 m1: a copy stamped ahead of the clock still guards in the machine-wide form; the role form refuses it', () => {
  const { f } = copyAt(makeSnapshot(RULES, new Date(Date.now() + YEAR)));
  assert.deepEqual(decide(HARMLESS, wide(f)), { block: false }, 'a clock set back must not lock every session out');
  assert.match(decide(PROD, wide(f)).reason, /"vercel" reaches production/);
  assert.match(decide(HARMLESS, { snapshot: f }).reason, /from the future/);
});
