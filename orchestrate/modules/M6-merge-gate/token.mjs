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
//     → { ok: true, token, expires_at } | { ok: false, reason }
// `http` is a GitHub client ({ post(path, body, headers) } → { status, json }). Any error → no token (fail closed),
// and a reason never carries the token, the signed request or key text. makeAppJwt throws on bad input (a string
// builder: a throw can't be read as a pass); mintInstallationToken never throws.

import { sign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_ID = /^[A-Za-z0-9.]{1,64}$/;           // a numeric App id or an App's client id
const INSTALL_ID = /^[1-9][0-9]{0,19}$/;
const KEY_FILE = /^[A-Za-z0-9._-]{1,128}$/;       // a bare name inside the key folder, never a path
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

export async function mintInstallationToken({ keyDir, keyFile = 'robot-app.pem', appId, installationId, http, uid = process.getuid?.(), scriptsUid, now = Date.now } = {}) {
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
    secrets.push(pem);

    const jwt = makeAppJwt({ appId, privateKeyPem: pem, now: now() });
    secrets.push(jwt);
    const r = await http.post(`/app/installations/${installationId}/access_tokens`, {}, {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    const token = r?.json?.token;
    if (typeof token === 'string') secrets.push(token);
    if (r?.status !== 201) return no(`GitHub refused the token request (${r?.status})`);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{20,512}$/.test(token)) return no('GitHub gave no usable token');
    const expires_at = typeof r.json.expires_at === 'string' ? r.json.expires_at : null;
    return { ok: true, token, expires_at };
  } catch (e) {
    let why = 'unknown error';
    try { const m = e?.message; if (typeof m === 'string') why = m.slice(0, 200); } catch { /* keep the fixed text */ }
    return no(`token mint failed: ${why}`);
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
