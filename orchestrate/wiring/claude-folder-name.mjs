// Claude Code's folder name for a working folder's conversations: <config dir>/projects/<this name>/<session id>.jsonl.
// Its own file (L1141 addendum) so the L105 guard's exemption for its NFC step covers this rule alone, never the rest of
// runner-ports.mjs, which re-exports it. The capability note and TRANSCRIPT_PLACE_CHECKED_AGAINST are in runner-ports.mjs.
//
// The rule, as 2.1.316's code has it (read in its bundle; checked: claude-code 2.1.316):
//   1. At start claude takes its working folder as realpathSync(cwd).normalize("NFC"). The NFC step is done below. The
//      real-path step is not: the runner passes a copy under copiesRoot, which runner-main.mjs refuses unless it is its
//      own real path, and every name below it is plain ASCII (layout.mjs, product-paths.mjs), so it is already real.
//   2. EL (lke=200): each UTF-16 code unit but [A-Za-z0-9] becomes "-" (no u flag, so an accented e is one "-" and an
//      emoji two). A name over 200 keeps its first 200 and gets "-" and the base-36 of the absolute 32-bit hash
//      (h = h*31 + code unit; the exported Zhe) of the NFC path itself, not of the name.
//   3. CLAUDE_CODE_PROJECT_DIR_NAME (1 to 64 of [A-Za-z0-9_-]) replaces the whole name when CLAUDE_CONFIG_DIR is set
//      (account b; account a leaves it unset) or claude runs with no disk. Settings' env can't set it, and roleEnv
//      passes only its own list, so a session never carries it (runner-ports.test.mjs).
const PROJECT_NAME_MAX = 200;
const stringHash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; };

/** Step 2 alone, on the text as given (no NFC step): the live proof uses it to say which way claude differs. */
export const folderNameAsGiven = (text) => {
  const name = text.replace(/[^A-Za-z0-9]/g, '-');
  return name.length <= PROJECT_NAME_MAX ? name : `${name.slice(0, PROJECT_NAME_MAX)}-${Math.abs(stringHash(text)).toString(36)}`;
};
/** Claude Code's folder for a working folder's conversations (see the rule above; checked: claude-code 2.1.316). */
export const projectFolderName = (cwd) => folderNameAsGiven(String(cwd).normalize('NFC'));
