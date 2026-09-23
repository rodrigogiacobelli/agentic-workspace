//! Imported colour themes: VS Code theme files, read as data out of a `.json`
//! or from inside a `.vsix`, mapped onto this application's surfaces and
//! saved beside the settings. Nothing in a theme package executes.

use crate::state::AppState;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const MAX_FILE: u64 = 8 * 1024 * 1024;
const MAX_INCLUDE_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub dark: bool,
    pub ui: BTreeMap<String, String>,
    pub terminal: BTreeMap<String, String>,
    pub syntax: BTreeMap<String, String>,
    /// What could not be translated, and what it fell back to.
    #[serde(default)]
    pub report: Vec<String>,
}

// --- Reading -------------------------------------------------------------------

/// Where theme files come from: a directory on disk, or a zip archive.
trait Source {
    fn read(&mut self, path: &str) -> Result<String>;
}

struct DirSource(PathBuf);

impl Source for DirSource {
    fn read(&mut self, path: &str) -> Result<String> {
        let full = self.0.join(path);
        let meta = std::fs::metadata(&full).with_context(|| format!("reading {}", full.display()))?;
        if meta.len() > MAX_FILE {
            anyhow::bail!("{} is larger than {} MB", full.display(), MAX_FILE / 1024 / 1024);
        }
        std::fs::read_to_string(&full).with_context(|| format!("reading {}", full.display()))
    }
}

struct ZipSource(zip::ZipArchive<std::fs::File>);

impl Source for ZipSource {
    fn read(&mut self, path: &str) -> Result<String> {
        let name = normalize(path);
        let entry = self.0.by_name(&name).with_context(|| format!("no {name} in the archive"))?;
        if entry.size() > MAX_FILE {
            anyhow::bail!("{name} is larger than {} MB", MAX_FILE / 1024 / 1024);
        }
        let mut text = String::new();
        entry.take(MAX_FILE).read_to_string(&mut text).with_context(|| format!("reading {name}"))?;
        Ok(text)
    }
}

/// Resolves `.` and `..` in an archive path without touching the filesystem.
fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => { out.pop(); }
            p => out.push(p),
        }
    }
    out.join("/")
}

fn join(base_dir: &str, rel: &str) -> String {
    if base_dir.is_empty() { normalize(rel) } else { normalize(&format!("{base_dir}/{rel}")) }
}

fn dir_of(path: &str) -> String {
    path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()
}

/// Strips `//` and `/* */` comments and trailing commas, which VS Code's
/// theme files carry and JSON does not allow.
pub fn strip_jsonc(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1] as char);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match c {
            '"' => { in_string = true; out.push(c); i += 1; }
            '/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' { i += 1; }
            }
            '/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') { i += 1; }
                i += 2;
            }
            ',' => {
                // A comma followed only by whitespace and a closing bracket is dropped.
                let mut j = i + 1;
                while j < bytes.len() && (bytes[j] as char).is_whitespace() { j += 1; }
                if j < bytes.len() && (bytes[j] == b'}' || bytes[j] == b']') {
                    i += 1;
                    continue;
                }
                out.push(c);
                i += 1;
            }
            _ => { out.push(c); i += 1; }
        }
    }
    // Multi-byte characters were pushed byte by byte above; rebuild losslessly.
    String::from_utf8(out.into_bytes()).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Parses a theme file and folds in its `include` chain, the child winning.
fn load_theme(source: &mut dyn Source, path: &str, depth: usize) -> Result<Value> {
    if depth > MAX_INCLUDE_DEPTH {
        anyhow::bail!("include chain deeper than {MAX_INCLUDE_DEPTH} at {path}");
    }
    let text = source.read(path)?;
    let value: Value = serde_json::from_str(&strip_jsonc(&text)).with_context(|| format!("parsing {path}"))?;
    if !value.is_object() {
        anyhow::bail!("{path} is not a JSON object");
    }
    if let Some(include) = value.get("include").and_then(Value::as_str).map(str::to_string) {
        let parent = load_theme(source, &join(&dir_of(path), &include), depth + 1)?;
        let mut merged = parent;
        if let (Some(pc), Some(cc)) = (merged.get_mut("colors").and_then(Value::as_object_mut), value.get("colors").and_then(Value::as_object)) {
            for (k, v) in cc { pc.insert(k.clone(), v.clone()); }
        } else if let Some(cc) = value.get("colors") {
            merged["colors"] = cc.clone();
        }
        let mut tokens = merged.get("tokenColors").and_then(Value::as_array).cloned().unwrap_or_default();
        tokens.extend(value.get("tokenColors").and_then(Value::as_array).cloned().unwrap_or_default());
        merged["tokenColors"] = Value::Array(tokens);
        for key in ["name", "type", "semanticTokenColors", "semanticHighlighting"] {
            if let Some(v) = value.get(key) { merged[key] = v.clone(); }
        }
        return Ok(merged);
    }
    Ok(value)
}

// --- Mapping -------------------------------------------------------------------

const UI_KEYS: &[(&str, &[&str])] = &[
    ("bg", &["editor.background"]),
    ("bgRaised", &["sideBar.background", "activityBar.background", "editorGroupHeader.tabsBackground", "panel.background"]),
    ("bgHover", &["list.hoverBackground", "editor.lineHighlightBackground", "tab.hoverBackground"]),
    ("fg", &["editor.foreground", "foreground"]),
    ("fgDim", &["descriptionForeground", "sideBar.foreground", "tab.inactiveForeground", "editorLineNumber.activeForeground"]),
    ("fgFaint", &["editorLineNumber.foreground", "disabledForeground", "editorWhitespace.foreground"]),
    ("border", &["panel.border", "editorGroup.border", "sideBar.border", "editorGroupHeader.tabsBorder", "contrastBorder"]),
    ("accent", &["textLink.foreground", "button.background", "editorCursor.foreground", "focusBorder"]),
    ("selection", &["editor.selectionBackground"]),
    ("danger", &["errorForeground", "editorError.foreground", "gitDecoration.deletedResourceForeground"]),
    ("codeBg", &["textCodeBlock.background", "editorWidget.background", "input.background"]),
];

const TERMINAL_KEYS: &[(&str, &str)] = &[
    ("background", "terminal.background"),
    ("foreground", "terminal.foreground"),
    ("cursor", "terminalCursor.foreground"),
    ("selectionBackground", "terminal.selectionBackground"),
    ("black", "terminal.ansiBlack"), ("red", "terminal.ansiRed"), ("green", "terminal.ansiGreen"), ("yellow", "terminal.ansiYellow"),
    ("blue", "terminal.ansiBlue"), ("magenta", "terminal.ansiMagenta"), ("cyan", "terminal.ansiCyan"), ("white", "terminal.ansiWhite"),
    ("brightBlack", "terminal.ansiBrightBlack"), ("brightRed", "terminal.ansiBrightRed"), ("brightGreen", "terminal.ansiBrightGreen"), ("brightYellow", "terminal.ansiBrightYellow"),
    ("brightBlue", "terminal.ansiBrightBlue"), ("brightMagenta", "terminal.ansiBrightMagenta"), ("brightCyan", "terminal.ansiBrightCyan"), ("brightWhite", "terminal.ansiBrightWhite"),
];

/// Highlight tag → TextMate scopes that stand for it, most preferred first.
pub const SYNTAX_SCOPES: &[(&str, &[&str])] = &[
    ("keyword", &["keyword", "storage.type", "storage.modifier", "keyword.control"]),
    ("string", &["string"]),
    ("number", &["constant.numeric", "constant.language", "constant"]),
    ("comment", &["comment"]),
    ("property", &["variable.other.property", "support.type.property-name", "entity.name.function", "support.function", "entity.name.type"]),
    ("tag", &["entity.name.tag"]),
    ("attribute", &["entity.other.attribute-name"]),
    ("heading", &["markup.heading", "entity.name.section", "keyword"]),
    ("link", &["markup.underline.link", "string.other.link", "constant.other.reference.link"]),
    ("emphasis", &["markup.italic", "markup.bold", "markup"]),
    ("punctuation", &["punctuation", "meta.brace"]),
    ("meta", &["meta.preprocessor", "punctuation.definition", "comment"]),
];

fn dark_ansi() -> [(&'static str, &'static str); 16] {
    [("black", "#1c2027"), ("red", "#f87171"), ("green", "#86efac"), ("yellow", "#fcd34d"), ("blue", "#7aa2f7"), ("magenta", "#c4a7e7"), ("cyan", "#7dd3fc"), ("white", "#d6dbe3"),
     ("brightBlack", "#5b6270"), ("brightRed", "#fca5a5"), ("brightGreen", "#bbf7d0"), ("brightYellow", "#fde68a"), ("brightBlue", "#a5c0ff"), ("brightMagenta", "#e0cffc"), ("brightCyan", "#bae6fd"), ("brightWhite", "#f3f4f6")]
}

fn light_ansi() -> [(&'static str, &'static str); 16] {
    [("black", "#24292f"), ("red", "#cf222e"), ("green", "#116329"), ("yellow", "#9a6700"), ("blue", "#0969da"), ("magenta", "#8250df"), ("cyan", "#1b7c83"), ("white", "#6e7781"),
     ("brightBlack", "#57606a"), ("brightRed", "#a40e26"), ("brightGreen", "#1a7f37"), ("brightYellow", "#bf8700"), ("brightBlue", "#218bff"), ("brightMagenta", "#a475f9"), ("brightCyan", "#3192aa"), ("brightWhite", "#8c959f")]
}

struct Rule {
    scopes: Vec<String>,
    foreground: String,
}

fn rules_of(value: &Value) -> Vec<Rule> {
    value
        .get("tokenColors")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let fg = r.get("settings")?.get("foreground")?.as_str()?.to_string();
                    let scopes: Vec<String> = match r.get("scope") {
                        Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_string()).collect(),
                        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                        _ => Vec::new(),
                    };
                    let scopes: Vec<String> = scopes
                        .into_iter()
                        .filter(|s| !s.is_empty() && !s.contains(" -"))
                        // A descendant selector such as `source.js keyword` is judged by its last segment.
                        .map(|s| s.split_whitespace().last().unwrap_or("").to_string())
                        .collect();
                    if scopes.is_empty() { return None; }
                    Some(Rule { scopes, foreground: fg })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The colour for a highlight tag: the most specific rule matching the most
/// preferred candidate scope.
fn syntax_colour(rules: &[Rule], candidates: &[&str], used: &mut HashSet<String>) -> Option<String> {
    for cand in candidates {
        let mut best: Option<(usize, &Rule, &str)> = None;
        for rule in rules {
            for scope in &rule.scopes {
                let matches = cand == scope || cand.starts_with(&format!("{scope}.")) || scope.starts_with(&format!("{cand}."));
                if matches && best.map(|(len, _, _)| scope.len() > len).unwrap_or(true) {
                    best = Some((scope.len(), rule, scope));
                }
            }
        }
        if let Some((_, rule, scope)) = best {
            used.insert(scope.to_string());
            return Some(rule.foreground.clone());
        }
    }
    None
}

fn slug(name: &str) -> String {
    let s: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}

fn map_theme(value: &Value, fallback_name: &str, ui_hint: Option<&str>) -> Theme {
    let mut report = Vec::new();
    let name = value.get("name").and_then(Value::as_str).unwrap_or(fallback_name).to_string();
    let dark = match value.get("type").and_then(Value::as_str).or(ui_hint) {
        Some("light") | Some("vs") | Some("hc-light") => false,
        Some(_) => true,
        None => true,
    };
    let colors = value.get("colors").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut ui = BTreeMap::new();
    let defaults: BTreeMap<&str, &str> = if dark {
        [("bg", "#14171c"), ("bgRaised", "#1b1f26"), ("bgHover", "#232833"), ("fg", "#d6dbe3"), ("fgDim", "#7b8393"), ("fgFaint", "#4d5462"), ("border", "#2a303b"), ("accent", "#7dd3fc"), ("selection", "#2e4a6b"), ("danger", "#f87171"), ("codeBg", "#1b1f26")].into()
    } else {
        [("bg", "#ffffff"), ("bgRaised", "#f4f5f7"), ("bgHover", "#e9ebef"), ("fg", "#24292f"), ("fgDim", "#6e7781"), ("fgFaint", "#b0b6bd"), ("border", "#d8dde3"), ("accent", "#0969da"), ("selection", "#cfe3ff"), ("danger", "#cf222e"), ("codeBg", "#f4f5f7")].into()
    };
    for (key, sources) in UI_KEYS {
        match sources.iter().find_map(|s| colors.get(*s).and_then(Value::as_str)) {
            Some(c) => { ui.insert(key.to_string(), c.to_string()); }
            None => {
                ui.insert(key.to_string(), defaults[key].to_string());
                report.push(format!("{key}: none of {} set; using the built-in {}", sources.join(", "), if dark { "dark" } else { "light" }));
            }
        }
    }
    let mut terminal = BTreeMap::new();
    let ansi: BTreeMap<&str, &str> = if dark { dark_ansi().into() } else { light_ansi().into() };
    let mut missing_ansi = 0;
    for (key, source) in TERMINAL_KEYS {
        let fallback = match *key {
            "background" => ui["bg"].clone(),
            "foreground" => ui["fg"].clone(),
            "cursor" => ui["accent"].clone(),
            "selectionBackground" => ui["selection"].clone(),
            k => ansi[k].to_string(),
        };
        match colors.get(*source).and_then(Value::as_str) {
            Some(c) => { terminal.insert(key.to_string(), c.to_string()); }
            None => {
                if source.contains("ansi") { missing_ansi += 1; }
                terminal.insert(key.to_string(), fallback);
            }
        }
    }
    if missing_ansi > 0 {
        report.push(format!("{missing_ansi} of 16 terminal colours are not defined; using the built-in palette for them"));
    }
    let rules = rules_of(value);
    let mut used = HashSet::new();
    let mut syntax = BTreeMap::new();
    for (key, candidates) in SYNTAX_SCOPES {
        match syntax_colour(&rules, candidates, &mut used) {
            Some(c) => { syntax.insert(key.to_string(), c); }
            None => {
                let fallback = if matches!(*key, "comment" | "meta" | "punctuation") { ui["fgDim"].clone() } else { ui["fg"].clone() };
                report.push(format!("{key}: no token colour for {}; using the foreground", candidates.join(", ")));
                syntax.insert(key.to_string(), fallback);
            }
        }
    }
    // Scopes with no surface here and semantic token colours are expected in
    // any editor theme; only what fell back to a built-in is worth a line.
    let _ = used;
    Theme { id: format!("import-{}", slug(&name)), name, dark, ui, terminal, syntax, report }
}

// --- Store ---------------------------------------------------------------------

fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("themes")
}

pub fn list(data_dir: &Path) -> Vec<Theme> {
    let Ok(read) = std::fs::read_dir(dir(data_dir)) else { return Vec::new() };
    let mut themes: Vec<Theme> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str(&t).ok())
        .collect();
    themes.sort_by(|a, b| a.name.cmp(&b.name));
    themes
}

fn save(data_dir: &Path, theme: &Theme) -> Result<()> {
    let d = dir(data_dir);
    std::fs::create_dir_all(&d)?;
    crate::store::write_atomic(&d.join(format!("{}.json", theme.id)), &serde_json::to_string_pretty(theme)?)
}

/// Reads every theme a `.json` or `.vsix` holds. A failure leaves the store
/// untouched.
fn import(path: &Path) -> Result<Vec<Theme>> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("theme").to_string();
    match ext.as_str() {
        "json" | "jsonc" => {
            let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
            let file = path.file_name().and_then(|f| f.to_str()).context("bad file name")?.to_string();
            let mut source = DirSource(parent);
            let value = load_theme(&mut source, &file, 0)?;
            if value.get("colors").is_none() && value.get("tokenColors").is_none() {
                anyhow::bail!("{} has neither colors nor tokenColors; is it a theme?", path.display());
            }
            Ok(vec![map_theme(&value, &stem, None)])
        }
        "vsix" | "zip" => {
            let file = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
            let archive = zip::ZipArchive::new(file).context("reading the archive")?;
            let mut source = ZipSource(archive);
            let manifest: Value = serde_json::from_str(&strip_jsonc(&source.read("extension/package.json")?)).context("parsing extension/package.json")?;
            let entries = manifest
                .pointer("/contributes/themes")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| anyhow!("the extension contributes no themes"))?;
            let mut out = Vec::new();
            for entry in entries {
                let rel = entry.get("path").and_then(Value::as_str).context("a theme entry without a path")?;
                let label = entry.get("label").and_then(Value::as_str).unwrap_or(&stem).to_string();
                let ui = entry.get("uiTheme").and_then(Value::as_str);
                let value = load_theme(&mut source, &join("extension", rel), 0)?;
                let mut theme = map_theme(&value, &label, ui);
                if value.get("name").is_none() {
                    theme.name = label.clone();
                    theme.id = format!("import-{}", slug(&label));
                }
                out.push(theme);
            }
            Ok(out)
        }
        _ => anyhow::bail!("{} is neither a .json theme nor a .vsix package", path.display()),
    }
}

#[tauri::command(async)]
pub fn import_themes(state: tauri::State<AppState>, path: String) -> Result<Vec<Theme>, String> {
    let themes = import(Path::new(&path)).map_err(|e| format!("{e:#}"))?;
    for t in &themes {
        save(&state.data_dir, t).map_err(|e| format!("{e:#}"))?;
    }
    Ok(themes)
}

#[tauri::command(async)]
pub fn list_themes(state: tauri::State<AppState>) -> Vec<Theme> {
    list(&state.data_dir)
}

/// Removes an imported theme; the active theme falls back to a built-in.
#[tauri::command]
pub fn delete_theme(app: AppHandle, state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let path = dir(&state.data_dir).join(format!("{}.json", id));
    std::fs::remove_file(&path).map_err(|e| format!("removing {}: {e}", path.display()))?;
    let changed = {
        let mut settings = state.settings.lock();
        let mut changed = false;
        if settings.theme == id {
            settings.theme = "graphite".into();
            changed = true;
        }
        for ws in settings.workspaces.values_mut() {
            if ws.theme.as_deref() == Some(&id) {
                ws.theme = None;
                changed = true;
            }
        }
        changed.then(|| settings.clone())
    };
    if let Some(s) = changed {
        crate::settings::save_and_emit(&app, &state, &s);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonc_comments_and_trailing_commas_are_removed_outside_strings() {
        let text = r#"{
  // a comment
  "a": "http://x/y", /* block */
  "b": "has // slashes and /* stars */",
  "c": [1, 2,],
}"#;
        let v: Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(v["a"], "http://x/y");
        assert_eq!(v["b"], "has // slashes and /* stars */");
        assert_eq!(v["c"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn the_most_specific_scope_wins_and_fallbacks_are_reported() {
        let rules = vec![
            Rule { scopes: vec!["keyword".into()], foreground: "#111111".into() },
            Rule { scopes: vec!["keyword.control".into()], foreground: "#222222".into() },
            Rule { scopes: vec!["source.js string".into()], foreground: "#333333".into() },
        ];
        let mut used = HashSet::new();
        assert_eq!(syntax_colour(&rules, &["keyword.control"], &mut used).as_deref(), Some("#222222"));
        assert_eq!(syntax_colour(&rules, &["keyword"], &mut used).as_deref(), Some("#222222"));
        assert_eq!(syntax_colour(&rules, &["comment"], &mut used), None);
        let theme = map_theme(&serde_json::json!({ "name": "T", "type": "light", "colors": { "editor.background": "#fff" }, "tokenColors": [] }), "x", None);
        assert!(!theme.dark);
        assert_eq!(theme.ui["bg"], "#fff");
        assert!(theme.report.iter().any(|r| r.starts_with("comment:")));
        assert_eq!(theme.id, "import-t");
    }
}

#[cfg(test)]
mod diagnostics {
    use super::*;

    /// Prints what an import of a real theme file maps and reports. Run with:
    ///   THEME_FILE=/path/to/theme.json cargo test --lib -- --ignored --nocapture import_report
    #[test]
    #[ignore]
    fn import_report() {
        let Some(path) = std::env::var_os("THEME_FILE") else {
            println!("THEME_FILE not set");
            return;
        };
        match import(Path::new(&path)) {
            Ok(themes) => {
                for t in themes {
                    println!("theme {} ({}) dark={}", t.name, t.id, t.dark);
                    for (k, v) in &t.ui { println!("  ui.{k} = {v}"); }
                    for (k, v) in &t.syntax { println!("  syntax.{k} = {v}"); }
                    for r in &t.report { println!("  report: {r}"); }
                }
            }
            Err(e) => println!("import failed: {e:#}"),
        }
    }
}
