import { registerHooks } from "node:module";
import { transformLambda } from "../benchmark/lib/regex-transform.js";

let patched = false;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!patched && url.endsWith("/handler.mjs")) {
      patched = true;
      return {
        format: "module",
        shortCircuit: true,
        source: transformLambda(result.source.toString(), "handler", "WrapAwsLambda")
      };
    }
    return result;
  },
});
