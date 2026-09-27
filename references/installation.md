# Installation and agent compatibility

## Three integration choices

1. **Agent Skill + CLI:** copy this folder into the host's skill directory or run the installer. The host reads `SKILL.md` and invokes Node scripts. Any model served through such a host can use the same workflow.
2. **Local MCP:** launch the included stdio server through a host that supports subprocess MCP servers. It exposes structured navigation tools independently of skill discovery.
3. **Chat export:** for a host without local tools, build an index locally and export a compact JSON snapshot, then upload/paste the snapshot and relevant source files. This provides static context, not live local access.

## Host matrix

| Host/model family | Route | Boundary |
| --- | --- | --- |
| Claude Code, including Opus/Sonnet models | `--agent claude`, or local MCP | Model choice is managed by Claude Code; no model-specific code is needed. |
| Cursor | `--agent cursor`, generic skill directory, or MCP | Local skills need separate syncing/committing for cloud workers. |
| Kimi Code | `--agent kimi`, generic skill directory, or MCP | Uses documented Kimi Code skill roots; honors `KIMI_CODE_HOME` for user installs. |
| OpenAI Codex | `--agent codex`, generic skills, or MCP | Optional `agents/openai.yaml` provides UI metadata; other agents can ignore it. |
| OpenAI/ChatGPT tool-enabled environments | Host skill/CLI support, or an appropriately configured MCP connection | A browser chat cannot directly launch this local stdio server. Tool availability depends on the host and account. |
| Grok or Kimi models in a local coding harness | Generic skill, CLI, or subprocess MCP if the harness supports it | Capability belongs to the harness, not the model name. |
| Grok API remote MCP / ChatGPT remote-only connectors | Separate stdio-to-HTTP bridge/deployment, or export | This release does not include a remotely hosted/authenticated service or automatically expose local files. |
| Any chat accepting text/files | Exported context + relevant source | Static snapshot only; refresh/export after edits. |
| Other or unknown agents, including a host called “Cloud Fable” | `--dest` for its documented skill directory, CLI/MCP if supported, otherwise export | No verified product-specific “Cloud Fable” integration is claimed. |

The request's “Cloud Code/Opus/Sonnet” is treated as Claude Code/Claude model names for the concrete adapters. The generic interfaces remain usable for other products. “Works with all AIs” means a model-neutral interface, not a guarantee that every application can execute tools or load skills.

## Skill installer

Requires Node.js 20+. Run from the extracted package:

```sh
node scripts/install.mjs --agent generic --dry-run
node scripts/install.mjs --agent generic
```

Default personal destinations:

| Installer option | Destination |
| --- | --- |
| `generic` or `codex` | `~/.agents/skills/versify` |
| `claude` | `~/.claude/skills/versify` |
| `cursor` | `~/.cursor/skills/versify` |
| `kimi` | `$KIMI_CODE_HOME/skills/versify`, default `~/.kimi-code/skills/versify` |

For older/custom hosts use `--dest` with the exact final folder, e.g. `--dest /home/me/.codex/skills/versify`. User scope is the default; project scope uses the corresponding hidden directory under `--root`. The installer copies only package files, refuses existing targets and never rewrites `AGENTS.md`, `CLAUDE.md`, MCP settings or shell profiles. Reload the host afterwards. To uninstall, repeat the installation command with `--uninstall`, for example `node scripts/install.mjs --agent claude --uninstall`. A receipt and file hashes prevent removing changed installations or unrelated data; `--dry-run` previews the action. Remove any separately added MCP entry yourself. To update, uninstall an unchanged installation then install the new copy; preserve local modifications first.

## Local MCP configuration

Use absolute paths; replace the example paths with yours. In a host using `mcpServers` JSON (such as Claude Desktop/Cursor-style configurations), merge this entry into the existing configuration:

```json
{
  "mcpServers": {
    "versify": {
      "command": "node",
      "args": [
        "/absolute/path/to/versify/scripts/versify-mcp.mjs",
        "--root", "/absolute/path/to/VerseContent",
        "--vproject", "/absolute/path/to/Project.vproject"
      ]
    }
  }
}
```

Windows JSON paths can use `C:/Users/me/...` or escaped backslashes. Omit the `--vproject` pair for source-only use. Explicit `--digest` and `--package-path` also work. After a global npm install, `versify-mcp` is available, but `node` plus the absolute script path is more portable across host process launchers.

Codex CLI supports adding a stdio MCP server:

```sh
codex mcp add versify -- node /absolute/path/to/versify/scripts/versify-mcp.mjs --root /absolute/path/to/VerseContent
```

The server pins one project root at startup and writes only its index. No remote listener is opened. Tools include build/refresh, freshness, symbol search, callers/callees, file symbols, paths, diagnostics and exports. Query results are paged (100 default, 500 maximum); follow `nextOffset` until null. Build/refresh are marked as write operations. All other tools are read-only. The stdio transport negotiates known MCP protocol versions and emits only JSON-RPC on stdout.

The packaged server is not directly a remote HTTP endpoint. If a host only supports remote MCP, its deployment/bridge and authentication must be configured separately. The same applies to remote OpenAI and xAI API environments. Alternatively expose the CLI/API through the tool mechanism of your own local harness; no provider SDK is required by Versify.

## ChatGPT/Grok/Kimi chat-only export

```sh
node scripts/versify.mjs export /path/to/versify-out/graph.json --project-only --out context.json
```

Inspect `context.json`, then attach it to the chat with the relevant `.verse` files. It omits physical root paths and cached expression data, uses portable symbol IDs, and retains signatures and relationship evidence. It can still contain private names, module paths and signatures. Suggested prompt:

> Use this Versify context to locate the relevant Verse symbols. Treat INFERRED relationships as navigation hints. Ask for the indicated source files before proposing edits. The snapshot is not compiler validation.

## Distribution and verified scope

Share the ZIP or npm tarball. The package has no hardcoded developer-machine paths or bundled project indexes. Users supply their own source/digest roots. No registry publication or GitHub hosting is performed by these scripts.

The implementation and protocol tests run locally. Vendor documentation establishes the installation conventions; no claim is made that every vendor app/UI was launched and tested. Node portability is designed in; this session's actual execution environment was Windows.

Official references reviewed 2026-09-27:

- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Cursor skills](https://cursor.com/docs/skills)
- [Kimi Code skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)
- [OpenAI skill authoring](https://learn.chatgpt.com/docs/build-skills)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [xAI remote MCP](https://docs.x.ai/developers/tools/remote-mcp)
- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
