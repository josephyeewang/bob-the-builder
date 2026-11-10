// push-reason.mjs — words from outside (a push script's reason, a store's error) as they may be told and stored (L720 n2,
// L729): local paths cut, then a cut for length. Fence it afterwards (cleanOutside), never before: a cut after the fence
// would break its closing tag. One definition; the proposal route and M13's store-stopped both use it.
//
// Only a path that starts a word is cut (/Users/..., ~/...), so a name in the repo such as docs/SYSTEM.md still says
// which file to fix; a cut for length says so.

const LOCAL_PATH = /(?<![\w.~-])~?\/[^\s'"`:,;()[\]]+/g;
export const REASON_CAP = 200;

export function pushReason(why) {
  const s = String(why).replace(LOCAL_PATH, '<path>');
  return s.length > REASON_CAP ? `${s.slice(0, REASON_CAP)}…[cut ${s.length - REASON_CAP} characters]` : s;
}
