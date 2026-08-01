// Exists only to produce one module load event: the azure-functions preset's
// armed state activates at the first load after the worker serves the core
// module, and the spec needs a load to trigger.
export default 'probe'
