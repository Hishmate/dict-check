/**
 * Self-test. Runs the tool against example/ (a deliberately drifted pair of
 * dictionaries) and against a temp copy that `add` repairs.
 *
 *   npm test
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dict-check.mjs");
const EXAMPLE_CONFIG = path.join(ROOT, "example", "dict-check.config.json");

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed++;
}

function run(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

// 1. the drifted example must fail with every drift class named
const drift = run(["check", "--config", EXAMPLE_CONFIG]);
ok(drift.code === 1, "check exits 1 on drifted dictionaries");
for (const needle of ["intro.sub", "nav.blog", "placeholders {name} vs {user}", "nav.search"])
  ok(drift.out.includes(needle), `check reports: ${needle}`);

// 2. a clean pair must pass
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dict-check-test-"));
const cleanDir = path.join(tmp, "messages");
fs.cpSync(path.join(ROOT, "example", "messages"), cleanDir, { recursive: true });
const cleanEn = fs.readFileSync(path.join(cleanDir, "en.ts"), "utf8");
fs.writeFileSync(path.join(cleanDir, "en.ts"), cleanEn);
// make zh identical to en: fix every drift the checker would find
let zh = fs.readFileSync(path.join(cleanDir, "zh.ts"), "utf8");
zh = zh.replace('"nav.blog": "博客",\n  ', ""); // drop the extra key
zh = zh.replace("你好 {user}", "你好 {name}"); // fix the placeholder
zh = zh.replace(
  "const zh = {",
  'const zh = {\n  "intro.sub":\n    "发布一个小任务——有人会为你咨询、推广或测试。",'
);
fs.writeFileSync(path.join(cleanDir, "zh.ts"), zh);
fs.writeFileSync(
  path.join(tmp, "dict-check.config.json"),
  JSON.stringify({ dictDir: "messages", base: "en", root: ".", sources: [], placeholders: true })
);
const clean = run(["check", "--config", path.join(tmp, "dict-check.config.json")]);
ok(clean.code === 0, "check exits 0 on dictionaries in lockstep");
ok(clean.out.includes("All locales in lockstep OK"), "clean run prints the success line");

// 3. add inserts a new key into every locale file
const add = run([
  "add",
  "footer.copy",
  "--config",
  path.join(tmp, "dict-check.config.json"),
  "--en",
  "Copy",
  "--zh",
  "复制",
  "--after",
  "nav.home",
]);
ok(add.code === 0, "add exits 0");
ok(
  fs.readFileSync(path.join(cleanDir, "en.ts"), "utf8").includes('"footer.copy": "Copy"') &&
    fs.readFileSync(path.join(cleanDir, "zh.ts"), "utf8").includes('"footer.copy": "复制"'),
  "add writes the key to every locale file"
);
const afterAdd = run(["check", "--config", path.join(tmp, "dict-check.config.json")]);
ok(afterAdd.code === 0, "check still passes after add (no new drift)");

// 4. add refuses to duplicate an existing key
const dup = run([
  "add",
  "nav.home",
  "--config",
  path.join(tmp, "dict-check.config.json"),
  "--en",
  "Start",
  "--zh",
  "开始",
]);
ok(dup.out.includes("already present"), "add is idempotent for existing keys");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) failed` : "\nAll tests passed");
process.exit(failed ? 1 : 0);
