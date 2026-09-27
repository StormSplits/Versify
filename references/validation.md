# Version 1.0.0 verification

Completed 2026-09-27 on Windows with Node.js 24.13.0.

## Pass 1: source package

- Package files, skill metadata and nine local Markdown links checked.
- 55 automated tests passed, including parsing, graph operations, incremental updates, installer/uninstaller and MCP wire transport.
- Skill-creator's independent `quick_validate.py` packaging validator passed. Its PyYAML dependency was installed only in a temporary development directory; Versify has no Python runtime dependency.
- Real UEFN corpus: 11 files, 6,938 symbols, 11,919 relationship edges, zero structural parser diagnostics.
- Incremental refresh without edits reused all 11 file extractions.
- Graph symbol IDs were unique and every edge endpoint existed.

## Pass 2: distributed package

- Built an npm tarball with the package allowlist and installed it offline into an isolated prefix.
- Re-ran package/link checks and all 55 tests against the installed tarball: passed.
- Re-ran the skill packaging validator against the installed copy: passed.
- Rebuilt the real corpus using the installed CLI in strict mode: passed.
- Compared nodes, edges and unresolved references from both full-corpus builds: identical.

## Limits of this evidence

The corpus contains 166 unresolved references: 119 unresolved, 40 ambiguous and seven dynamic. They remain visible for inspection; no claim of a complete call graph is made. Zero structural diagnostics is not a Verse compilation result.

The MCP protocol and command-line integrations were exercised locally. Claude Code, Cursor, Kimi, ChatGPT and Grok user interfaces were not each launched end-to-end. Their setup instructions are based on the cited official documentation. The repository CI matrix is configured for Windows/macOS/Linux and Node 20/24; its subsequent results are separate from these local checks.

No project Verse files, generated API digests, graph caches, personal paths, credentials or npm dependencies are included in the package. The original repository MIT license and author attribution are preserved.
