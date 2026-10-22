#!/usr/bin/env node
/**
 * dict-check — keep flat translation dictionaries in lockstep across locales.
 *
 * Three jobs, one zero-dependency file:
 *
 *   1. check   (default) — parity across locale files: missing keys, extra keys,
 *                duplicates, empty values, and placeholder ({name}) mismatches.
 *                Plus: every static t("key") reference in your sources resolves.
 *   2. add     — insert one key into every locale file at once, each with its
 *                own translation, next to an anchor key of your choosing.
 *
 * Dictionaries are flat TypeScript modules of "key": "value" lines:
 *
 *   export default {
 *     "nav.home": "Home",
 *     "nav.pricing": "Pricing",
 *   };
 *
 * Nested objects and non-string values are reported, not parsed — this tool is
 * deliberately opinionated about the flat shape, because flat dictionaries are
 * what make cross-locale diffing tractable.
 *
 * Config: dict-check.config.json next to your project root (or --config).
 * Everything has a default except `dictDir` and `base`.
 *
 *   {
 *     "dictDir": "src/i18n/messages",
 *     "base": "en",
 *     "root": ".",                        // sources resolve against this (default: cwd)
 *     "locales": ["en", "zh", "ja"],      // default: every file in dictDir
 *     "sources": ["src/**"],              // default: nothing is scanned
 *     "translate": "t",                   // function name to look for
 *     "ignore": ["demo.*"],               // key globs to skip in unused report
 *     "placeholders": true                // check {token} parity
 *   }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// ── argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[a.slice(2)] = args[++i];
    } else {
      flags[a.slice(2)] = true;
    }
  } else {
    positional.push(a);
  }
}
const command = positional[0] || "check";

function fail(msg) {
  console.error(`!! ${msg}`);
  process.exit(1);
}

// ── config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  dictDir: null, // required
  base: null, // required
  root: ".", // sources resolve against this; default: current directory
  locales: null, // default: discover from dictDir
  sources: [],
  translate: "t",
  ignore: [],
  placeholders: true,
};

function loadConfig() {
  const configPath = flags.config
    ? path.resolve(flags.config)
    : path.join(process.cwd(), "dict-check.config.json");
  let file = {};
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      fail(`${configPath} is not valid JSON: ${e.message}`);
    }
  } else if (!flags.config) {
    fail(
      "no dict-check.config.json in the current directory. Create one or pass --config <path>."
    );
  }
  const cfg = { ...DEFAULT_CONFIG, ...file };
  if (flags["dict-dir"]) cfg.dictDir = flags["dict-dir"];
  if (flags.base) cfg.base = flags.base;
  if (flags.sources) cfg.sources = String(flags.sources).split(",");
  if (flags.translate) cfg.translate = flags.translate;
  if (flags.root) cfg.root = flags.root;
  // dictDir and root both resolve against the config file's directory, so a
  // config works from any cwd.
  cfg.root = path.resolve(path.dirname(configPath), cfg.root);
  cfg.dictDir = path.resolve(path.dirname(configPath), cfg.dictDir);
  if (!cfg.dictDir) fail("config needs a dictDir (directory of dictionary files)");
  if (!cfg.base) fail("config needs a base locale (e.g. \"en\")");
  return cfg;
}

// ── dictionary parsing ──────────────────────────────────────────────────────

const KEY_LINE = /^(\s*)"((?:[^"\\]|\\.)*)"\s*:/;

/**
 * Parses one dictionary file into { entries: Map<key, {value, line}>, order,
 * duplicates, nonString }.
 *
 * Handles both single-line entries (`"k": "v",`) and multi-line ones where the
 * value sits on a following line — real dictionaries use both, and a parser
 * that only understands the first kind reports phantom drift.
 */
function parseDict(file) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  const entries = new Map();
  const duplicates = [];
  const nonString = [];
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(KEY_LINE);
    if (!km) continue;
    const key = km[2];
    let value = null;
    const same = lines[i].slice(km[0].length).match(/^\s*"((?:[^"\\]|\\.)*)"/);
    if (same) {
      value = same[1];
    } else {
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const t = lines[j].trim();
        if (!t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
        const next = t.match(/^"((?:[^"\\]|\\.)*)"/);
        if (next) value = next[1];
        break;
      }
    }
    if (value === null) {
      nonString.push(`${key} (line ${i + 1})`);
      continue;
    }
    if (entries.has(key)) duplicates.push(key);
    entries.set(key, { value, line: i });
  }
  return { entries, duplicates, nonString };
}

function placeholderTokens(value) {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

function globToRegExp(glob) {
  // supports * (within a path segment) and ** (across segments)
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\{([^}]+)\}/g, (_, inner) => `(${inner.split(",").join("|")})`);
  return new RegExp(`^${re}$`);
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "node_modules" || name.name.startsWith(".")) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function matchesAny(rel, patterns) {
  return patterns.some((p) => {
    const re = globToRegExp(p);
    return re.test(rel) || re.test(`/${rel}`);
  });
}

function ignored(key, patterns) {
  return patterns.some((p) => globToRegExp(p).test(key));
}

// ── check ───────────────────────────────────────────────────────────────────

function runCheck(cfg) {
  const problems = [];
  const notes = [];

  // locale files: explicit list, or everything in dictDir
  let localeFiles;
  if (cfg.locales) {
    localeFiles = cfg.locales.map((l) => ({ locale: l, file: path.join(cfg.dictDir, `${l}.ts`) }));
  } else {
    localeFiles = fs
      .readdirSync(cfg.dictDir)
      .filter((f) => /\.(ts|js|mjs|json)$/.test(f))
      .map((f) => ({ locale: f.replace(/\.[^.]+$/, ""), file: path.join(cfg.dictDir, f) }));
  }
  const baseEntry = localeFiles.find((l) => l.locale === cfg.base);
  if (!baseEntry) fail(`base locale "${cfg.base}" has no file in ${cfg.dictDir}`);
  if (!fs.existsSync(baseEntry.file)) fail(`base file missing: ${baseEntry.file}`);

  const base = parseDict(baseEntry.file);
  console.log(`base: ${cfg.base} — ${base.entries.size} keys (${baseEntry.file})`);

  for (const { locale, file } of localeFiles) {
    if (!fs.existsSync(file)) {
      problems.push(`${locale}: file missing (${path.relative(process.cwd(), file)})`);
      continue;
    }
    const d = parseDict(file);
    if (d.duplicates.length)
      problems.push(`${locale}: duplicate key(s): ${[...new Set(d.duplicates)].slice(0, 5).join(", ")}`);
    if (d.nonString.length)
      notes.push(`${locale}: non-string value(s) — not parsed: ${d.nonString.slice(0, 3).join(", ")}`);

    const missing = [...base.entries.keys()].filter((k) => !d.entries.has(k));
    const extra = [...d.entries.keys()].filter((k) => !base.entries.has(k));
    if (missing.length)
      problems.push(`${locale}: missing ${missing.length} key(s): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
    if (extra.length)
      problems.push(`${locale}: ${extra.length} key(s) not in base: ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? " …" : ""}`);

    if (cfg.placeholders) {
      for (const [key, entry] of base.entries) {
        const other = d.entries.get(key);
        if (!other) continue;
        const a = placeholderTokens(entry.value).join(",");
        const b = placeholderTokens(other.value).join(",");
        if (a !== b)
          problems.push(`${locale}.${key}: placeholders {${a || "—"}} vs {${b || "—"}}`);
      }
      const empty = [...d.entries].filter(([, v]) => v.value.trim() === "").map(([k]) => k);
      if (empty.length)
        problems.push(`${locale}: empty value(s): ${empty.slice(0, 8).join(", ")}${empty.length > 8 ? " …" : ""}`);
    }
    const status = missing.length || extra.length ? "DRIFT" : "ok";
    console.log(`  ${locale.padEnd(6)} ${d.entries.size} keys  ${status}`);
  }

  // static source references: t("literal.key")
  if (cfg.sources.length) {
    const files = walk(cfg.root).filter((f) => {
      const rel = path.relative(cfg.root, f).replace(/\\/g, "/");
      return matchesAny(rel, cfg.sources);
    });
    if (!files.length) notes.push(`no source files matched: ${cfg.sources.join(", ")}`);
    const fn = cfg.translate;
    const re = new RegExp(`\\b${fn}\\(\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
    const unresolved = [];
    const used = new Set();
    for (const f of files) {
      const body = fs.readFileSync(f, "utf8");
      const rel = path.relative(cfg.root, f).replace(/\\/g, "/");
      for (const m of body.matchAll(re)) {
        const key = m[1];
        if (key.endsWith(".")) continue; // dynamic prefix, not a literal key
        used.add(key);
        if (!base.entries.has(key)) unresolved.push(`${rel}: "${key}"`);
      }
    }
    for (const u of unresolved.slice(0, 10))
      problems.push(`unresolved reference ${u}`);
    if (unresolved.length)
      problems.push(`… ${unresolved.length} unresolved reference(s) total`);

    const unused = [...base.entries.keys()].filter(
      (k) => !used.has(k) && !ignored(k, cfg.ignore)
    );
    console.log(
      `sources: ${files.length} file(s), ${used.size} static reference(s), ` +
        `${unused.length} key(s) never referenced statically` +
        (cfg.ignore.length ? " (ignored globs applied)" : "")
    );
    if (unused.length && flags["show-unused"])
      for (const k of unused.slice(0, 40)) notes.push(`  unused: ${k}`);
    if (unused.length && flags.strict && !cfg.ignore.length)
      problems.push(`${unused.length} unused key(s) (--strict)`);
  }

  for (const n of notes) console.log(`note: ${n}`);
  if (problems.length) {
    for (const p of problems) console.log(`!! ${p}`);
    console.log(`FAILED: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("All locales in lockstep OK");
}

// ── add ─────────────────────────────────────────────────────────────────────

function runAdd(cfg) {
  const key = positional[1];
  if (!key) fail("usage: dict-check add <key> --en \"...\" --zh \"...\" [--after <anchorKey>] [--dry]");

  // per-locale values from --locale "text" flags or --values '{"en":"..."}'
  const values = {};
  for (const locale of fs.existsSync(cfg.dictDir)
    ? fs.readdirSync(cfg.dictDir).map((f) => f.replace(/\.[^.]+$/, ""))
    : cfg.locales || [cfg.base]) {
    if (typeof flags[locale] === "string") values[locale] = flags[locale];
  }
  if (flags.values) {
    let parsed;
    try {
      parsed = JSON.parse(flags.values);
    } catch (e) {
      fail(`--values is not valid JSON: ${e.message}`);
    }
    Object.assign(values, parsed);
  }
  if (flags["values-file"]) {
    try {
      Object.assign(values, JSON.parse(fs.readFileSync(flags["values-file"], "utf8")));
    } catch (e) {
      fail(`cannot read --values-file: ${e.message}`);
    }
  }
  if (!Object.keys(values).length)
    fail("no translations given. Pass --en \"...\" --zh \"...\" or --values '{\"en\":\"...\"}'");

  const anchor = flags.after || null;
  const dry = !!flags.dry;
  let touched = 0;

  for (const [locale, text] of Object.entries(values)) {
    const file = path.join(cfg.dictDir, `${locale}.ts`);
    if (!fs.existsSync(file)) {
      console.log(`!! ${locale}: no file, skipped`);
      continue;
    }
    let src = fs.readFileSync(file, "utf8");
    if (new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(src)) {
      console.log(`${locale}: already present`);
      continue;
    }
    const line = `  "${key}": ${JSON.stringify(text)},`;
    if (anchor) {
      const re = new RegExp(`^(\\s*)"${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:.*$`, "m");
      const m = src.match(re);
      if (!m) {
        console.log(`!! ${locale}: anchor "${anchor}" not found, skipped`);
        continue;
      }
      src = src.replace(re, (matched, indent) => `${line}\n${matched}`);
    } else {
      // append before the last closing brace of the default export
      const idx = src.lastIndexOf("}");
      if (idx === -1) {
        console.log(`!! ${locale}: no closing brace found, skipped`);
        continue;
      }
      const before = src.slice(0, idx).replace(/\s*$/, "");
      const sep = before.endsWith("{") ? "\n" : "\n";
      src = `${before}${sep}${line}\n${src.slice(idx)}`;
    }
    if (!dry) fs.writeFileSync(file, src);
    console.log(`${locale}: ${dry ? "would add" : "added"} "${key}"`);
    touched++;
  }

  if (!touched) fail("nothing was written");
  console.log(`\n${dry ? "[dry] " : ""}${key} written to ${touched} file(s).`);
}

// ── main ────────────────────────────────────────────────────────────────────

const cfg = loadConfig();
if (command === "check") runCheck(cfg);
else if (command === "add") runAdd(cfg);
else fail(`unknown command "${command}". Use: check | add`);
