// merge-guard.test.mjs — the merge guard's tests (Bob D-018). Run: node --test scripts/hooks/merge-guard.test.mjs
// (also run by scripts/selftest-gate-scripts.sh). Hermetic: GitHub is a fixture — an injected `gh` for the decision,
// a fake `gh` program on PATH for the wired hook — so nothing here reaches the network.
//
// Ported by Joe Wang from the guard's original test suite in one of his own private projects (same block/allow
// table, same mutation proof), with neutral fixtures and a different runner (node:test, so Bob needs no packages):
//   1. the decision on fixture `gh pr checks` outputs: all pass, one fail, pending, skipped, missing, gh error;
//   2. which commands are merges (and which only mention one) — the block/allow table;
//   3. the two stages: an empty list lets merges through with a notice; a missing list refuses;
//   4. the hook as bob-init wires it, run the way Claude Code runs it, in a freshly scaffolded project;
//   5. mutation proof: deleting any one refusal line makes the table fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GH_BUDGET_MS, commandFromHookInput, cwdFromHookInput, decideChecks, findMergeActions, guardCommand, loadRequiredSpec,
  parsePrRef,
} from "./lib/merge-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOB = resolve(HERE, "..", "..");
const LIB = join(HERE, "lib", "merge-guard.mjs");

/** A neutral required set: three checks that must pass, one that may skip itself. */
const spec = {
  branch: "main",
  workflow: "CI",
  required: [
    { name: "build", may_skip: false, why: "type-check, tests, build" },
    { name: "unit-tests", may_skip: true, why: "skips itself when nothing it tests changed" },
    { name: "secrets-scan", may_skip: false, why: "no leaked key reaches main" },
    { name: "workflow-lint", may_skip: false, why: "a broken workflow file silently stops a job" },
  ],
};

const STATE = { pass: "SUCCESS", fail: "FAILURE", pending: "IN_PROGRESS", skipping: "SKIPPED", cancel: "CANCELLED" };
const row = (name, bucket, workflow = "CI") => ({ name, bucket, workflow, state: STATE[bucket] ?? "?" });
/** The real shape of `gh pr checks N --json name,state,bucket,workflow`, every required check passing. */
const ALL_PASS = [
  row("unit-tests", "pass"), row("workflow-lint", "pass"), row("build", "pass"), row("secrets-scan", "pass"),
  row("changes", "pass"), row("Preview Comments", "pass", ""),
  row("slow-end-to-end", "fail", "Nightly"), row("changes", "pass", "Nightly"), row("Deploy preview", "pass", ""),
];
const swap = (rows, name, bucket) => rows.map((r) => (r.name === name && r.workflow === "CI" ? row(name, bucket) : r));

describe("the template list (templates/required-checks.json)", () => {
  it("loads, starts in the no-CI-yet stage, and protects main", () => {
    const t = loadRequiredSpec(join(BOB, "templates", "required-checks.json"));
    assert.deepEqual(t.required, []);
    assert.equal(t.branch, "main");
  });
  it("a missing or malformed list throws (the caller turns that into a refusal)", () => {
    const d = mkdtempSync(join(tmpdir(), "mg-spec-"));
    assert.throws(() => loadRequiredSpec(join(d, "nope.json")));
    writeFileSync(join(d, "bad.json"), JSON.stringify({ required: [{ why: "no name" }] }));
    assert.throws(() => loadRequiredSpec(join(d, "bad.json")), /needs a "name"/);
    writeFileSync(join(d, "bad2.json"), JSON.stringify({ required: [], branch: "main; rm -rf /" }));
    assert.throws(() => loadRequiredSpec(join(d, "bad2.json")), /plain branch name/);
  });
});

describe("decideChecks — fixture `gh pr checks` outputs", () => {
  it("all required checks pass → allowed (a red check that is NOT required does not block)", () => {
    assert.deepEqual(decideChecks(ALL_PASS, spec), { ok: true });
  });
  it("one required check failed → refused, naming it", () => {
    const d = decideChecks(swap(ALL_PASS, "build", "fail"), spec);
    assert.equal(d.ok, false); assert.equal(d.check, "build");
    assert.equal(d.why, 'required check "build" failed');
  });
  it("a required check still running → refused", () => {
    const d = decideChecks(swap(ALL_PASS, "secrets-scan", "pending"), spec);
    assert.equal(d.check, "secrets-scan"); assert.match(d.why, /still running/);
  });
  it("cancelled counts as not passing", () => {
    assert.equal(decideChecks(swap(ALL_PASS, "workflow-lint", "cancel"), spec).check, "workflow-lint");
  });
  it("skipped: allowed for a may_skip check, refused for any other", () => {
    assert.deepEqual(decideChecks(swap(ALL_PASS, "unit-tests", "skipping"), spec), { ok: true });
    const d = decideChecks(swap(ALL_PASS, "build", "skipping"), spec);
    assert.equal(d.check, "build"); assert.match(d.why, /skipped, and it must run/);
  });
  it("a required check missing from the list (or reported by another workflow) → refused", () => {
    assert.equal(decideChecks(ALL_PASS.filter((r) => r.name !== "secrets-scan"), spec).check, "secrets-scan");
    const elsewhere = ALL_PASS.map((r) => (r.name === "secrets-scan" ? { ...r, workflow: "Other" } : r));
    assert.equal(decideChecks(elsewhere, spec).check, "secrets-scan");
    assert.equal(decideChecks([], spec).ok, false);
  });
  it("no workflow named → a check of that name from any workflow counts", () => {
    const anyWf = { required: [{ name: "build" }] };
    assert.deepEqual(decideChecks([row("build", "pass", "Whatever")], anyWf), { ok: true });
  });
  it("a failure is named before a pending check, and the rest are counted", () => {
    const d = decideChecks(swap(swap(ALL_PASS, "build", "pending"), "workflow-lint", "fail"), spec);
    assert.equal(d.check, "workflow-lint"); assert.match(d.why, /\+1 more/);
  });
  it("not a list → refused", () => {
    assert.equal(decideChecks({ message: "x" }, spec).ok, false);
    assert.equal(decideChecks(null, spec).ok, false);
  });
});

describe("guardCommand — the whole decision, gh injected", () => {
  const ghWith = (checks) => {
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args[1] === "view") return { ok: true, stdout: JSON.stringify({ number: 77 }), stderr: "" };
      return checks;
    };
    return { gh, calls };
  };
  const green = { ok: true, stdout: JSON.stringify(ALL_PASS), stderr: "" };

  it("ordinary merge commands pass through when the checks pass", () => {
    for (const c of [
      "gh pr merge 101 --squash --delete-branch",
      "gh pr merge 202 --squash --match-head-commit $(gh pr view 202 --json headRefOid --jq .headRefOid)",
      "gh pr merge --squash --admin",
      "gh api -X PUT repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash",
    ]) assert.equal(guardCommand(c, { gh: ghWith(green).gh, spec }), null, c);
  });
  it("asks GitHub for the checks of the PR the command names, in the repo it names", () => {
    const { gh, calls } = ghWith(green);
    guardCommand("gh -R acme/widgets pr merge 12 --squash", { gh, spec });
    assert.deepEqual(calls, [["pr", "checks", "12", "-R", "acme/widgets", "--json", "name,state,bucket,workflow"]]);
    const u = ghWith(green);
    guardCommand("gh pr merge https://github.com/o/r/pull/9", { gh: u.gh, spec });
    assert.deepEqual(u.calls[0], ["pr", "checks", "9", "-R", "o/r", "--json", "name,state,bucket,workflow"]);
  });
  it("a red check → a one-line refusal naming the check and the PR", () => {
    const msg = guardCommand("gh pr merge 101 --squash", { gh: ghWith({ ok: false, stdout: JSON.stringify(swap(ALL_PASS, "build", "fail")), stderr: "" }).gh, spec });
    assert.match(msg, /^BLOCKED \(merge guard\): PR #101 — required check "build" failed; /);
    assert.ok(!msg.includes("\n"));
  });
  it("gh errors (no JSON, auth failure, timeout) → refused: fails CLOSED", () => {
    for (const err of [
      { ok: false, stdout: "", stderr: "HTTP 502: Bad Gateway\n" },
      { ok: false, stdout: "", stderr: "spawnSync gh ETIMEDOUT" },
      { ok: false, stdout: "no checks reported on the 'x' branch", stderr: "" },
      { ok: true, stdout: "{not json", stderr: "" },
    ]) assert.match(guardCommand("gh pr merge 5", { gh: ghWith(err).gh, spec }), /^BLOCKED \(merge guard\): PR #5 — could not read its checks/);
  });
  it("a branch name or no PR at all is resolved through gh; if gh cannot say, refused", () => {
    const { gh, calls } = ghWith(green);
    assert.equal(guardCommand("gh pr merge my-branch --squash", { gh, spec }), null);
    assert.deepEqual(calls[0], ["pr", "view", "my-branch", "--json", "number"]);
    assert.deepEqual(calls[1].slice(0, 3), ["pr", "checks", "77"]);
    const failing = (args) => (args[1] === "view" ? { ok: false, stdout: "", stderr: "no pull requests found" } : green);
    assert.match(guardCommand("gh pr merge my-branch", { gh: failing, spec }), /could not find the PR for "my-branch"/);
  });
  it("no PR named after a `cd` → refused (the hook cannot know which branch that folder is on)", () => {
    const { gh, calls } = ghWith(green);
    assert.match(guardCommand("cd ../other && gh pr merge --squash", { gh, spec }), /name the PR/);
    assert.deepEqual(calls, []);
  });
  it("every merge in a compound command is checked; one red one refuses the whole command", () => {
    const gh = (args) => ({ ok: true, stdout: JSON.stringify(args[2] === "6" ? swap(ALL_PASS, "secrets-scan", "fail") : ALL_PASS), stderr: "" });
    assert.match(guardCommand("gh pr merge 5 --squash && gh pr merge 6 --squash", { gh, spec }), /PR #6 — required check "secrets-scan" failed/);
  });
  it("commands that are not merges never call gh", () => {
    for (const c of ["npm test", "git push -u origin my-branch", "gh pr create --title t --body 'gh pr merge later'", "gh pr view 5"]) {
      const { gh, calls } = ghWith(green);
      assert.equal(guardCommand(c, { gh, spec }), null, c);
      assert.deepEqual(calls, [], c);
    }
  });
  it("a different protected branch name is honoured everywhere", () => {
    const trunk = { ...spec, branch: "trunk" };
    assert.match(guardCommand("git push origin trunk", { gh: ghWith(green).gh, spec: trunk }), /direct push to trunk/);
    assert.equal(guardCommand("git push origin main", { gh: ghWith(green).gh, spec: trunk }), null);
    assert.match(guardCommand("gh api -X PATCH repos/o/r/git/refs/heads/trunk -f sha=abc", { gh: ghWith(green).gh, spec: trunk }), /refs\/heads\/trunk/);
  });
});

describe("the two stages (Bob addition)", () => {
  const neverAsked = (args) => { throw new Error(`gh was asked (${args.join(" ")})`); };
  it("no CI yet (empty list): merges and pushes to main go ahead, each with a one-line notice", () => {
    for (const c of ["gh pr merge 5", "git push origin main", "git push origin HEAD:main"]) {
      const notes = [];
      assert.equal(guardCommand(c, { gh: neverAsked, spec: { required: [] }, notice: (m) => notes.push(m) }), null, c);
      assert.equal(notes.length, 1, c);
      assert.match(notes[0], /no required checks are listed yet/);
    }
  });
  it("no CI yet: an ordinary command gets no notice", () => {
    const notes = [];
    assert.equal(guardCommand("git push origin my-branch", { gh: neverAsked, spec: { required: [] }, notice: (m) => notes.push(m) }), null);
    assert.deepEqual(notes, []);
  });
  it("a missing list refuses every merge and push to main, and nothing else", () => {
    const missing = join(tmpdir(), "mg-no-such-dir", "required-checks.json");
    assert.match(guardCommand("gh pr merge 5", { gh: neverAsked, specPath: missing }), /required-check list could not be read/);
    assert.match(guardCommand("git push origin main", { gh: neverAsked, specPath: missing }), /required-check list could not be read/);
    assert.equal(guardCommand("git push origin my-branch", { gh: neverAsked, specPath: missing }), null);
  });
});

describe("findMergeActions — what counts as a merge", () => {
  const kinds = (c) => findMergeActions(c).map((a) => (a.kind === "pr" ? `pr:${a.ref}` : "refuse"));
  for (const [c, want] of [
    ["gh pr merge 101 --squash", ["pr:101"]],
    ["GH_TOKEN=x timeout 60 gh pr merge 8", ["pr:8"]],
    ["bash -c 'gh pr merge 5'", ["pr:5"]],
    ['echo "$(gh pr merge 9)"', ["pr:9"]],
    ["cat <<EOF | bash\ngh pr merge 5\nEOF", ["pr:5"]],
    ["gh api repos/o/r/pulls/12/merge --method PUT", ["pr:12"]],
    ["gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'", ["refuse"]],
    ["gh api -X POST repos/o/r/merges -f base=main -f head=x", ["refuse"]],
    ["gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc", ["refuse"]],
    ["git push origin HEAD:main", ["refuse"]],
    ["git push origin main", ["refuse"]],
    ["git -C /tmp/x push origin +main", ["refuse"]],
    ["git push --mirror origin", ["refuse"]],
    ["echo 5 | xargs gh pr merge", ["refuse"]],
    ["curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge", ["refuse"]],
    ["node -e \"require('child_process').execSync('gh pr merge 5')\"", ["refuse"]],
    ["gh pr merge --match-head-commit $(gh pr view 202 --json headRefOid -q .headRefOid) 202 --squash", ["pr:202"]],
    ["gh pr merge $(gh pr list --head foo --json number -q '.[0].number') --squash", ["refuse"]],
    ["gh pr merge -s `echo 202`", ["refuse"]],
    ["gh api -XPUT repos/o/r/pulls/202/merge", ["pr:202"]],
  ]) it(c, () => assert.deepEqual(kinds(c), want));

  for (const c of [
    "gh api repos/o/r/pulls/12/merge",
    "git push -u origin feature-main",
    "gh pr merge 5 --disable-auto",
    "git commit -m \"guard gh pr merge when red\"",
    "gh pr create --title x --body 'then gh pr merge 5'",
    "grep -rn 'pr merge' docs",
    "git log refs/heads/main",
    "git push origin my-branch  # not main: gh pr merge comes later",
  ]) it(`not a merge: ${c}`, () => assert.deepEqual(findMergeActions(c), []));

  it("parsePrRef reads numbers and PR links; a branch name needs GitHub", () => {
    assert.deepEqual(parsePrRef("101"), { number: 101, repo: null });
    assert.deepEqual(parsePrRef("#12"), { number: 12, repo: null });
    assert.deepEqual(parsePrRef("https://github.com/acme/widgets/pull/404"), { number: 404, repo: "acme/widgets" });
    assert.equal(parsePrRef("feature/some-branch"), null);
  });
  it("reads the command out of Claude Code's hook input (Bash and Monitor)", () => {
    assert.equal(commandFromHookInput(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 1" } })), "gh pr merge 1");
    assert.equal(commandFromHookInput(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })), null);
    assert.equal(commandFromHookInput(JSON.stringify({ tool_name: "Monitor", tool_input: { command: "until gh pr checks 5; do sleep 30; done; gh pr merge 5" } })), "until gh pr checks 5; do sleep 30; done; gh pr merge 5");
    assert.equal(commandFromHookInput(JSON.stringify({ tool_name: "Monitor", tool_input: { ws: { url: "wss://x" } } })), null);
    assert.throws(() => commandFromHookInput("not json"));
    assert.equal(cwdFromHookInput(JSON.stringify({ cwd: "/tmp/wt" })), "/tmp/wt");
    assert.equal(cwdFromHookInput("not json"), null);
  });
});

// ── The block/allow table ─────────────────────────────────────────────────────────────────────────────────────
// "gated" rows are merges whose checks decide: blocked when a required check is red, let through when every one
// passes. "always" rows are refused whatever the checks say. "allow" rows must never even ask GitHub.

const GATED = [
  "gh pr merge 101 --squash",
  "gh pr merge",
  "gh pr merge 5 --auto --squash",
  "GH_TOKEN=x timeout 60 gh pr merge 8",
  "env X=y gh pr merge 5",
  "env -i PATH=/usr/bin gh pr merge 5",
  "env -S 'gh pr merge 5'",
  "sudo -u alice gh pr merge 5",
  "sudo -- gh pr merge 5",
  "timeout -s KILL 30 gh pr merge 5",
  "nohup gh pr merge 5 &",
  "time gh pr merge 5",
  "command gh pr merge 5",
  "exec gh pr merge 5",
  "nice -n 5 gh pr merge 5",
  "! gh pr merge 5",
  'FOO="a b" gh pr merge 5',
  "/opt/homebrew/bin/gh pr merge 5",
  '"gh" pr "merge" 5',
  "gh pr 'merge' 5",
  "npm test && gh pr merge 5",
  "npm test; gh pr merge 5",
  "false || gh pr merge 5",
  "echo ok | gh pr merge 5",
  "true && \\\n  gh pr merge 5",
  "(gh pr merge 5)",
  "{ gh pr merge 5; }",
  "if true; then gh pr merge 5; fi",
  "case x in x) gh pr merge 5;; esac",
  "gh pr merge 5 > /tmp/log 2>&1",
  "diff <(gh pr merge 5) /dev/null",
  "bash -c 'gh pr merge 5'",
  'bash -lc "gh pr merge 5"',
  "bash -o pipefail -c 'gh pr merge 5'",
  "sh -c 'cd /tmp; gh pr merge 5'",
  "zsh -c 'npm test && gh pr merge 5'",
  "bash -c \"bash -c 'gh pr merge 5'\"",
  "bash -c $'gh pr merge 5'",
  'eval "gh pr merge 5"',
  'echo "$(gh pr merge 9)"',
  "echo $(gh pr merge 9)",
  "echo `gh pr merge 9`",
  "X=$(gh pr merge 9)",
  'echo "${X:-$(gh pr merge 9)}"',
  'git commit -m "note: `gh pr merge 5`"', // double quotes: bash RUNS the backticks
  "cat <<EOF | bash\ngh pr merge 5\nEOF",
  "bash <<'EOF'\ngh pr merge 5\nEOF",
  "bash <<< 'gh pr merge 5'",
  "echo 'gh pr merge 5' | sh",
  "printf 'gh pr merge 5\\n' | bash -s",
  "cat <<EOF > notes.md\n$(gh pr merge 5)\nEOF", // an UNQUOTED here-doc runs its substitutions
  "gh -R acme/widgets pr merge 12",
  "gh pr merge https://github.com/o/r/pull/9",
  "gh pr merge my-branch --squash",
  "gh pr merge 202 --squash --match-head-commit $(gh pr view 202 --json headRefOid --jq .headRefOid)",
  "gh pr merge --match-head-commit $(gh pr view 202 --json headRefOid -q .headRefOid) 202 --squash",
  "gh api -X PUT repos/o/r/pulls/12/merge",
  "gh api repos/o/r/pulls/12/merge --method PUT",
  "gh api -XPUT repos/o/r/pulls/202/merge",
  "gh api -Xput repos/o/r/pulls/202/merge",
  "gh api -X=PUT repos/o/r/pulls/202/merge",
  "gh api --method=PUT repos/{owner}/{repo}/pulls/5/merge",
  "gh api repos/o/r/pulls/5/merge -f merge_method=squash",
  "gh api -X PUT /repos/o/r/pulls/5/merge",
  "gh api -X PUT https://api.github.com/repos/o/r/pulls/5/merge",
  "$GH pr merge 5",
  '"$(which gh)" pr merge 5',
  "arch -arm64 gh pr merge 5",
  "op run -- gh pr merge 5",
  "hub api -X PUT repos/o/r/pulls/5/merge",
  "git -c 'alias.m=!gh pr merge 5' m",
  "GH_REPO=o/r gh pr merge 5",
  "export GH_REPO=o/r; gh pr merge 5",
];

/** Refused whatever the checks say. */
const ALWAYS = [
  "cd ../other && gh pr merge --squash",
  `${"eval ".repeat(8)}gh pr merge 5`, // nested past the depth the guard reads
  "bash -c 'cd x && gh pr merge'",
  "cd x && bash -c 'gh pr merge'",
  "env -C ../x gh pr merge",
  "gh pr merge $(gh pr list --head foo --json number -q '.[0].number') --squash",
  "gh pr merge -s $(echo 202)",
  "gh pr merge -s `echo 202`",
  'gh pr merge "$N"',
  "for n in 5 6; do gh pr merge $n; done",
  "gh api -X PUT repos/o/r/pulls/$N/merge",
  "gh api -X PUT repos/o/r/pulls/head/merge",
  "gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { updateRef(input:{}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { createCommitOnBranch(input:{}) { commit { oid } } }'",
  "gh api /graphql -f query='mutation { mergeBranch(input:{}) { clientMutationId } }'",
  "gh api graphql --input - <<'EOF'\n{\"query\":\"mutation { mergePullRequest(input:{pullRequestId:\\\"x\\\"}) { clientMutationId } }\"}\nEOF",
  "gh api graphql -F query=@/nonexistent/guard-test/q.graphql",
  "cat q.json | gh api graphql --input -",
  "gh api -X POST repos/o/r/merges -f base=main -f head=x",
  "gh api repos/o/r/merges -f base=main -f head=x",
  "gh api -X POST repos/o/r/merge-upstream -f branch=main",
  "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc",
  "gh api -X DELETE repos/o/r/git/refs/heads/main",
  "gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc",
  "gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA==",
  "gh api -X PUT repos/o/r/contents/README.md -f branch=main -f message=x -f content=eA==",
  "gh repo sync acme/widgets --source x/y",
  "gh alias set mm 'pr merge'",
  "git push origin main",
  "git push origin HEAD:main",
  "git push origin +HEAD:main",
  "git push origin 'HEAD:main'",
  "git push origin HEAD:refs/heads/main",
  "git push origin feature:heads/main",
  "git push -f origin main",
  "git push origin --delete main",
  "git push origin :main",
  "git -C /tmp/x push origin +main",
  "git push --mirror origin",
  "git push --all origin",
  "git push --repo=origin HEAD:main",
  "git push https://github.com/o/r.git HEAD:main",
  "git push origin main 2>&1 | tail -5",
  "B=main; git push origin HEAD:$B",
  "B=main && git push origin \"HEAD:${B}\"",
  "git -c alias.p=push p origin main",
  "git send-pack origin main",
  "git update-ref refs/heads/main abc123",
  "hub push origin main",
  "$GIT push origin main",
  "bash -c 'git push origin HEAD:main'",
  "echo 5 | xargs gh pr merge",
  "xargs -I{} gh pr merge {} < prs.txt",
  "find . -name x -exec gh pr merge 5 \\;",
  "ssh box 'gh pr merge 5'",
  "watch -n 60 'gh pr merge 5'",
  "parallel gh pr merge ::: 5 6",
  "curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge",
  "curl -X POST https://api.github.com/graphql -d @q.json",
  "node -e \"require('child_process').execSync('gh pr merge 5')\"",
  "node -e \"require('child_process').execFileSync('gh', ['pr', 'merge', '5'])\"",
  "python3 -c \"import subprocess; subprocess.run(['gh','pr','merge','5'])\"",
  "python3 - <<'PY'\nimport os\nos.system('gh pr merge 5')\nPY",
  "echo \"import os; os.system('gh pr merge 5')\" | python3",
  "perl -e 'system(\"git push origin main\")'",
  "python3 -c \"import requests; requests.put('https://api.github.com/repos/o/r/pulls/5/merge')\"",
  "gh pr checkout 303 && gh pr merge --squash",
  "git switch fix/x && gh pr merge --squash",
  "git checkout fix/x && gh pr merge",
  "python3 x.py gh pr merge 5",
  "node scripts/x.mjs gh pr merge 5",
  "python3 -c \"import subprocess; args='pr merge 5'; subprocess.run(['gh'] + args.split())\"",
  "node -e \"const args=['pr','merge','5']; require('child_process').spawnSync('gh', args)\"",
  "sh -c \"$(printf 'gh pr merge 5')\"",
  "Q='mutation { mergePullRequest(input:{}) { clientMutationId } }'; gh api graphql -f query=\"$Q\"",
  "gh api graphql -f query=\"$(cat m.graphql)\"",
  "git push origin :", // matching refspec: pushes main too
  "git push origin 'refs/heads/*:refs/heads/*'",
  "sh -c 'git checkout x'; gh pr merge",
  "git branch -m other && gh pr merge",
];

/** Not merges: they must pass without asking GitHub at all. */
const ALLOW = [
  "git log --grep merge",
  'git log --grep="pr merge" --oneline',
  "git log refs/heads/main",
  "python3 - <<'PY'\nfrom pathlib import Path\np = Path('docs/notes.md')\np.write_text(p.read_text().replace('merge later', 'gh pr merge 5 once green; never git push origin main; refs/heads/main'))\nPY",
  "python3 - <<'PY'\nimport subprocess\nopen('notes.md','a').write('run gh pr merge 5 after green\\n')\nsubprocess.run(['git', 'add', 'notes.md'])\nPY",
  "python3 -c \"print('gh pr merge 5')\"",
  "python3 -c \"import subprocess; subprocess.run(['git','log','--grep','merge'])\"",
  "node -e \"console.log('pulls/5/merge')\"",
  "perl -pi -e 's/gh pr merge/merge via the guard/' notes.md",
  "node scripts/foo.mjs --note \"gh pr merge 5\"",
  "git merge origin/main",
  "git merge --no-edit origin/main",
  "cd ../wt && git merge origin/main",
  "git -C ../wt merge origin/main",
  "git fetch origin main && git merge origin/main",
  "git pull origin main",
  "git rebase origin/main",
  "git diff origin/main...HEAD",
  "git push origin HEAD:feature-x",
  "git push -u origin HEAD:fix/merge-guard",
  "git push origin HEAD:main-followups",
  "git push origin HEAD:refs/heads/feature",
  "git push -u origin feature-main",
  "git push origin my-branch",
  "git push --force-with-lease origin HEAD:my-branch",
  "git push origin my-branch  # not main: gh pr merge comes later",
  "B=feature; git push origin HEAD:$B",
  'git commit -m "fix gh pr merge guard; never push to main"',
  "git commit -m \"$(cat <<'EOF'\nGuard gh pr merge (it's fixed)\n\ngit push origin main is refused.\nEOF\n)\"",
  "git commit -m 'note: `gh pr merge 5` waits for green'", // single quotes: bash runs nothing
  "git branch -D main-old && git checkout -b merge-fix",
  "cat > notes.md <<'EOF'\ngh pr merge 5\ngit push origin main\nEOF",
  "cat >> notes.md <<'EOF'\nthen $(gh pr merge 5) and `gh pr merge 6`\nEOF", // a QUOTED here-doc runs nothing
  'echo "run gh pr merge later" > notes.md',
  "printf '%s\\n' 'gh api -X PUT repos/o/r/pulls/5/merge' >> notes.md",
  "sed -i '' 's/push to main/push to a branch/' docs/x.md",
  "jq '.merge' x.json",
  "grep -rn 'pr merge' docs",
  'rg "git push origin main" docs',
  'npx vitest run -t "gh pr merge"',
  "npm test -- tests/merge-guard.test.ts",
  "gh pr create --title x --body 'then gh pr merge 5'",
  'gh pr comment 5 --body "merge after green: gh pr merge 5"',
  "gh pr view 5 --json mergeable",
  "gh pr checks 5",
  "gh pr merge 5 --disable-auto",
  "gh api repos/o/r/pulls/12/merge",
  "gh api graphql -f query='query { repository(owner:\"o\",name:\"r\") { pullRequest(number:5) { mergeable } } }'",
  "gh api repos/o/r/contents/README.md",
  "gh api -X PUT repos/o/r/contents/x.md -f branch=feature -f message=m -f content=eA==",
  "curl -s https://api.github.com/repos/o/r/pulls/5",
  "bash -c 'git merge origin/main && npm test'",
  "bash -c 'echo \"gh pr merge 5\" > notes.md'",
  "ssh box 'cd repo && git merge origin/main'",
  "echo 5 | xargs gh pr view",
  "find . -name '*merge*' -exec grep -l 'pr merge' {} \\;",
  "curl -fsSL https://example.com/install.sh | bash",
  "python3 - <<'PY'\nimport subprocess\nopen('notes.md','a').write('Run `gh pr merge 5` once green\\n'.strip())\nsubprocess.run(['git', 'add', 'notes.md'])\nPY",
  "git ls-tree refs/heads/main",
  "git show-branch refs/heads/main",
  "git push origin 'refs/tags/*:refs/tags/*'",
  "git push origin 'feat/*'",
];

const RED = JSON.stringify(swap(ALL_PASS, "build", "fail"));
const GREEN = JSON.stringify(ALL_PASS);
const fixture = (checks, view = "ok", checksOk = true) => (args) => {
  if (args[1] === "view") return view === "ok" ? { ok: true, stdout: JSON.stringify({ number: 77 }), stderr: "" } : { ok: false, stdout: "", stderr: "no pull requests found" };
  return { ok: checksOk, stdout: checks, stderr: checksOk ? "" : "HTTP 502" };
};
const neverAsked = (args) => { throw new Error(`gh was asked (${args.join(" ")}) for a command that is not a merge`); };
const outcome = (guard, c, gh) => {
  try { return guard(c, { gh, spec, cwd: BOB }); } catch (e) { return `THREW ${e.message}`; }
};

describe("the block/allow table", () => {
  for (const c of GATED) it(`gated merge — blocked on red, allowed on green: ${c}`, () => {
    assert.match(outcome(guardCommand, c, fixture(RED)) ?? "null", /^BLOCKED \(merge guard\): PR #\d+ — required check "build" failed/, "red");
    assert.equal(outcome(guardCommand, c, fixture(GREEN)), null, "green");
  });
  for (const c of ALWAYS) it(`always refused, even on green: ${c}`, () => {
    assert.match(outcome(guardCommand, c, fixture(GREEN)) ?? "null", /^BLOCKED \(merge guard\): /);
  });
  for (const c of ALLOW) it(`allowed, GitHub never asked: ${c}`, () => {
    assert.equal(outcome(guardCommand, c, neverAsked), null);
  });
  it("fails closed on GitHub's side: no PR found, checks unreadable, a required check missing", () => {
    assert.match(outcome(guardCommand, "gh pr merge my-branch", fixture(GREEN, "fail")), /could not find the PR for "my-branch"/);
    assert.match(outcome(guardCommand, "gh pr merge 5", fixture("", "ok", false)), /PR #5 — could not read its checks/);
    assert.match(outcome(guardCommand, "gh pr merge 5", fixture(JSON.stringify(ALL_PASS.filter((r) => r.name !== "secrets-scan")))), /"secrets-scan" has not reported/);
  });
  it("GH_REPO names the repo whose checks are read", () => {
    const calls = [];
    const gh = (args) => { calls.push(args); return { ok: true, stdout: GREEN, stderr: "" }; };
    assert.equal(guardCommand("GH_REPO=o/r gh pr merge 5", { gh, spec, cwd: BOB }), null);
    assert.deepEqual(calls[0], ["pr", "checks", "5", "-R", "o/r", "--json", "name,state,bucket,workflow"]);
  });
  it("a pathologically nested command is refused fast (a throw is a refusal), never outrunning the hook's timeout", () => {
    const deep = `echo ${'"${a:-'.repeat(40)}x${'}"'.repeat(40)} && gh pr merge 5`;
    const t0 = Date.now();
    assert.throws(() => guardCommand(deep, { gh: fixture(GREEN), spec, cwd: BOB }), /too complex/);
    assert.ok(Date.now() - t0 < 5_000);
  });
});

// ── The hook as bob-init wires it, run the way Claude Code runs it ───────────────────────────────────────────
describe("the wired hook in a freshly scaffolded project (scripts/bob-init.sh)", () => {
  const box = mkdtempSync(join(tmpdir(), "mg-scaffold-"));
  const home = join(box, "home");
  mkdirSync(home);
  // a throw-away identity, and no global hooks, so the scaffold's first commit runs nothing from this machine
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = selftest\n\temail = selftest@example.com\n[core]\n\thooksPath = /dev/null\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  const nodeDir = dirname(process.execPath);
  const baseEnv = { PATH: `${nodeDir}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`, HOME: home };
  const init = spawnSync("bash", [join(BOB, "scripts", "bob-init.sh"), "demo"], { cwd: box, env: baseEnv, encoding: "utf8" });
  const project = join(box, "demo");
  const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"));
  const entries = settings.hooks.PreToolUse;
  const guardOn = (m) => entries.filter((e) => e.matcher === m).flatMap((e) => e.hooks).filter((h) => h.command.includes("merge-guard.mjs"));
  const guard = guardOn("Bash")[0];

  const bin = join(box, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ "$2" = "checks" ]; then printf '%s' "$FAKE_GH_OUT"; exit "\${FAKE_GH_EXIT:-0}"; fi\necho "unexpected gh $*" >&2; exit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const run = (command, fake, projectDir = project, tool = "Bash") => spawnSync("bash", ["-c", guard.command], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    cwd: box, // not a git checkout: the guard must be found through CLAUDE_PROJECT_DIR
    env: { PATH: `${bin}:${nodeDir}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: projectDir, FAKE_GH_OUT: fake.out, FAKE_GH_EXIT: String(fake.exit ?? 0), HOME: home },
    encoding: "utf8",
  });
  const withList = (list) => writeFileSync(join(project, ".claude", "required-checks.json"), JSON.stringify(list));

  it("bob-init ran, and wired the guard once on Bash and identically on Monitor", () => {
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.equal(guardOn("Bash").length, 1);
    assert.deepEqual(guardOn("Monitor").map((h) => h.command), guardOn("Bash").map((h) => h.command));
    assert.ok(entries.filter((e) => e.matcher === "Monitor").flatMap((e) => e.hooks).every((h) => h.command.includes("merge-guard.mjs")));
  });
  it("the hook's own timeout sits above the guard's GitHub budget (a hook timeout is a NON-blocking error)", () => {
    assert.ok(guard.timeout >= GH_BUDGET_MS / 1000 + 30);
  });
  it("the command has no bypass: no variable or flag turns it off", () => {
    assert.doesNotMatch(guard.command, /SKIP|BYPASS|NO_GUARD|DISABLE|\|\| true/i);
  });
  it("every hook path in the generated settings exists", () => {
    for (const e of Object.values(settings.hooks).flat()) for (const h of e.hooks) {
      for (const m of h.command.matchAll(/\.claude\/hooks\/[A-Za-z0-9_./-]+/g)) {
        assert.ok(spawnSync("test", ["-f", join(project, m[0])]).status === 0, m[0]);
      }
    }
  });
  it("stage 1 — the scaffold's empty list: a merge and a push to main go ahead, with the notice on stdout", () => {
    const r = run("git push origin main", { out: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).systemMessage, /no required checks are listed yet/);
    assert.equal(run("gh pr merge 3 --squash", { out: "" }).status, 0);
    assert.equal(run("npm test", { out: "" }).stdout, "");
  });
  it("stage 2 — checks named: green → exit 0; red → exit 2 with the one-line refusal", () => {
    withList(spec);
    const g = run("gh pr merge 101 --squash --delete-branch", { out: GREEN });
    assert.equal(g.stderr, ""); assert.equal(g.status, 0);
    const r = run("gh pr merge 101 --squash", { out: RED, exit: 1 });
    assert.equal(r.status, 2);
    assert.match(r.stderr.trim(), /^BLOCKED \(merge guard\): PR #101 — required check "build" failed; /);
    assert.equal(r.stderr.trim().split("\n").length, 1);
  });
  it("stage 2 — gh erroring → exit 2 (fails closed); a direct push to main → exit 2; a branch push → exit 0", () => {
    withList(spec);
    assert.match(run("gh pr merge 101", { out: "", exit: 1 }).stderr, /could not read its checks/);
    assert.equal(run("git push origin main", { out: "" }).status, 2);
    assert.equal(run("git push -u origin my-branch", { out: "" }).status, 0);
    assert.equal(run("gh pr merge 101", { out: RED }, project, "Monitor").status, 2);
  });
  it("the list missing → every merge and push to main refused", () => {
    const empty = mkdtempSync(join(tmpdir(), "mg-nolist-"));
    mkdirSync(join(empty, ".claude", "hooks", "lib"), { recursive: true });
    copyFileSync(join(project, ".claude", "hooks", "merge-guard.mjs"), join(empty, ".claude", "hooks", "merge-guard.mjs"));
    copyFileSync(join(project, ".claude", "hooks", "lib", "merge-guard.mjs"), join(empty, ".claude", "hooks", "lib", "merge-guard.mjs"));
    const r = run("gh pr merge 101", { out: GREEN }, empty);
    assert.equal(r.status, 2); assert.match(r.stderr, /required-check list could not be read/);
    assert.equal(run("git push origin feature", { out: "" }, empty).status, 0);
  });
  it("the guard file missing → exit 2 (fails closed), not a silent pass", () => {
    const r = run("gh pr merge 101", { out: GREEN }, mkdtempSync(join(tmpdir(), "mg-noproject-")));
    assert.equal(r.status, 2); assert.match(r.stderr, /merge-guard\.mjs not found/);
  });
  it("the guard crashing → exit 2 (the hook turns any failure into a refusal)", () => {
    const broken = mkdtempSync(join(tmpdir(), "mg-broken-"));
    mkdirSync(join(broken, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(broken, ".claude", "hooks", "merge-guard.mjs"), "throw new Error('boom');\n");
    assert.equal(run("gh pr merge 101", { out: GREEN }, broken).status, 2);
  });

  // The hook's word filter must route every refused command to the guard (it skips node for everything else).
  it("the word filter routes every gated and always-refused command to the guard", () => {
    const pattern = /grep -Eiq '([^']+)'/.exec(guard.command)[1];
    const filter = new RegExp(pattern, "i");
    for (const c of [...GATED, ...ALWAYS]) assert.ok(filter.test(JSON.stringify({ tool_name: "Bash", tool_input: { command: c } })), c);
  });
});

// ── Mutation proof: deleting any one refusal line makes the table fail ───────────────────────────────────────
describe("mutation proofs", async () => {
  const SRC = readFileSync(LIB, "utf8");
  const lines = SRC.split("\n");
  const marked = lines.map((l, n) => ({ n, id: /\/\/ refusal:([\w-]+)\s*$/.exec(l)?.[1] })).filter((x) => x.id);
  const missingList = join(tmpdir(), "mg-mutants-no-list", "required-checks.json");
  const scenarios = [
    ...GATED.flatMap((c) => [[c, fixture(RED)], [c, fixture(GREEN)]]),
    ...ALWAYS.map((c) => [c, fixture(GREEN)]),
    ...ALLOW.map((c) => [c, neverAsked]),
    ["gh pr merge my-branch", fixture(GREEN, "fail")],
    ["gh pr merge 5", fixture("", "ok", false)],
    ["gh pr merge 5", fixture(JSON.stringify(ALL_PASS.filter((r) => r.name !== "secrets-scan")))],
    ["gh pr merge 5", fixture(JSON.stringify(swap(ALL_PASS, "secrets-scan", "pending")))],
    ["gh pr merge 5", fixture(JSON.stringify(swap(ALL_PASS, "build", "skipping")))],
  ];
  const runAll = (m) => [
    ...scenarios.map(([c, gh]) => outcome(m.guardCommand, c, gh)),
    (() => { try { return m.guardCommand("gh pr merge 5", { gh: neverAsked, specPath: missingList }); } catch (e) { return `THREW ${e.message}`; } })(),
    ...[null, { message: "x" }].map((x) => { try { return JSON.stringify(m.decideChecks(x, spec)); } catch (e) { return `THREW ${e.message}`; } }),
  ];
  const baseline = runAll({ guardCommand, decideChecks });
  const tmp = mkdtempSync(join(tmpdir(), "mg-mutants-"));

  it("every refusal in the guard carries a marker, and each id is used once", () => {
    const ids = marked.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length >= 25, `only ${ids.length} markers`);
    lines.forEach((l, n) => {
      if (/refuse\("|return `BLOCKED|kind: "pr"|bad\.push\(/.test(l) && !/^\s*(\/\/|\*|\/\*\*)/.test(l)) {
        assert.ok(marked.some((m) => m.n === n), `line ${n + 1} refuses without a marker: ${l.trim()}`);
      }
    });
  });
  for (const { id, n } of marked) {
    it(`deleting refusal:${id} is caught by the table`, async () => {
      const mutated = lines.map((l, k) => (k === n ? `void 0; // MUTATED ${id}` : l)).join("\n");
      const file = join(tmp, `mutant-${id}.mjs`);
      writeFileSync(file, mutated);
      const mod = await import(pathToFileURL(file).href);
      const after = runAll(mod);
      const changed = after.filter((o, k) => o !== baseline[k]).length;
      assert.ok(changed > 0, `removing refusal:${id} changed no outcome — the table cannot see it`);
    });
  }
});
