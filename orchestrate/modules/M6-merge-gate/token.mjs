// token.mjs — the robot's installation token: minted per Do-plane run, held in memory only (R-0b-86).
//
// WHY. The robot (a GitHub App) is the only account that merges, so its key is the thing worth stealing. Each run
// mints a short-lived installation token from the key in the orchestrate key folder and keeps it in memory: nothing
// here writes a file. Only the scripts' own Mac user may mint one, so a session running as the owner's user can't
// act as the robot even if it reads this code. The key file must belong to that user and be readable by it alone,
// and must not be a link (a link could point the check at one file and the read at another). The real App install
// is a later human step; tests use a locally made key pair and a fake GitHub.
//
//   makeAppJwt({ appId, privateKeyPem, now }) → string   (RS256; iat = now − 60 s, exp = now + 9 min; now in ms)
//   await mintInstallationToken({ keyDir, keyFile?, appId, installationId, http, uid?, scriptsUid, now? })
//     → { ok: true, token, expires_at, login, login_reason? } | { ok: false, reason }
// `login` is the robot's own name on GitHub, "<slug>[bot]", read with the same signed request (GET /app) because an
// installation token can't ask who it is, and the alert channel needs it to tell the robot's issues from another app's
// (L399). A login that can't be read doesn't stop the mint: login is null and login_reason says why.
// `http` is a GitHub client ({ post(path, body, headers), get(path, headers) } → { status, json }). Any error → no token (fail closed),
// and a reason never carries the token, the signed request or key text. makeAppJwt throws on bad input (a string
// builder: a throw can't be read as a pass); mintInstallationToken never throws.

import { sign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerSecret } from '../../shared/secret-guard.mjs';

const APP_ID = /^[A-Za-z0-9.]{1,64}$/;           // a numeric App id or an App's client id
const INSTALL_ID = /^[1-9][0-9]{0,19}$/;
const KEY_FILE = /^[A-Za-z0-9._-]{1,128}$/;       // a bare name inside the key folder, never a path
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,99})$/i;     // an App's name in its URL
const b64url = (x) => Buffer.from(x).toString('base64url');

export function makeAppJwt({ appId, privateKeyPem, now }) {
  if (!APP_ID.test(String(appId ?? ''))) throw new Error('an app JWT needs an app id');
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY')) throw new Error('an app JWT needs a private key');
  if (!Number.isFinite(now)) throw new Error('an app JWT needs the time');
  const t = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // GitHub allows exp at most 10 minutes after iat; iat is backdated 60 s for clock drift, so 9 minutes stays inside.
  const body = b64url(JSON.stringify({ iat: t - 60, exp: t + 9 * 60, iss: typeof appId === 'number' ? appId : String(appId) }));
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKeyPem).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** The robot's key file's default name in the key folder (L734): tests name it from here, and token.test pins its value. */
export const ROBOT_KEY_FILE = 'robot-app.pem';

export async function mintInstallationToken({ keyDir, keyFile = ROBOT_KEY_FILE, appId, installationId, http, uid = process.getuid?.(), scriptsUid, now = Date.now } = {}) {
  const secrets = [];   // every secret text seen, scrubbed from any reason
  const no = (reason) => ({ ok: false, reason: scrub(reason, secrets) });
  try {
    if (!Number.isInteger(scriptsUid) || scriptsUid < 0) return no('no scripts\' Mac user configured');
    if (uid === 0 || scriptsUid === 0) return no('refusing to mint the robot\'s token as root');
    if (uid !== scriptsUid) return no('only the scripts\' Mac user may mint the robot\'s token');
    if (typeof keyDir !== 'string' || !keyDir) return no('no key folder');
    if (typeof keyFile !== 'string' || !KEY_FILE.test(keyFile) || keyFile === '.' || keyFile === '..') return no('the key file must be a plain name in the key folder');
    if (!APP_ID.test(String(appId ?? ''))) return no('no app id');
    if (!INSTALL_ID.test(String(installationId ?? ''))) return no('no installation id');
    if (!http || typeof http.post !== 'function') return no('no GitHub client');
    if (typeof now !== 'function') return no('no clock');

    const file = join(keyDir, keyFile);
    let st;
    try { st = lstatSync(file); } catch { return no('the robot\'s key file is missing'); }
    if (st.isSymbolicLink()) return no('the robot\'s key file is a link');
    if (!st.isFile()) return no('the robot\'s key file is not a plain file');
    if (st.uid !== scriptsUid) return no('the robot\'s key file is not owned by the scripts\' Mac user');
    if ((st.mode & 0o077) !== 0) return no('the robot\'s key file is readable by others (group or other permission set)');
    const pem = readFileSync(file, 'utf8');
    secrets.push(registerSecret(pem));

    const jwt = makeAppJwt({ appId, privateKeyPem: pem, now: now() });
    secrets.push(registerSecret(jwt));
    const signed = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const r = await http.post(`/app/installations/${installationId}/access_tokens`, {}, signed);
    const token = r?.json?.token;
    if (typeof token === 'string') secrets.push(registerSecret(token));
    if (r?.status !== 201) return no(`GitHub refused the token request (${r?.status})`);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{20,512}$/.test(token)) return no('GitHub gave no usable token');
    const expires_at = typeof r.json.expires_at === 'string' ? r.json.expires_at : null;
    const who = await robotLogin(http, signed);
    return { ok: true, token, expires_at, login: who.login, ...(who.login ? {} : { login_reason: scrub(who.reason, secrets) }) };
  } catch (e) {
    let why = 'unknown error';
    try { const m = e?.message; if (typeof m === 'string') why = m.slice(0, 200); } catch { /* keep the fixed text */ }
    return no(`token mint failed: ${why}`);
  }
}

// The App's own login. Never throws: a mint with no login is still a mint.
async function robotLogin(http, signed) {
  try {
    if (typeof http.get !== 'function') return { login: null, reason: 'this GitHub client cannot read the App' };
    const r = await http.get('/app', signed);
    if (r?.status !== 200) return { login: null, reason: `GitHub answered ${r?.status} to GET /app` };
    const slug = r.json?.slug;
    return SLUG.test(String(slug ?? '')) ? { login: `${slug}[bot]`, reason: null } : { login: null, reason: 'GitHub gave no App name' };
  } catch (e) {
    return { login: null, reason: `GET /app failed: ${String(e?.message ?? 'unknown error').slice(0, 200)}` };
  }
}

// A reason goes to logs; it never carries a secret seen here, nor anything shaped like a key, a token or a signed request.
function scrub(text, secrets) {
  let s = String(text);
  for (const x of secrets) if (x) s = s.split(x).join('[hidden]');
  return s.replace(/-----BEGIN[\s\S]*?(-----END[^-]*-----|$)/g, '[hidden]')
    .replace(/\bgh[a-z]_[A-Za-z0-9_]+/g, '[hidden]')
    .replace(/\beyJ[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]*)*/g, '[hidden]');
}
