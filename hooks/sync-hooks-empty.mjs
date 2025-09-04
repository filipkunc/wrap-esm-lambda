import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    console.log("syncLoad: ", url);
    const result = nextLoad(url, context);
    if (result.source) {
      result.source =
      `var origRequire = require;
      require = function (...args) {
        console.log("require: ", args[0]);
        const res = origRequire.apply(this, args);
        console.log("require exports: ", res);
        const origCreateServer = res.createServer;
        res.createServer = (...args) => { console.log("before createServer"); return origCreateServer.apply(this, args); };
        return res;
      }\n` + result.source.toString();
    }
    console.log("syncLoad result: ", { ...result});
    return result;
  },
});
