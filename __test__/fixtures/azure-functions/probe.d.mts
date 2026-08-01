// Declaration for probe.mjs, which stays a plain .mjs on purpose: the spec
// imports it to produce a real module load event, and the lint lane
// typechecks the specs with tsc, which refuses an undeclared .mjs import.
declare const probe: string
export default probe
