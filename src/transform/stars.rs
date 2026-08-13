//! Resolve names forwarded through `export *` inside the native engine.
//!
//! Keeping the graph walk here turns a potentially large JS↔napi call train
//! into one native operation. The Acorn engine owns the equivalent JS walk.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use oxc_resolver::{ResolveOptions, Resolver};

use super::{ReexportInfo, esm_module_exports_for_file};

static RESOLVER: OnceLock<Resolver> = OnceLock::new();

pub(crate) fn resolve_module(specifier: &str, from_dir: &Path) -> Option<PathBuf> {
  RESOLVER
    .get_or_init(|| {
      Resolver::new(ResolveOptions {
        condition_names: vec!["node".into(), "import".into()],
        main_fields: vec!["module".into(), "main".into()],
        ..ResolveOptions::default()
      })
    })
    .resolve(from_dir, specifier)
    .ok()
    .map(|resolution| resolution.full_path())
}

fn resolve_star_source(specifier: &str, from_dir: &Path) -> Option<PathBuf> {
  if specifier.starts_with("./") || specifier.starts_with("../") {
    let joined = from_dir.join(specifier);
    Some(fs::canonicalize(&joined).unwrap_or(joined))
  } else {
    resolve_module(specifier, from_dir)
  }
}

#[derive(Default)]
struct ModuleInfo {
  names: HashSet<String>,
  stars: Vec<String>,
  reexports: Vec<ReexportInfo>,
}

fn module_info<'a>(path: &Path, cache: &'a mut HashMap<PathBuf, ModuleInfo>) -> &'a ModuleInfo {
  cache.entry(path.to_path_buf()).or_insert_with(|| {
    let Ok(source) = fs::read_to_string(path) else {
      return ModuleInfo::default();
    };
    let (names, stars, reexports) = esm_module_exports_for_file(&source, path);
    ModuleInfo {
      names: names.into_iter().collect(),
      stars,
      reexports,
    }
  })
}

fn provided_names(
  path: &Path,
  cache: &mut HashMap<PathBuf, ModuleInfo>,
  memo: &mut HashMap<PathBuf, HashSet<String>>,
  visiting: &mut HashSet<PathBuf>,
) -> (HashSet<String>, bool) {
  if let Some(names) = memo.get(path) {
    return (names.clone(), true);
  }
  if !visiting.insert(path.to_path_buf()) {
    return (HashSet::new(), false);
  }
  let (mut names, stars) = {
    let info = module_info(path, cache);
    (info.names.clone(), info.stars.clone())
  };
  let mut complete = true;
  let dir = path.parent().unwrap_or(Path::new("."));
  for specifier in stars {
    if let Some(source) = resolve_star_source(&specifier, dir) {
      let (sub, sub_complete) = provided_names(&source, cache, memo, visiting);
      names.extend(sub);
      complete &= sub_complete;
    }
  }
  visiting.remove(path);
  if complete {
    memo.insert(path.to_path_buf(), names.clone());
  }
  (names, complete)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Origin {
  file: PathBuf,
  binding: String,
}

enum OriginResult {
  One(Origin),
  Missing,
  Ambiguous,
}

fn resolve_origin(
  path: &Path,
  name: &str,
  cache: &mut HashMap<PathBuf, ModuleInfo>,
  visiting: &mut HashSet<(PathBuf, String)>,
) -> OriginResult {
  let key = (path.to_path_buf(), name.to_string());
  if !visiting.insert(key) {
    return OriginResult::Missing;
  }
  let (declared, reexport, stars) = {
    let info = module_info(path, cache);
    (
      info.names.contains(name),
      info
        .reexports
        .iter()
        .find(|item| item.exported == name)
        .map(|item| (item.imported.clone(), item.source.clone())),
      info.stars.clone(),
    )
  };
  let dir = path.parent().unwrap_or(Path::new("."));
  if let Some((imported, specifier)) = reexport {
    let Some(source) = resolve_star_source(&specifier, dir) else {
      return OriginResult::Missing;
    };
    if imported == "*" {
      return OriginResult::One(Origin {
        file: source,
        binding: imported,
      });
    }
    return resolve_origin(&source, &imported, cache, visiting);
  }
  if declared {
    return OriginResult::One(Origin {
      file: path.to_path_buf(),
      binding: name.to_string(),
    });
  }

  let mut found: Option<Origin> = None;
  for specifier in stars {
    let Some(source) = resolve_star_source(&specifier, dir) else {
      continue;
    };
    let mut branch = visiting.clone();
    match resolve_origin(&source, name, cache, &mut branch) {
      OriginResult::Ambiguous => return OriginResult::Ambiguous,
      OriginResult::Missing => {}
      OriginResult::One(origin) => match &found {
        Some(previous) if previous != &origin => return OriginResult::Ambiguous,
        None => found = Some(origin),
        _ => {}
      },
    }
  }
  found.map_or(OriginResult::Missing, OriginResult::One)
}

pub(crate) fn resolve_star_bindings(
  missing: &[String],
  star_sources: &[String],
  module_path: &Path,
) -> Result<Vec<(String, String)>, String> {
  let mut cache = HashMap::new();
  let mut memo = HashMap::new();
  let dir = module_path.parent().unwrap_or(Path::new("."));
  let providers: Vec<_> = star_sources
    .iter()
    .map(|specifier| {
      let path = resolve_star_source(specifier, dir);
      let names = path
        .as_deref()
        .map(|path| provided_names(path, &mut cache, &mut memo, &mut HashSet::new()).0)
        .unwrap_or_default();
      (specifier, path, names)
    })
    .collect();

  let mut resolutions = Vec::new();
  for name in missing {
    let matches: Vec<_> = providers
      .iter()
      .filter(|(_, _, names)| names.contains(name))
      .collect();
    if matches.len() > 1 {
      let mut origin: Option<Origin> = None;
      let mut details = Vec::new();
      let mut same = true;
      for (specifier, path, _) in &matches {
        let next = path.as_deref().and_then(|path| {
          match resolve_origin(path, name, &mut cache, &mut HashSet::new()) {
            OriginResult::One(origin) => Some(origin),
            OriginResult::Missing | OriginResult::Ambiguous => None,
          }
        });
        details.push(match &next {
          Some(next) => format!("{specifier} -> {}:{}", next.file.display(), next.binding),
          None => format!("{specifier} -> ?"),
        });
        if next.is_none()
          || origin
            .as_ref()
            .is_some_and(|current| Some(current) != next.as_ref())
        {
          same = false;
        }
        if origin.is_none() {
          origin = next;
        }
      }
      if !same {
        return Err(format!(
          "export '{name}' is ambiguous: provided by multiple 'export *' sources with different origins ({}) — importers cannot resolve it either; patch the defining module instead",
          details.join(", ")
        ));
      }
    }
    if let Some((specifier, _, _)) = matches.first() {
      resolutions.push((name.clone(), (*specifier).clone()));
    }
  }
  Ok(resolutions)
}
