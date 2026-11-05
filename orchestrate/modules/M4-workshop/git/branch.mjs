// A card's branch: the one rule for its name (L204-a). The Dispatcher writes it into the session record, the worker's
// copy is made on it, save-work and cleanup bundle it, the review copy checks it out, and the push script pushes only
// it. Each used to spell the rule out itself.

export const BRANCH = /^card\/[a-z0-9][a-z0-9-]{0,63}$/;

/** The branch card `card` is built on: `card/` and the card id in lower case. */
export const cardBranch = (card) => `card/${String(card).toLowerCase()}`;
