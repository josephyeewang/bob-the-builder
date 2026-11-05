// A port with no real wiring yet: it throws when called, and is never a stand-in answer (R-0b-162).

export const notWiredText = (port) => `not wired yet: ${port} (R-0b-162)`;
const REFUSALS = new WeakSet();
export const refusing = (port) => { const f = () => { throw new Error(notWiredText(port)); }; REFUSALS.add(f); return f; };
/** True for a function `refusing` made: how the wiring tells a port still refusing from one answered. */
export const isRefusing = (f) => typeof f === 'function' && REFUSALS.has(f);
