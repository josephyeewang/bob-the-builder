// A port with no real wiring yet: it throws when called, and is never a stand-in answer (R-0b-162).

export const notWiredText = (port) => `not wired yet: ${port} (R-0b-162)`;
export const refusing = (port) => () => { throw new Error(notWiredText(port)); };
