#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, refresh, readJSON, writeJSON, acquireLock, findSymbol, neighbors, fileSymbols, shortestPath, graphDiff, labelNodes, status, exportContext, VERSION } from './verse-graph.mjs';

const HELP = `Versify ${VERSION} - local Verse code navigation (Node.js 20+)

  build [root] [--vproject file] [--digest root] [--package-path /domain/Project] [--out graph.json]
  query <graph.json> <name> [--exact] [--kind kind] [--file substring] [--project-only] [--limit N]
  callers|callees <graph.json> <symbol-or-ID> [--relations calls,subscribes,constructs]
  file <graph.json> <relative-file>
  path <graph.json> <from> <to> [--directed] [--relations calls,inherits]
  update <graph.json> <file...>       Re-extract named files and re-resolve the graph
  auto-update [root-or-graph.json]    Hash scan: added, edited, deleted files; works without Git
  status <graph.json>                Check freshness and show counts
  diagnostics <graph.json>           Parser warnings and unresolved references
  diff <old.json> <new.json>          Compare graph snapshots
  label <graph.json> <labels.json>    Apply {exactSymbolID: [labels]} supplied by the agent
  export <graph.json> [--out context.json] [--project-only]  Portable chat context
  watch [root-or-graph.json] [--interval 2000]  Refresh while this process runs; Ctrl+C stops
  help

All commands accept --json for machine output. build/update/auto-update accept --strict
to fail before writing when parser diagnostics exist. Default output: versify-out/graph.json.
No network, API keys, npm packages, Epic compiler, or automatic background installation.
`;

function parseArgs(argv) {
  const positional = [], options = { digest: [] };
  const flags = new Set(['json', 'exact', 'project-only', 'directed', 'strict', 'help', 'version']);
  const values = new Set(['vproject', 'digest', 'package-path', 'out', 'kind', 'file', 'relations', 'limit', 'interval']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key)) {
      const value = argv[++i]; if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      if (key === 'digest') options.digest.push(value); else options[key] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return { positional, options };
}
function load(file) {
  const graph = readJSON(file);
  if (graph.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.files)) throw new Error(`Invalid Versify graph: ${file}`);
  return graph;
}
function graphPath(input = '.') { return input.toLowerCase().endsWith('.json') ? path.resolve(input) : path.resolve(input, 'versify-out', 'graph.json'); }
function save(file, graph, strict) {
  if (strict && graph.diagnostics.length) throw new Error(`${graph.diagnostics.length} parser warning(s); index was not written. Build without --strict and inspect diagnostics.`);
  writeJSON(file, graph); return { graphPath: path.resolve(file), ...graph.metadata };
}
function emit(value, json) {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  if (Array.isArray(value)) {
    if (!value.length) console.log('No matches.');
    for (const item of value) {
      const node = item.node || item;
      console.log(node.sourceLocation ? `${node.kind.padEnd(14)} ${node.qualifiedName || node.label}  ${node.sourceLocation}\n  ${node.id}${item.edge ? `  [${item.edge.relation}, ${item.edge.confidence}]` : ''}` : JSON.stringify(item));
    }
  } else console.log(JSON.stringify(value, null, 2));
}
export async function main(argv = process.argv.slice(2)) {
  const { positional: args, options: o } = parseArgs(argv), command = args.shift() || 'help';
  if (o.version) { console.log(VERSION); return; }
  if (['help', '-h'].includes(command) || o.help) { console.log(HELP); return; }
  const need = n => { if (args.length < n) throw new Error(`${command} requires ${n} argument(s). Run help.`); };
  const relations = o.relations?.split(',').filter(Boolean);
  let result;
  let release;
  const target = command === 'build' ? o.out || graphPath(args[0]) : command === 'auto-update' ? graphPath(args[0]) : ['update', 'label'].includes(command) ? args[0] : null;
  if (target) release = acquireLock(target);
  try {
  switch (command) {
    case 'build': {
      const root = path.resolve(args[0] || '.');
      result = save(o.out || graphPath(root), buildIndex(root, { vproject: o.vproject, digests: o.digest, packagePath: o['package-path'] }), o.strict); break;
    }
    case 'query': {
      need(2); const results = findSymbol(load(args[0]), args[1], { exact: o.exact, kind: o.kind, file: o.file, external: !o['project-only'] });
      if (o.limit !== undefined && (!Number.isInteger(Number(o.limit)) || Number(o.limit) < 1)) throw new Error('--limit must be a positive integer');
      result = o.limit ? results.slice(0, Number(o.limit)) : results; break;
    }
    case 'callers': case 'callees': need(2); result = neighbors(load(args[0]), args[1], command === 'callers' ? 'in' : 'out', relations); break;
    case 'file': need(2); result = fileSymbols(load(args[0]), args[1]); break;
    case 'path': need(3); result = shortestPath(load(args[0]), args[1], args[2], { directed: o.directed, relations }); break;
    case 'update': need(2); result = save(args[0], refresh(load(args[0]), args.slice(1)), o.strict); break;
    case 'auto-update': {
      const file = graphPath(args[0]);
      result = save(file, refresh(load(file)), o.strict); break;
    }
    case 'status': need(1); result = status(load(args[0])); break;
    case 'diagnostics': {
      need(1); const graph = load(args[0]); result = { parser: graph.diagnostics, unresolved: graph.unresolved }; break;
    }
    case 'diff': need(2); result = graphDiff(load(args[0]), load(args[1])); break;
    case 'export': {
      need(1); result = exportContext(load(args[0]), { projectOnly: o['project-only'] });
      if (o.out) { if (path.resolve(o.out) === path.resolve(args[0])) throw new Error('Export must not overwrite the source index'); writeJSON(o.out, result); result = { exported: path.resolve(o.out), symbols: result.nodes.length }; } break;
    }
    case 'label': need(2); result = save(args[0], labelNodes(load(args[0]), readJSON(args[1])), false); break;
    case 'watch': {
      const file = graphPath(args[0]), interval = Number(o.interval || 2000);
      if (!Number.isInteger(interval) || interval < 250) throw new Error('--interval must be an integer of at least 250 milliseconds');
      // Foreground only. Callers decide whether and how to run a background process.
      let graph = load(file); emit({ watching: file, interval }, o.json);
      const timer = setInterval(() => {
        try {
          if (!status(graph).fresh) {
            const unlock = acquireLock(file);
            try { graph = refresh(load(file)); emit(save(file, graph, o.strict), o.json); }
            finally { unlock(); }
          }
        }
        catch (error) { console.error(`Versify: ${error.message}`); clearInterval(timer); process.exitCode = 1; }
      }, interval);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); });
      return;
    }
    default: throw new Error(`Unknown command: ${command}. Run help.`);
  }
  emit(result, o.json);
  } finally { release?.(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Versify: ${error.message}`); process.exitCode = 1; });
}
