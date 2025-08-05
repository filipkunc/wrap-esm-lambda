import { register } from "node:module";
register("./async-hooks-babel-one-file.mjs", import.meta.url);

import { transformLambda } from "../benchmark/lib/babel-transform.js";

let patched = false;
export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (!patched && url.endsWith("/handler.mjs")) {
        patched = true;
        return {
            format: "module", shortCircuit: true,
            source: transformLambda(result.source.toString(), "handler", "WrapAwsLambda")
        };
    }
    return result;
}
