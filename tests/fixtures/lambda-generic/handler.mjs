// The original problem statement of this repo, written the way a Lambda
// author writes it — an exported const arrow. Nothing here knows about
// instrumentation; the config discovers this file from _HANDLER, and the
// generic tap's rewrite path demotes the const so the patch can rebind it.
export const handler = async (event) => `hi:${event?.who ?? 'lambda'}`
