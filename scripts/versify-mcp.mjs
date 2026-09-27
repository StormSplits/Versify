#!/usr/bin/env node
// Local newline-delimited JSON-RPC MCP transport. stdout contains protocol messages only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isMain } from './entrypoint.mjs';
import { buildIndex, refresh, readJSON, writeJSON, acquireLock, findSymbol, neighbors, fileSymbols, shortestPath, status, exportContext, VERSION } from './verse-graph.mjs';

const text = { type: 'string' };
const paging = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } };
const spec = (name, description, properties = {}, required = [], readOnly = true) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
export const toolDefinitions = [
  spec('versify_build', 'Build the pinned Verse project index, including configured digests. Writes only its index.', {}, [], false),
  spec('versify_refresh', 'Refresh added, changed and deleted files and resolve relationships. Writes only the index.', {}, [], false),
  spec('versify_status', 'Check freshness, counts and parser version.'),
  spec('versify_query', 'Find symbols; exact IDs disambiguate overloads. Use returned source locations to inspect code.', { query: text, exact: { type: 'boolean' }, projectOnly: { type: 'boolean' }, kind: text, ...paging }, ['query']),
  spec('versify_neighbors', 'Find callers or callees, optionally including subscriptions and construction. These are inferred static relationships.', { symbol: text, direction: { type: 'string', enum: ['in', 'out'] }, relations: { type: 'array', items: text }, ...paging }, ['symbol', 'direction']),
  spec('versify_file', 'List symbols in one graph-relative Verse source file, or an indexed absolute digest path.', { file: text, ...paging }, ['file']),
  spec('versify_path', 'Find a shortest relationship path between exact symbols. Relations can restrict to calls.', { from: text, to: text, directed: { type: 'boolean' }, relations: { type: 'array', items: text } }, ['from', 'to']),
  spec('versify_diagnostics', 'Page through parser warnings or unresolved/ambiguous call targets. Zero warnings does not mean valid Verse.', { category: { type: 'string', enum: ['parser', 'unresolved'] }, ...paging }),
  spec('versify_export', 'Return a paged portable symbol/edge snapshot without physical root paths or extraction caches. May contain private source signatures.', { projectOnly: { type: 'boolean' }, category: { type: 'string', enum: ['nodes', 'edges'] }, ...paging })
];
function checkArguments(definition, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  const schema = definition.inputSchema;
  for (const k of schema.required) if (!(k in args)) throw new Error(`Missing argument: ${k}`);
  for (const [key, value] of Object.entries(args)) {
    const s = schema.properties[key]; if (!s) throw new Error(`Unknown argument: ${key}`);
    if (s.type === 'integer' ? !Number.isInteger(value) : s.type === 'array' ? !Array.isArray(value) || value.some(v => typeof v !== 'string') : typeof value !== s.type) throw new Error(`Wrong type: ${key}`);
    if (s.enum && !s.enum.includes(value) || s.minimum !== undefined && value < s.minimum || s.maximum !== undefined && value > s.maximum) throw new Error(`Invalid value: ${key}`);
  }
}
export function createServer({ root, vproject, digests = [], packagePath, output } = {}) {
  if (!root) throw new Error('--root is required; select the project explicitly');
  root = path.resolve(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('Root must be a directory');
  const graphFile = path.resolve(output || path.join(root, 'versify-out', 'graph.json'));
  const buildOptions = { vproject, digests, packagePath };
  const load = () => {
    const g = readJSON(graphFile);
    if (g.schemaVersion !== 1 || !Array.isArray(g.nodes) || !Array.isArray(g.files) || !g.config?.root) throw new Error('Invalid index; run versify_build');
    if (path.resolve(g.config.root) !== root) throw new Error('Index belongs to another project; choose a different output or rebuild');
    return g;
  };
  const page = (items, args) => { const offset = args.offset || 0, limit = args.limit || 100; return { total: items.length, offset, nextOffset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) }; };
  function call(name, args) {
    const definition = toolDefinitions.find(t => t.name === name);
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    checkArguments(definition, args);
    let result;
    if (name === 'versify_build' || name === 'versify_refresh') {
      const unlock = acquireLock(graphFile);
      try {
        const graph = name === 'versify_build' ? buildIndex(root, buildOptions) : refresh(load());
        writeJSON(graphFile, graph); result = graph.metadata;
      } finally { unlock(); }
    } else {
      const g = load();
      switch (name) {
        case 'versify_status': result = status(g); break;
        case 'versify_query': result = page(findSymbol(g, args.query, { exact: args.exact, external: !args.projectOnly, kind: args.kind }), args); break;
        case 'versify_neighbors': result = page(neighbors(g, args.symbol, args.direction, args.relations), args); break;
        case 'versify_file': result = page(fileSymbols(g, args.file), args); break;
        case 'versify_path': result = { path: shortestPath(g, args.from, args.to, { directed: args.directed, relations: args.relations }) }; break;
        case 'versify_diagnostics': result = page(args.category === 'unresolved' ? g.unresolved : g.diagnostics, args); break;
        case 'versify_export': { const exported = exportContext(g, args); result = { format: exported.format, note: exported.note, ...page(exported[args.category || 'nodes'], args) }; break; }
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
  let initialized = false;
  return message => {
    const id = message?.id;
    const error = (code, text) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || Array.isArray(message) || (id !== undefined && typeof id !== 'string' && typeof id !== 'number')) return error(-32600, 'Invalid request');
    if (id === undefined) return null;
    let result;
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      if (typeof requested !== 'string') return error(-32602, 'Missing protocolVersion');
      initialized = true;
      result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(requested) ? requested : '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'versify', version: VERSION }, instructions: 'Verse navigation only. Build or check index freshness first. Calls are inferred; inspect unresolved sites and actual source. No compiler validation.' };
    } else if (message.method === 'ping') result = {};
    else if (!initialized) return error(-32002, 'Initialize first');
    else if (message.method === 'tools/list') result = { tools: toolDefinitions };
    else if (message.method === 'tools/call') {
      if (typeof message.params?.name !== 'string' || !toolDefinitions.some(t => t.name === message.params.name)) return error(-32602, 'Unknown or missing tool name');
      try { result = call(message.params.name, message.params.arguments ?? {}); }
      catch (e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
    } else return error(-32601, 'Method not found');
    return { jsonrpc: '2.0', id, result };
  };
}
export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log('versify-mcp --root project [--vproject file] [--digest root] [--package-path /domain/project] [--out graph.json]\nLocal stdio MCP server. Only JSON-RPC is written to stdout during operation.'); return; }
  const opts = { digests: [] }, keys = { '--root': 'root', '--vproject': 'vproject', '--package-path': 'packagePath', '--out': 'output' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--digest') opts.digests.push(value);
    else if (keys[key]) opts[keys[key]] = value;
    else throw new Error(`Unknown option: ${key}`);
  }
  const handle = createServer(opts);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (!line.trim()) return;
    let result;
    try { result = handle(JSON.parse(line)); }
    catch { result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  });
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Versify: ${error.message}`); process.exitCode = 1; }
}
