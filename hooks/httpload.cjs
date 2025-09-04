
const Module = require("node:module");

var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  console.log("Module._load: ", request);
  return origLoad.apply(this, [request, parent, isMain]);
}

const http = require("http");
const http2 = require("http2");
http.createServer(() => {}).listen(0);
http2.createServer(() => {}).listen(0);
