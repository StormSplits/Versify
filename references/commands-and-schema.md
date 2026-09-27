# Commands and graph contract

Run `node scripts/versify.mjs help` for exact CLI syntax. All operations accept `--json`. Errors use stderr and exit code 1. Singular ambiguous targets return candidate IDs rather than arbitrarily selecting one.

| Capability | Command |
| --- | --- |
| Full structural index | `build [root]` |
| Case-insensitive symbol search | `query graph.json name` |
| Re-extract named files | `update graph.json files...` |
| Hash-based bulk refresh | `auto-update root-or-graph.json` |
| Incoming/outgoing calls | `callers` / `callees` |
| File symbols | `file graph.json relative/path.verse` |
| Shortest path | `path graph.json from to`, optionally `--directed --relations calls` |
| Snapshot differences | `diff old.json new.json` |
| Domain labels | `label graph.json labels.json` |
| Foreground automatic refresh | `watch root-or-graph.json` |
| Portable chat context | `export graph.json --out context.json` |

Build accepts `--vproject`, repeatable `--digest`, `--package-path`, `--out` and `--strict`. Strict mode rejects parser warnings before replacing the index; unresolved references do not trigger it. Full builds start fresh; incremental refresh preserves semantic labels on stable IDs.

Scanning includes `.verse` and `.digest.verse`, skipping symlinks, hidden folders, dependency/output folders and common Unreal build/actor directories. A specifically passed digest root is scanned even if its parent is normally excluded. `.uasset` and `.umap` are not parsed. UTF-8 decode errors and missing configured packages are explicit failures.

Updates read files and compare SHA-256 hashes. Changed files are re-extracted and all relationships are re-resolved. Additions/deletions/renames are handled by bulk refresh; targeted updates require naming old and new paths. Manifest changes invalidate package mappings. CLI writes use a PID-bearing lock and atomic temporary replacement; direct library callers manage their own lock via `acquireLock`.

## Schema version 1

- `nodes`: files, symbols and imported module references. Symbols have IDs, names, kind, qualified name, source file/line/endLine, parent, package/module paths, signature, parameters, receiver, type/returnType, bases, attributes, specifiers and external status as applicable.
- `edges`: directed `source`, `target`, `relation`, `confidence` plus reference line where applicable. Multiple reference sites may connect the same pair.
- `unresolved`: sites with `unresolved`, `ambiguous` or `dynamic` status and candidate IDs when available.
- `diagnostics`: structural parser warnings with source location.
- `files`: physical paths, hashes and cached extractions. Contains source-derived information; local project data, not a public artifact.
- `config`: project/digest roots and manifest configuration.
- `metadata`: counts, parser version, generation time and extracted/reused/removed counts.

Locations are one-based. Project paths are relative; external digests use absolute paths. Symbol IDs include source file, qualified name and normalized signature hash. Blank-line and body-only edits normally preserve IDs; moves/signature edits can change them. Snapshot differences preserve edge direction and report node metadata changes.

`contains`, `method` and `imports` are extracted syntax. `resolves_to`, `inherits`, `calls`, `constructs`, `casts` and `subscribes` are inferred. Imports are represented by module-reference nodes linked to matching definitions/files. A callback edge is not a direct invocation. A missing edge never proves no runtime dependency exists.

## Limits

This is an independent structural navigation parser, not a complete Verse front end. It does not enforce access rules, instantiate generic types, solve overloads through full argument typing, validate effects, model task scheduling, resolve all higher-order values or expand implicit operator calls. Complex receivers, local `using`, callable aliases and inferred container types may require source reading. Runtime overrides may differ from static targets. Invalid expressions inside otherwise recognized functions may not generate a diagnostic.

Use UEFN compilation separately. Versify's format is not byte-for-byte Graphify-compatible. It reproduces Graphify's navigation workflows with a Verse-specific implementation. It uses foreground watch rather than modifying Claude-specific Stop hooks.

## Library use

`verse-parser.mjs` exports `lex` and `parseVerse`. `verse-graph.mjs` exports `buildIndex`, `refresh`, `findSymbol`, `oneSymbol`, `callersOf`, `calleesOf`, `fileSymbols`, `shortestPath`, `graphDiff`, `labelNodes`, `status`, `exportContext`, `readJSON`, `writeJSON` and `acquireLock`. `buildIndex` returns a graph without writing it. Use explicit paths and serialize writes in your host adapter.
