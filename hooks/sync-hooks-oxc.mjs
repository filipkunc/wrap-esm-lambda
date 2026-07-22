import { registerHooks } from "node:module";
import { transformLambdaFromBuffer } from "../index.js";

let patched = false;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!patched && url.endsWith("/handler.mjs")) {
      patched = true;
      // nextLoad gives the source as a UTF-8 Buffer: handing it over as-is
      // crosses napi zero-copy, skipping the toString() decode and the
      // UTF-16 -> UTF-8 conversion a string argument would pay.
      const transformed = transformLambdaFromBuffer(result.source, "handler", "WrapAwsLambda");
      return {
        format: "module",
        shortCircuit: true,
        source: transformed
      };
    }
    return result;
  },
});
