// Launch check 6 (R-0b-35, R-0b-34, R-0b-39): start the role headless, read the start message it
// prints, and compare what it really loaded with what the role may have. Any mismatch or missing
// field means no start.
//
// Capability note: NOT VERIFIED against the pinned Claude Code (live proofs L2, L6). The fields the
// start message carries are named in settings-names.mjs (INIT_FIELDS); a missing one refuses.

import { spawn } from 'node:child_process';
import { FLAGS as F, INIT_FIELDS as I, ALLOWED_SETTING_SOURCES } from './settings-names.mjs';
import { NEVER_TOOLS, ALWAYS_TOLERATED } from './role-profiles.mjs';

const refuse = (reason) => ({ ok: false, reason });

/** The headless start command for a role. No tool server config but an empty one. */
export function roleArgs({ profile, settingsFile, model, prompt = 'Reply with the word ready.' }) {
  const a = [F.print, F.outputFormat, F.streamJson, F.verbose, F.tools, profile.tools.join(','), F.settings, settingsFile,
    F.strictMcpConfig, F.mcpConfig, '{"mcpServers":{}}', F.permissionMode, profile.mode];
  if (profile.restricted) a.push(F.restricted);
  if (model) a.push(F.model, model);
  a.push(F.maxTurns, '1', prompt);
  return a;
}

/** Finds the start message in a stream of JSON lines. */
export function findInit(text) {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m?.[I.type] === I.initType && m?.[I.subtype] === I.initSubtype) return m;
  }
  return null;
}

const names = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.name)).filter((x) => typeof x === 'string') : null);

/** Compares a start message with the role. */
export function checkInit(init, { role, profile }) {
  if (!init) return refuse('no start message');
  for (const k of [I.tools, I.mcpServers, I.plugins, I.skills, I.settingSources, I.permissionMode]) {
    if (!Object.hasOwn(init, k)) return refuse(`start message has no ${k}`);
  }
  const tools = names(init[I.tools]);
  if (!tools) return refuse('start message tools are not a list');
  const never = tools.filter((t) => NEVER_TOOLS.includes(t));
  if (never.length) return refuse(`never-list tools loaded: ${never.join(', ')}`);
  const loaded = tools.filter((t) => !ALWAYS_TOLERATED.includes(t)).sort();
  const want = [...profile.tools].sort();
  if (JSON.stringify(loaded) !== JSON.stringify(want)) return refuse(`tools differ: loaded ${loaded.join(',')}, role has ${want.join(',')}`);
  if ((names(init[I.mcpServers]) ?? ['?']).length) return refuse('a tool server is loaded');
  if ((names(init[I.plugins]) ?? ['?']).length) return refuse('a plugin is loaded');
  const skills = names(init[I.skills]);
  const wantSkills = [...(profile.skills ?? [])].sort();
  if (!skills || JSON.stringify([...skills].sort()) !== JSON.stringify(wantSkills)) return refuse(`skills differ: ${skills?.join(',') ?? '?'}`);
  const sources = names(init[I.settingSources]);
  if (!sources || !sources.includes('flag') || sources.some((s) => !ALLOWED_SETTING_SOURCES.includes(s))) return refuse(`settings sources are ${sources?.join(',') ?? '?'}, want managed and --settings only`);
  if (init[I.permissionMode] !== profile.mode) return refuse(`permission mode is ${init[I.permissionMode]}, role has ${profile.mode}`);
  return { ok: true, version: init[I.version] ?? null, role };
}

/**
 * Runs the role headless, stops it as soon as the start message is in, and checks it.
 * `spawnFn` is for tests (a fake claude). Never waits more than `timeoutMs`.
 */
export function readBack({ claudeBin, args, env, cwd, role, profile, spawnFn = spawn, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { child?.kill('SIGKILL'); } catch {} resolve(r); };
    const t = setTimeout(() => finish(refuse('no start message in time')), timeoutMs);
    try { child = spawnFn(claudeBin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return finish(refuse(`could not start: ${e.message}`)); }
    child.on('error', (e) => finish(refuse(`could not start: ${e.message}`)));
    child.stdout.on('data', (d) => {
      out += d;
      const init = findInit(out);
      if (init) finish(checkInit(init, { role, profile }));
    });
    child.on('close', () => finish(checkInit(findInit(out), { role, profile })));
  });
}
