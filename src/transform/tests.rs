use super::*;

#[test]
fn test_exports_tap_chained_upstream_map() {
  // Simulate the tsc pipeline without tsc: `original` plays handler.ts.
  // Codegen strips its blank lines, producing an intermediate handler.js
  // plus an upstream map (handler.js -> handler.ts), exactly the two
  // inputs the tap's rewrite path sees at load time (a `const` demotion
  // forces the rewrite). The chained map must then reach handler.ts, not
  // stop at handler.js.
  let original =
    "export const handler = async (event) => {\n\n\n  throw new Error(\"boom\");\n};\n";
  let allocator = Allocator::default();
  let parsed = Parser::new(&allocator, original, SourceType::mjs()).parse();
  let ret = Codegen::new()
    .with_options(CodegenOptions {
      source_map_path: Some(std::path::PathBuf::from("handler.ts")),
      ..CodegenOptions::default()
    })
    .build(&parsed.program);
  let upstream_json = ret.map.unwrap().to_json_string();

  let out = exports_tap(
    &ret.code,
    &[TapEntry {
      bindings: vec!["handler".to_string()],
      patch_name: "patchIt".to_string(),
      patch_from: "/abs/patch.ts".to_string(),
      alias_index: 0,
    }],
    false,
    true,
    Some("handler.js"),
    Some(&upstream_json),
    &[],
  )
  .expect("tap should apply");
  let code = out.code.expect("const demotion takes the rewrite path");
  assert!(code.contains("let handler"));
  let map = out.map.expect("the rewrite emits a chained map");
  assert!(map.contains("\"sources\":[\"handler.ts\"]"));
  // The upstream map embeds `original` as sourcesContent; chaining carries it over.
  assert!(map.contains("\"sourcesContent\""));
}

#[test]
fn test_exports_tap_malformed_upstream_map_is_err_not_panic() {
  // A `const` export forces the rewrite path, which is the only consumer of
  // the upstream map. The map is caller input, so garbage must come back as
  // an Err (a catchable JS exception through napi), never a panic.
  let source = "export const handler = async (event) => event;\n";
  let err = exports_tap(
    source,
    &[TapEntry {
      bindings: vec!["handler".to_string()],
      patch_name: "patchIt".to_string(),
      patch_from: "/abs/patch.ts".to_string(),
      alias_index: 0,
    }],
    false,
    true,
    Some("handler.js"),
    Some("this is not a source map"),
    &[],
  )
  .unwrap_err();
  assert!(
    err.contains("invalid upstream source map JSON"),
    "error names the bad input: {err}"
  );
}

fn tap1(source: &str, bindings: &[&str], cjs: bool, registry: bool) -> Result<TapOutput, String> {
  exports_tap(
    source,
    &[TapEntry {
      bindings: bindings.iter().map(|b| b.to_string()).collect(),
      patch_name: "patchIt".to_string(),
      patch_from: "/abs/patch.ts".to_string(),
      alias_index: 0,
    }],
    cjs,
    registry,
    Some("mod.js"),
    None,
    &[],
  )
}

#[test]
fn test_exports_tap_fast_path_mutable_bindings() {
  let source = "export class Client {\n\tsend(command) {\n\t\treturn command;\n\t}\n}\n";
  let out = tap1(source, &["Client"], false, false).unwrap();
  println!("{}", out.snippets);
  assert!(
    out.code.is_none(),
    "mutable bindings must stay on the append-only fast path"
  );
  assert!(out.map.is_none());
  assert!(
    out
      .snippets
      .contains("import { patchIt as __wel_patch_0 } from \"/abs/patch.ts\";")
  );
  assert!(out.snippets.contains("get Client() { return Client; }"));
  assert!(out.snippets.contains("set Client(v) { Client = v; }"));
}

#[test]
fn test_exports_tap_registry_delivery() {
  let source = "export class Client {}\n";
  let out = tap1(source, &["Client"], false, true).unwrap();
  assert!(out.snippets.starts_with("\n"), "snippet is append-ready");
  assert!(
    !out.snippets.contains("import {"),
    "registry delivery injects no import"
  );
  assert!(
    out
      .snippets
      .contains("globalThis[Symbol.for(\"wrap-esm-lambda.patches\")]")
  );
  assert!(out.snippets.contains("[\"/abs/patch.ts#patchIt\"]"));
}

#[test]
fn test_exports_tap_const_demoted_to_let() {
  let source = "export const handler = async (event) => event;\n";
  let out = tap1(source, &["handler"], false, true).unwrap();
  let code = out.code.expect("const export must take the rewrite path");
  println!("{}\n{}", code, out.snippets);
  assert!(
    code.contains("export let handler"),
    "const is demoted to let"
  );
  assert!(out.map.is_some(), "rewrite emits a source map");
  assert!(
    out.snippets.contains("set handler(v) { handler = v; }"),
    "demoted const gets a setter"
  );
}

#[test]
fn test_exports_tap_list_exported_const_demoted() {
  let source = "const y = async (e) => e;\nexport { y as handler };\n";
  let out = tap1(source, &["handler"], false, true).unwrap();
  let code = out
    .code
    .expect("list-exported const must take the rewrite path");
  println!("{}", code);
  assert!(
    code.contains("let y"),
    "the local const behind the list export is demoted"
  );
  assert!(code.contains("export { y as handler }"));
  assert!(out.snippets.contains("set handler(v) { y = v; }"));
}

#[test]
fn test_exports_tap_default_named_class_is_fast_path() {
  let source = "export default class Hono {\n\troute(p) { return p; }\n}\n";
  let out = tap1(source, &["default"], false, true).unwrap();
  assert!(
    out.code.is_none(),
    "named default declarations are live aliases — append suffices"
  );
  assert!(out.snippets.contains("get default() { return Hono; }"));
  assert!(out.snippets.contains("set default(v) { Hono = v; }"));
}

#[test]
fn test_exports_tap_default_anonymous_is_named() {
  let source = "export default async (event) => event;\n";
  let out = tap1(source, &["default"], false, true).unwrap();
  let code = out
    .code
    .expect("anonymous default must take the rewrite path");
  println!("{}\n{}", code, out.snippets);
  assert!(code.contains("let __wel_default = async (event) => event;"));
  assert!(code.contains("export { __wel_default as default }"));
  assert!(
    out
      .snippets
      .contains("set default(v) { __wel_default = v; }")
  );
}

#[test]
fn test_exports_tap_reexport_split() {
  let source = "export { Client, VERSION } from \"./client.js\";\n";
  let out = tap1(source, &["Client"], false, true).unwrap();
  let code = out.code.expect("re-export must take the rewrite path");
  println!("{}", code);
  assert!(
    code.contains("export { VERSION } from \"./client.js\";"),
    "untapped specifiers stay"
  );
  assert!(code.contains("import { Client as __wel_l0_src } from \"./client.js\";"));
  assert!(code.contains("let __wel_l0 = __wel_l0_src;"));
  assert!(code.contains("export { __wel_l0 as Client }"));
  assert!(out.snippets.contains("set Client(v) { __wel_l0 = v; }"));
}

#[test]
fn test_exports_tap_import_backed_local_split() {
  let source = "import { x } from \"./dep.js\";\nexport { x };\n";
  let out = tap1(source, &["x"], false, true).unwrap();
  let code = out
    .code
    .expect("import-backed local must take the rewrite path");
  println!("{}", code);
  assert!(code.contains("let __wel_l0 = x;"));
  assert!(code.contains("export { __wel_l0 as x }"));
}

#[test]
fn test_exports_tap_destructured_const_export() {
  let source = "export const { greet, meta: [info] } = make();\n";
  let out = tap1(source, &["greet", "info"], false, true).unwrap();
  let code = out
    .code
    .expect("destructured const must take the rewrite path");
  println!("{}\n{}", code, out.snippets);
  assert!(
    code.contains("export let {"),
    "the whole pattern declaration is demoted"
  );
  assert!(out.snippets.contains("set greet(v) { greet = v; }"));
  assert!(out.snippets.contains("set info(v) { info = v; }"));
}

#[test]
fn test_exports_tap_destructured_let_export_is_fast_path() {
  let source = "export let { greet } = make();\n";
  let out = tap1(source, &["greet"], false, true).unwrap();
  assert!(
    out.code.is_none(),
    "let destructuring is already reassignable — append only"
  );
  assert!(out.snippets.contains("set greet(v) { greet = v; }"));
}

#[test]
fn test_exports_tap_top_level_const_pattern_behind_list_export() {
  let source = "const { a } = make();\nexport { a as alpha };\n";
  let out = tap1(source, &["alpha"], false, true).unwrap();
  let code = out
    .code
    .expect("the const pattern behind the list export must be demoted");
  println!("{}", code);
  assert!(code.contains("let {"), "top-level const pattern demoted");
  assert!(out.snippets.contains("set alpha(v) { a = v; }"));
}

#[test]
fn test_exports_tap_namespace_reexport() {
  let source = "export * as ns from \"./m.js\";\n";
  let out = tap1(source, &["ns"], false, true).unwrap();
  let code = out.code.expect("export * as ns must take the rewrite path");
  println!("{}\n{}", code, out.snippets);
  assert!(code.contains("import * as __wel_l0_src from \"./m.js\";"));
  assert!(code.contains("let __wel_l0 = __wel_l0_src;"));
  assert!(code.contains("export { __wel_l0 as ns }"));
  assert!(out.snippets.contains("set ns(v) { __wel_l0 = v; }"));
}

#[test]
fn test_exports_tap_bare_export_star_unresolved_is_loud_with_hint() {
  let source = "export * from \"./m.js\";\nexport class Client {}\n";
  let err = tap1(source, &["Hidden"], false, true).unwrap_err();
  assert!(
    err.contains("export 'Hidden' not found"),
    "bare star names are not static: {err}"
  );
  assert!(
    err.contains("unresolved 'export *' sources: ./m.js"),
    "error names the stars: {err}"
  );
}

#[test]
fn test_exports_tap_star_resolution_appends_shadow_export() {
  let source = "export * from \"./m.js\";\n";
  let out = exports_tap(
    source,
    &[TapEntry {
      bindings: vec!["Hidden".to_string()],
      patch_name: "patchIt".to_string(),
      patch_from: "/abs/patch.ts".to_string(),
      alias_index: 0,
    }],
    false,
    true,
    Some("mod.js"),
    None,
    &[StarResolution {
      binding: "Hidden".to_string(),
      source: "./m.js".to_string(),
    }],
  )
  .unwrap();
  println!("{}", out.snippets);
  assert!(
    out.code.is_none(),
    "star shadowing is append-only — no rewrite"
  );
  assert!(
    out
      .snippets
      .contains("import { Hidden as __wel_l0_src } from \"./m.js\";")
  );
  assert!(out.snippets.contains("let __wel_l0 = __wel_l0_src;"));
  assert!(
    out.snippets.contains("export { __wel_l0 as Hidden };"),
    "explicit export shadows the star"
  );
  assert!(out.snippets.contains("set Hidden(v) { __wel_l0 = v; }"));
}

#[test]
fn test_esm_module_exports_surface() {
  let source = "export const a = 1;\nexport * from \"./x.js\";\nexport * as ns from \"./y.js\";\nexport default 2;\n";
  let (names, stars, reexports) = esm_module_exports(source);
  assert!(names.contains(&"a".to_string()));
  assert!(
    names.contains(&"ns".to_string()),
    "export * as ns is a name, not a bare star"
  );
  assert!(names.contains(&"default".to_string()));
  assert_eq!(
    stars,
    vec!["./x.js".to_string()],
    "only the bare star is a walk source"
  );
  assert_eq!(
    reexports.len(),
    1,
    "only the namespace re-export has provenance"
  );
  assert_eq!(reexports[0].exported, "ns");
  assert_eq!(reexports[0].imported, "*");
  assert_eq!(reexports[0].source, "./y.js");
}

#[test]
fn test_esm_module_exports_reexport_provenance() {
  // the three shapes whose binding lives in another module, plus a local
  // list export that must NOT gain provenance
  let source = "import { x } from \"./m.js\";\nimport d from \"./m.js\";\nexport { x as y };\nexport { d };\nexport { a as b } from \"./n.js\";\nconst local = 1;\nexport { local };\n";
  let (names, _, reexports) = esm_module_exports(source);
  assert!(names.contains(&"local".to_string()));
  let find = |exported: &str| {
    reexports
      .iter()
      .find(|r| r.exported == exported)
      .unwrap_or_else(|| panic!("no provenance for {exported}"))
  };
  let y = find("y");
  assert_eq!((y.imported.as_str(), y.source.as_str()), ("x", "./m.js"));
  let d = find("d");
  assert_eq!(
    (d.imported.as_str(), d.source.as_str()),
    ("default", "./m.js"),
    "default-import-backed list export resolves to the default binding"
  );
  let b = find("b");
  assert_eq!((b.imported.as_str(), b.source.as_str()), ("a", "./n.js"));
  assert!(
    !reexports.iter().any(|r| r.exported == "local"),
    "a genuinely local list export has no provenance"
  );
}

#[test]
fn test_exports_tap_default_reexport_split() {
  let source = "export { default as Client } from \"./client.js\";\n";
  let out = tap1(source, &["Client"], false, true).unwrap();
  let code = out
    .code
    .expect("re-exported default must take the rewrite path");
  println!("{}", code);
  assert!(code.contains("import { default as __wel_l0_src } from \"./client.js\";"));
  assert!(code.contains("export { __wel_l0 as Client }"));
}

#[test]
fn test_exports_tap_export_list_of_default_import() {
  let source = "import Client from \"./client.js\";\nexport { Client };\n";
  let out = tap1(source, &["Client"], false, true).unwrap();
  let code = out.code.expect("default-import-backed export must split");
  println!("{}", code);
  assert!(code.contains("let __wel_l0 = Client;"));
  assert!(code.contains("export { __wel_l0 as Client }"));
}

#[test]
fn test_exports_tap_shared_rewrites_across_entries() {
  let source = "export const VERSION = \"1.0.0\";\n";
  let entries = [
    TapEntry {
      bindings: vec!["VERSION".to_string()],
      patch_name: "patchA".to_string(),
      patch_from: "/a.ts".to_string(),
      alias_index: 0,
    },
    TapEntry {
      bindings: vec!["VERSION".to_string()],
      patch_name: "patchB".to_string(),
      patch_from: "/b.ts".to_string(),
      alias_index: 1,
    },
  ];
  let out = exports_tap(source, &entries, false, false, Some("mod.js"), None, &[]).unwrap();
  let code = out.code.unwrap();
  assert_eq!(
    code.matches("let VERSION").count(),
    1,
    "both entries share one demotion"
  );
  assert!(out.snippets.contains("__wel_patch_0"));
  assert!(out.snippets.contains("__wel_patch_1"));
}

#[test]
fn test_exports_tap_missing_export_is_loud() {
  let source = "export class Client {}\nexport default 1;\n";
  let err = tap1(source, &["Klient"], false, false).unwrap_err();
  assert!(err.contains("export 'Klient' not found"));
  assert!(err.contains("Client"), "error lists what is available");
  assert!(err.contains("default"), "default is listed as available");
}

#[test]
fn test_exports_tap_cjs_module_exports_binding() {
  let out = tap1("", &["module.exports"], true, true).unwrap();
  assert!(out.code.is_none(), "CJS never rewrites");
  assert!(
    out
      .snippets
      .contains("get \"module.exports\"() { return module.exports; }")
  );
  assert!(
    out
      .snippets
      .contains("set \"module.exports\"(v) { module.exports = v; }")
  );
}

#[test]
fn test_exports_tap_cjs_registry_delivery() {
  let out = tap1("", &["Client"], true, true).unwrap();
  assert!(out.snippets.starts_with("\n"), "snippet is append-ready");
  assert!(
    !out.snippets.contains("require("),
    "registry delivery injects no require — hook-overridden CJS cannot serve one"
  );
  assert!(
    out
      .snippets
      .contains("get Client() { return module.exports.Client; }")
  );
  assert!(
    out
      .snippets
      .contains("set Client(v) { module.exports.Client = v;")
  );
  assert!(
    out
      .snippets
      .contains("if (module.exports.Client !== v) throw new TypeError"),
    "CJS setter must verify the rebind took — sloppy-mode bundles no-op silently on getter-only exports"
  );
}

#[test]
fn test_exports_tap_cjs_import_delivery_emits_require() {
  // Build-time delivery into a CJS module: a static `import` appended to
  // CJS source would flip its format under bundler syntax detection, so
  // import delivery goes through `require()` there.
  let out = tap1("", &["json"], true, false).unwrap();
  println!("{}", out.snippets);
  assert!(
    !out.snippets.contains("import {"),
    "no ESM import may reach a CJS module"
  );
  assert!(
    out
      .snippets
      .contains("const { patchIt: __wel_patch_0 } = require(\"/abs/patch.ts\");")
  );
  assert!(out.snippets.contains("__wel_patch_0({"));
  assert!(
    out
      .snippets
      .contains("get json() { return module.exports.json; }")
  );
}

#[test]
fn test_has_module_syntax() {
  assert!(has_module_syntax("export const x = 1;\n"));
  assert!(has_module_syntax("import x from \"y\";\n"));
  assert!(has_module_syntax("console.log(import.meta.url);\n"));
  // pure CJS: `module`/`exports`/`require` are just identifiers to ESM
  assert!(!has_module_syntax(
    "const express = require(\"./lib\");\nexports = module.exports = express;\nexports.json = () => {};\n"
  ));
  // dynamic import alone is valid in CJS too — not module syntax
  assert!(!has_module_syntax("import(\"x\").then(() => {});\n"));
  // does not parse as ESM at all -> not ESM
  assert!(!has_module_syntax("with (obj) { x = 1; }\n"));
}
