import { registerHooks } from "node:module";
import { transformLambda } from "../index.js";

let patched = false;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!patched && url.endsWith("/handler.mjs")) {
      patched = true;
      const transformed = transformLambda(result.source.toString(), "handler", "WrapAwsLambda");
      // console.log("Transformed source:\n", transformed);
      return {
        format: "module",
        shortCircuit: true,
        source: transformed
      };
    }
    return result;
  },
});
