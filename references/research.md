# Research and validation

Research date: 2026-09-27. Implementation is original. Graphify, Epic and other vendors do not endorse this package. No Epic digest or user source is included in the distributable.

## Sources actually reviewed

- [Howell5/graphify-ts](https://github.com/Howell5/graphify-ts): the upstream of the installed version 0.2.0. README and local query/diff/semantic implementations established the navigation feature baseline. Versify includes indexing, symbol queries, callers/callees, file symbols, paths, diffs, updates and supplied semantic labels.
- [Epic Verse Glossary](https://dev.epicgames.com/documentation/fortnite/verse-glossary): declaration forms, bracket roles, block formats and language terminology informed structural extraction.
- [Epic Writing Simple Code](https://dev.epicgames.com/documentation/fortnite/basics-of-writing-code-4-writing-simple-code-in-verse): line, nested block and indented comments informed lexical handling.
- [Epic Coding Device Interactions](https://dev.epicgames.com/documentation/fortnite/coding-device-interactions-in-verse): published reference code for editable devices, lifecycle functions and subscription handlers informed the separate callback relationship and authored tests.
- Official host/MCP documentation is listed in [installation.md](installation.md).

Epic's quick-reference, functions, modules/paths and specifier reference pages were also requested online, but returned empty extracted pages or redirects. They are not claimed as fully read. Accessible Epic pages and local generated digests supplied concrete syntax evidence.

## Real corpus

The LearningUIs manifest supplied exact source and external package roots. Seven project sources and four generated digests (Verse, Fortnite, UnrealEngine and project assets) were used. Digest headers identified build `++Fortnite+Release-42.20-CL-58011042`. Files were read only.

Observed syntax included generic factories, qualified extensions and enum members, native bodyless declarations, operators, scoped specifiers, parameterized editable attributes, nested comments and interpolation. All 11 files indexed with zero structural diagnostics during development. Uncertain references were preserved rather than claimed as resolved. This result is specific to the tested corpus and parser version.

## Repeatable checks

1. Run `npm test` from the package. Tests use authored snippets and isolated temporary directories; no UEFN/network needed.
2. Build the real source root with `--vproject` and `--strict`, using a test output path.
3. Inspect counts, unresolved sites and known source-to-digest links; zero warnings does not imply compilation success.
4. Run bulk refresh without edits and verify file extraction reuse. Tests cover additions, edits, renames and deletions without changing user source.
5. Validate the skill frontmatter and linked resources. Test archive installation in an isolated prefix and the local MCP JSON-RPC handshake/tool calls.

The tests exercise parser structure, comments/strings, Windows paths/encoding, ambiguity, type-based receiver lookup, inheritance, callbacks, module visibility, incremental state, manifests, labels, paths, diffs, locks, export privacy boundaries, installation and MCP. OS and vendor-app end-to-end claims are limited to what was actually run; see the validation report shipped with the release artifacts.
