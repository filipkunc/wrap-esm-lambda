const swc = require("@swc/core");

exports.transformLambda = function (sourceCode, handler, wrapper) {
  const output = swc.transformSync(sourceCode, {
    // Some options cannot be specified in .swcrc
    filename: "handler.mjs",
    sourceMaps: false,
    // Input files are treated as module by default.
    isModule: true,

    // All options below can be configured via .swcrc
    jsc: {
      target: "esnext",
      experimental: {
        cacheRoot: undefined, //< TODO: set `cacheRoot` to set .swc/ folder location
        plugins: [
          [require.resolve("../swc-plugin-esm-lambda/target/wasm32-wasip1/release/swc_plugin_esm_lambda.wasm"),
          { handler, wrapper }]
        ]
      }
    },
  });
  return output.code;
};
