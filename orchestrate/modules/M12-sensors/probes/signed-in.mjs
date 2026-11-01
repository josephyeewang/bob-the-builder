// probes/signed-in.mjs — "which Claude account is signed in?" for the Sensors loop (R-0b-169). The name, or null.
//
// The account new sessions start on is M4's `accountInUse` (the `a` or `b` named in the account file); it counts as
// signed in only when `claude auth status --json` for THAT folder says it is. Both come from M4's accounts.mjs
// (imported, not copied), which keeps only the named yes/no fields and never an address or a token. Nothing is signed
// in, or the answer can't be read → null (M11 reads that as "nobody", and nothing new starts).

import { accountInUse, accountDir, accountEnv, readAuthStatus, claudeAuthStatus } from '../../M4-workshop/launcher/accounts.mjs';

export function signedInProbe({ home, authStatus = claudeAuthStatus(), inUse = accountInUse } = {}) {
  if (typeof home !== 'string' || !home.startsWith('/')) throw new Error('the signed-in probe needs the Mac user\'s home folder');
  return async () => {
    const use = inUse({ home });
    if (!use?.account) return null;
    const out = await authStatus(use.account, accountEnv(home, use.account));
    if (typeof out !== 'string') return null;
    const s = readAuthStatus(out, accountDir(home, use.account));
    return s.readable && s.signedIn === true && s.folderMatches !== false ? use.account : null;
  };
}
