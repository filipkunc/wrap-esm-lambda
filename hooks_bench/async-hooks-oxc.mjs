import { transformLambda } from "../index.js";

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
