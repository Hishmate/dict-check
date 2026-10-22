# dict-check

Keep flat translation dictionaries in lockstep across locales — one file, zero
dependencies.

A missing key does not crash your app. It ships the raw key name to the user:
`wd.sending` instead of "Broadcasting…". Most i18n setups have no guard against
that, because the failure is silent until someone who reads the language
notices. `dict-check` is the guard.

```bash
npx dict-check check        # or just: npx dict-check
```

## What it checks

**Across locale files** (against a base locale you choose):

| Check | Why it matters |
|---|---|
| Missing keys | Base has it, locale does not → users see the raw key |
| Extra keys | Locale has it, base does not → usually a key deleted in one place only |
| Duplicate keys | The later definition silently wins |
| Empty values | A translated-looking file that translates nothing |
| Placeholder parity | `"Hello {name}"` in English and `"你好 {user}"` in Chinese is a broken sentence at runtime |
| Non-string values | Reported, not parsed — nested objects need a different tool |

**Across your source code:**

| Check | Why it matters |
|---|---|
| Unresolved `t("key")` | A literal reference to a key that does not exist → the raw string renders |
| Never-referenced keys | Keys no code path uses any more (warning; dynamic assemblies are ignored via `ignore` globs) |

## Install

```bash
git clone https://github.com/Hishmate/dict-check.git && cd dict-check
# or just copy dict-check.mjs into your repo — it is one file
```

Create `dict-check.config.json` in your project root:

```json
{
  "dictDir": "lib/i18n/messages",
  "base": "en",
  "sources": ["app/**", "components/**", "lib/**"],
  "ignore": ["demo.*", "cat.*"]
}
```

`dictDir` and `base` are required; everything else defaults sensibly. Both
resolve against the config file's directory, so one config works from any cwd.

| Field | Default | Meaning |
|---|---|---|
| `dictDir` | — | Directory holding one file per locale (`en.ts`, `zh.ts`, …) |
| `base` | — | The source-of-truth locale that defines the full key set |
| `root` | `"."` | Directory the `sources` globs resolve against |
| `locales` | every file in `dictDir` | Explicit locale list, if you prefer |
| `sources` | `[]` | Globs to scan for `t("literal")` references |
| `translate` | `"t"` | The translate function name to look for |
| `ignore` | `[]` | Key globs excluded from the unused-keys report |
| `placeholders` | `true` | Check `{token}` parity between base and locale values |

## Commands

```bash
dict-check check [--config path] [--strict] [--show-unused]
dict-check add <key> --en "..." --zh "..." [--after <anchorKey>] [--dry]
```

`add` writes one key into every locale file in a single pass, each with its own
translation, inserted next to an anchor key so the file keeps reading in page
order:

```bash
dict-check add footer.copyEmail \
  --en "Copy" --zh "复制" --ja "コピー" \
  --after footer.email
```

Values can also come from a file (`--values-file translations.json`) when a key
needs all eleven languages at once. `--dry` prints the plan without writing.

Exit codes: `0` clean, `1` problems found — so it drops straight into CI.

## CI

```yaml
- run: npx dict-check check
```

## Try it

`example/` holds a deliberately drifted pair of dictionaries:

```bash
node dict-check.mjs check --config example/dict-check.config.json
```

```
base: en — 4 keys
  en     4 keys  ok
  zh     4 keys  DRIFT
!! zh: missing 1 key(s): intro.sub
!! zh: 1 key(s) not in base: nav.blog
!! zh.greeting: placeholders {name} vs {user}
!! unresolved reference src/nav.ts: "nav.search"
FAILED: 5 problem(s)
```

`npm test` runs the same fixture plus the `add` path against a temp copy.

## Two design decisions worth knowing

**Dictionaries are flat `"key": "value"` modules.** Not nested JSON. Flat keys
(`"nav.home"`) make cross-locale diffing a set operation; nested objects make it
a recursive merge with a dozen edge cases. This tool parses flat files and
*reports* anything else rather than guessing.

**Values may live on the next line.** Real dictionaries are hand-maintained and
mix `"k": "v",` with `"k":\n  "v",`. A parser that only understands the first
format reports phantom drift on every multi-line entry — which is exactly how
this tool's first draft failed against an 11-locale dictionary. Both formats
parse; the parser is line-oriented with a bounded look-ahead.

## Where this comes from

Built for [hishmate.com](https://hishmate.com), which runs 11 locales off one
English source-of-truth dictionary. The first real run found three keys
(`wd.sending`, `ad2.forceRefund`, `ad2.confirmForce`) that existed only in
English — a withdrawal-state-machine feature shipped in October 2026 whose
admin-facing strings had never been translated. The i18n layer falls back to
English, so nobody noticed; the checker now runs in CI.

## License

MIT — see [LICENSE](./LICENSE).
