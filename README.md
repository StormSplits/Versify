# Versify

**Versify is a portable code-navigation skill and toolkit for Epic's Verse language.** It builds a local map of your UEFN project so coding agents can find symbols, trace relationships, and read the right source files.

Runs on Node.js 20+ using only built-in modules. No API key, network connection or npm dependency is needed. Includes a portable Agent Skill, CLI and local stdio MCP server. The engine is model-independent: the host must provide file/command access, MCP, or accept an exported context file.

## What it does

> [!WARNING]
> **Large indexes and token usage:** Versify's generated `versify-out/graph.json` can become large, especially when indexing many Verse files or including Epic's API digests. This is a separate navigation index; Versify does not generate or modify Epic's `.digest.verse` files. Even a small project can produce a large index when full API digests are included.
>
> Versify may be useful for large projects and repeated cross-file investigations because focused queries can reduce unrelated source reads. For small projects or one-off questions, direct source reading may be simpler: indexing, skill instructions, tool definitions and query responses can add unnecessary overhead. Local index size is not itself an AI token charge, and building the index makes no model calls. **Do not load the entire graph into the AI's context.** Prefer narrow queries with `--limit`, paged MCP results, and source-only indexing when API relationships are unnecessary. `--project-only` filters query results; it does not shrink an existing index.
>
> **Research finding:** [The original Graphify implementation](https://github.com/Howell5/graphify-ts#what-it-does) describes avoiding wasted searches, but its README provides no measured token-savings benchmark. A [different graphify-ts fork](https://github.com/spacethree/graphify-ts#on-a-real-production-codebase-measured-today) reports 615,190 versus 233,508 input tokens (about 62% fewer) for one question on a 1,268-file JS/TS project, while also [reporting roughly 13% higher cold-start costs](https://github.com/spacethree/graphify-ts#honest-disclosure). Those are project-reported results for a different implementation, not independent verification or Verse evidence. **Versify has not been benchmarked for token savings; no percentage or cost reduction is guaranteed.** Compare equivalent tasks on your own project before assuming savings.

- Indexes `.verse` source and generated `.digest.verse` API files.
- Finds classes, modules, functions, extension methods, fields, enums and other declarations with file and line locations.
- Traces imports, inheritance, calls, construction and event-handler subscriptions.
- Includes UEFN API and asset packages through your `.vproject` manifest.
- Refreshes changed files, additions and deletions without requiring Git.
- Supports callers/callees, relationship paths, snapshot comparisons and searchable semantic labels.
- Exposes the same navigation through a CLI, Agent Skill and local MCP server, plus context export for ordinary chat apps.

## When Versify is useful

**Use Versify when the question is “where is this behavior implemented, and what connects to it?”** Its main benefit is giving an agent a reusable navigation map with source locations. Potential token savings come from using that map to select relevant code; they are not a prerequisite for the tool being useful.

| Situation | How Versify helps | Appropriate scope |
| --- | --- | --- |
| A project has separate inventory, combat, UI and progression systems | Find the relevant definitions and trace recorded calls across files before reading implementations | Build the project once, then make focused queries |
| A button or trigger produces unexpected behavior | Locate the setup function and recorded subscription handlers, then inspect their source | Include `subscribes` as well as `calls` |
| You are changing a shared helper | Find recorded callers to identify code worth reviewing after the change | Query callers, edit, refresh and validate in UEFN |
| You need the API declaration used by a device | Search the installed build's generated API definitions and follow resolved relationships | Include the current `.vproject` and its digests |
| You only need to change one message in a short, known file | Indexing may add little value; read that file directly | No index needed |

The graph is a starting point for investigation. Dynamic calls, ambiguous overloads and unsupported resolution cases can be missing from the resolved edges, so it is not an exhaustive refactoring checklist or a runtime debugger.

### Example 1: trace a button's handler

Suppose your project contains this illustrative device, with `OnPressed` implemented elsewhere in the same class:

```verse
shop_device := class(creative_device):
    @editable
    BuyButton:button_device = button_device{}

    OnBegin<override>()<suspends>:void =
        BuyButton.InteractedWithEvent.Subscribe(OnPressed)

    OnPressed(Agent:agent):void =
        GrantReward(Agent)

    GrantReward(Agent:agent):void =
        Print("Grant the configured reward here")
```

This is a navigation example, not a complete shop implementation; use the usual Devices and Simulation imports in a real file. From the source root, with the CLI installed:

```sh
versify build .
versify query versify-out/graph.json shop_device.OnBegin --exact
versify callees versify-out/graph.json shop_device.OnBegin --relations calls,subscribes
versify callees versify-out/graph.json shop_device.OnPressed
versify callers versify-out/graph.json shop_device.GrantReward
```

The subscription query points to `OnPressed`; the next query connects it to `GrantReward`. The agent can open those definitions at the returned line numbers. The external `Subscribe` method may remain unresolved without API digests, while the local handler relationship is still useful. No need to feed the entire project or graph into the conversation.

Suggested agent request: **“Use Versify to trace which handler the buy button subscribes to and what that handler calls. Read those functions and explain the flow; flag unresolved targets.”**

### Example 2: review a shared function change

You want to change `inventory_service.AddItem`, which is used by multiple gameplay systems. The names below are illustrative; substitute symbols from your project:

```sh
versify query versify-out/graph.json AddItem --project-only --limit 10
versify callers versify-out/graph.json inventory_service.AddItem
# After editing the actual source file:
versify update versify-out/graph.json Systems/inventory_service.verse
```

Use the returned caller locations to review affected code. If the name is ambiguous, use its exact ID from the first query. Check unresolved references and validate the change in UEFN; callers alone cannot prove that every use has been found.

Suggested agent request: **“Before changing AddItem, use Versify to find its recorded callers. Read the relevant call sites, make the change, refresh the index, and describe any unresolved dependencies.”**

### Example 3: choose the right index size

- **One short device, one text change:** open the `.verse` file directly. Building a graph and adding tool instructions may take more work than the task itself.
- **Many Verse files, repeated code questions:** start with `versify build .`, then use narrow queries such as `versify query versify-out/graph.json GrantReward --project-only --limit 10`. Reuse the index and refresh it after edits. This avoids repeatedly searching unrelated systems.
- **A small device that depends on unfamiliar Epic APIs:** a digest-inclusive index may still help. Build with `versify build . --vproject /path/to/Project.vproject`, then query a specific API symbol such as `creative_device --exact --limit 5`. The index can be large because it includes external definitions, even though your own source is small.

For the last example, the complete query is `versify query versify-out/graph.json creative_device --exact --limit 5`. Adding `--project-only` would hide the external API definitions you are trying to inspect. For any example, keep the graph on disk and send only relevant results to the agent. Query limits count results, not tokens; long signatures and subsequent source reads still consume context. Measure whole-session usage on comparable tasks if token cost is your main concern.

## Requirements

- **Node.js 20 or newer** (`node --version`).
- Your Verse source files; an optional UEFN `.vproject` and generated digests improve external API resolution.
- Git only if cloning the repository; npm only if installing the CLI package.

The toolkit is designed for Windows, macOS and Linux. UEFN itself is not required to run the indexer, but remains the authority for compiling Verse.

## Installation

### Clone the repository

```sh
git clone https://github.com/StormSplits/Versify.git
cd Versify
```

Alternatively use GitHub's **Code → Download ZIP** and extract it. There is no dependency-install step for running the scripts.

### Install the skill for your agent

From the cloned or extracted folder, choose the host you use:

```sh
node scripts/install.mjs --agent claude
node scripts/install.mjs --agent cursor
node scripts/install.mjs --agent kimi
node scripts/install.mjs --agent codex
```

For hosts supporting the shared Agent Skills directory:

```sh
node scripts/install.mjs --agent generic
```

The installer copies the complete skill into the selected host's personal skill directory. Use `--dry-run` to preview, `--scope project --root /path/to/project` for a project installation, or `--dest /exact/skill/folder` for a custom location. It refuses to overwrite an existing folder. Reload the agent, then ask it to use **Versify** to index your project. A host with slash-skill support may expose `/versify`.

### Optional: install global CLI commands

From this repository:

```sh
npm install -g . --ignore-scripts --no-audit --no-fund
versify --help
```

This installs `versify`, `versify-mcp` and `versify-install`. It does not automatically install a skill into every agent; use `versify-install --agent <host>` for that.

## Quick start

Download/extract the release, then run from your Verse source directory:

```sh
node /path/to/versify/scripts/versify.mjs build .
node /path/to/versify/scripts/versify.mjs query versify-out/graph.json OnBegin
```

For UEFN API and asset relationships, add `--vproject /path/to/YourProject.vproject` to the build. Quote paths containing spaces. Windows can use `node "C:/path/to/versify/scripts/versify.mjs"` or the included `scripts/versify.cmd`.

With the global CLI installed, a typical session is:

```sh
versify build /path/to/VerseContent --vproject /path/to/Project.vproject
versify query /path/to/VerseContent/versify-out/graph.json OnBegin --project-only
versify callees /path/to/VerseContent/versify-out/graph.json my_device.OnBegin
versify auto-update /path/to/VerseContent
```

The default index is `versify-out/graph.json` inside the source root. It contains source-derived project data; keep it local or review it before sharing. When a symbol name is ambiguous, query it and use its exact returned ID. Run `versify help` for all commands.

### Install from a locally built tarball

To create a package someone else can install:

```sh
npm pack --ignore-scripts
```

Then, on the receiving computer:

```sh
npm install -g ./versify-verse-1.0.0.tgz
versify --help
versify-install --agent generic
```

This project has **not** been published to the npm registry; `npm install -g versify-verse` is not an advertised installation method. Use the repository, ZIP or a tarball built from this source.

## MCP setup

For an agent supporting local stdio MCP, add an entry like this to its MCP configuration and substitute your own absolute paths:

```json
{
  "mcpServers": {
    "versify": {
      "command": "node",
      "args": [
        "/absolute/path/to/Versify/scripts/versify-mcp.mjs",
        "--root", "/absolute/path/to/VerseContent"
      ]
    }
  }
}
```

Add `"--vproject", "/absolute/path/to/Project.vproject"` to `args` to include API digests. Windows paths can use `C:/...`. This is a local subprocess server; no port or remote service is opened. MCP tools include building, refreshing, querying, tracing relationships and viewing diagnostics.

## Compatibility

| Environment | Setup |
| --- | --- |
| Claude Code with Opus, Sonnet or another supported model | Claude skill installer or local MCP |
| Cursor | Cursor/generic skill installer or MCP |
| Kimi Code | Kimi/generic skill installer or MCP |
| OpenAI Codex | Codex/generic skill installer or MCP |
| Grok, Kimi or other models in a coding harness | CLI, skill or MCP according to the harness's capabilities |
| ChatGPT or another chat-only app | Upload an exported context snapshot and relevant source files |

Model choice does not change the parser. The application must support the selected integration; no toolkit can give arbitrary chat apps direct access to your computer. Remote-only MCP clients need a separately configured bridge/deployment. See the detailed [compatibility guide](references/installation.md).

For chat-only use:

```sh
versify export /path/to/versify-out/graph.json --project-only --out context.json
```

Review `context.json` before uploading it. Physical root paths and extraction caches are omitted, but symbol names, module paths and signatures may be private.

## Uninstall

### Remove an installed skill

Run from the cloned/extracted repository, choosing the same agent used during installation:

```sh
node scripts/install.mjs --agent claude --uninstall
node scripts/install.mjs --agent cursor --uninstall
node scripts/install.mjs --agent kimi --uninstall
node scripts/install.mjs --agent codex --uninstall
```

Run only the commands for your installed hosts. For a generic install, use `--agent generic`. For a project or custom installation, retain the original `--scope project --root ...` or `--dest ...` arguments. Add `--dry-run` to preview removal. If globally installed, `versify-install --agent claude --uninstall` is equivalent.

The uninstaller verifies its receipt and file hashes before removing only the installed skill folder. It refuses modified files, additional user data, symbolic links or folders without a valid receipt; back up and inspect such folders manually. It leaves your Verse files, graphs and host configuration untouched.

### Remove global CLI commands

After removing any desired skill installations:

```sh
npm uninstall -g versify-verse
```

If you installed an MCP entry, remove only the `versify` entry from the host's configuration and reload it. For a Codex entry created with `codex mcp add`, use `codex mcp remove versify`. Stop any foreground `versify watch` or MCP process first. You can separately delete the generated project's `versify-out` folder after confirming you no longer need its graph; this is optional.

## Updating

Update your repository checkout with `git pull`. For copied skills, uninstall the unchanged old skill using the commands above, then reinstall it. Back up local modifications before replacing a modified installation. Reinstall the optional global CLI with `npm install -g . --ignore-scripts --no-audit --no-fund`. Refresh or rebuild indexes after parser updates.

## Troubleshooting

- **Node not found:** install Node.js 20+ and ensure the host's process environment can find `node`; otherwise configure its absolute executable path.
- **Skill not visible:** verify the selected host directory and reload the agent. Remote workers need their own copy of the skill and source files.
- **Missing API symbols:** supply the current `.vproject` or explicit `--digest` roots; do not edit generated digests.
- **Ambiguous symbol:** use an exact symbol ID from `query`.
- **Stale graph:** run `status`, then `auto-update`.
- **Index locked:** another writer may be active. If its process crashed, verify the recorded PID has exited before removing that specific `.lock` file.
- **Parser warning or unresolved target:** inspect `diagnostics` and the actual source; do not treat a missing relationship as proof of no dependency.

See [installation and compatibility](references/installation.md) for MCP configuration, model/host distinctions and chat-only use. See [commands and schema](references/commands-and-schema.md) for advanced operations and [research](references/research.md) for sources and validation.

## Reliability boundary

Versify is an independent structural parser, not Epic's compiler. It preserves ambiguous and dynamic references instead of claiming complete resolution. Use UEFN to validate compilation and gameplay. Tested on the supplied Windows environment; Windows/macOS/Linux use the same Node standard library implementation, but other operating systems and named agent UIs have not been end-to-end tested here.

Run `npm test` to execute the bundled regression and integration tests. The code is MIT licensed; Epic source/digests and user project data are not bundled in the release.

## Development and contributions

```sh
npm test
npm pack --dry-run --ignore-scripts
```

Tests use isolated temporary fixtures and do not need UEFN. CI is configured to run the suite on Windows, macOS and Linux with Node 20 and 24. Run `npm run verify` to check package structure and documentation links as well. Please report parser issues with a minimal reproducible Verse snippet, expected symbols/relationships, Node version and the UEFN version where applicable. Do not post private digests or project data without permission.

See [LICENSE](LICENSE) for the MIT terms. Versify is independent of Epic Games and the AI vendors listed above.
