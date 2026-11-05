// The ports for the Lead sessions and the phone link (group B of the wiring split). Any that starts a session goes
// through the worker runner and the account ports, so it can't be wired before worker-ports.mjs has them.
//
// `wire()` calls `phonePorts(ctx)` and adds what it returns. To wire a port: answer it here and take its name off
// NOT_WIRED_PHONE, in the same change. dispatcher-wiring.mjs stays as it is.

export const NOT_WIRED_PHONE = Object.freeze(['startReadonly', 'replyToLead', 'leads', 'sendFrontDoor', 'restartFrontDoor',
  'startMinibase', 'frontDoorAlive', 'strayFrontDoor', 'frontDoorHandoff']);

/** @param {object} ctx see `wire()` in dispatcher-wiring.mjs */
export function phonePorts(ctx) {
  void ctx;
  return {};
}
