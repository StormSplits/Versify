import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, toolDefinitions } from './versify-mcp.mjs';
import { installSkill } from './install.mjs';
import { buildIndex, exportContext } from './verse-graph.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'versify-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.verse'), 'A():void = B()\nB():void = {}\n');
  return root;
}
function client(root) {
  const server = createServer({ root }); let id = 0;
  const request = (method, params) => server({ jsonrpc: '2.0', id: ++id, method, params });
  const call = (name, args = {}) => request('tools/call', { name, arguments: args });
  request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  return { server, request, call };
}
test('MCP negotiation, capabilities and notification behavior', t => {
  const root = fixture(t), s = createServer({ root });
  assert.equal(s({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).error.code, -32002);
  const init = s({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.protocolVersion, '2024-11-05'); assert.ok(init.result.capabilities.tools);
  assert.equal(s({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(s({ jsonrpc: '2.0', id: 3, method: 'unknown' }).error.code, -32601);
  assert.equal(s({ nope: true }).error.code, -32600);
});
test('MCP build, paginated query, neighbors, path, file, status and export', t => {
  const root = fixture(t), { call, request } = client(root);
  assert.equal(request('tools/list').result.tools.length, toolDefinitions.length);
  assert.equal(call('versify_build').result.structuredContent.files, 1);
  const q = call('versify_query', { query: '', limit: 1 }).result.structuredContent;
  assert.equal(q.items.length, 1); assert.equal(q.nextOffset, 1);
  assert.equal(call('versify_query', { query: 'A', exact: true }).result.structuredContent.items[0].label, 'A');
  assert.equal(call('versify_neighbors', { symbol: 'B', direction: 'in' }).result.structuredContent.items[0].node.label, 'A');
  assert.equal(call('versify_path', { from: 'A', to: 'B', directed: true, relations: ['calls'] }).result.structuredContent.path.edges.length, 1);
  assert.equal(call('versify_file', { file: 'main.verse' }).result.structuredContent.total, 2);
  assert.equal(call('versify_status').result.structuredContent.fresh, true);
  assert.equal(call('versify_diagnostics').result.structuredContent.total, 0);
  assert.equal(call('versify_export').result.structuredContent.format, 'versify-context-1');
  assert.equal(call('versify_refresh').result.structuredContent.refresh.reused, 1);
});
test('MCP invalid arguments and missing index are controlled tool errors', t => {
  const { call, request } = client(fixture(t));
  assert.equal(call('versify_query', { query: 'A' }).result.isError, true);
  assert.equal(call('versify_query', { query: 1 }).result.isError, true);
  assert.equal(call('versify_query', { query: 'A', limit: 501 }).result.isError, true);
  assert.equal(call('versify_build', { root: '/somewhere/else' }).result.isError, true);
  assert.equal(request('tools/call', { name: 'missing' }).error.code, -32602);
});
test('stdio wire transport emits only valid JSON-RPC and handles parse errors', t => {
  const root = fixture(t), script = fileURLToPath(new URL('./versify-mcp.mjs', import.meta.url));
  const input = [
    '{bad',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'versify_build', arguments: {} } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  ].join('\n') + '\n';
  const run = spawnSync(process.execPath, [script, '--root', root], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, '');
  const responses = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 4); assert.equal(responses[0].error.code, -32700); assert.equal(responses[2].result.structuredContent.files, 1);
});
test('installer supports documented hosts without changing other host settings', t => {
  const root = fixture(t);
  for (const agent of ['generic', 'claude', 'cursor', 'kimi', 'codex']) {
    const home = path.join(root, agent);
    const preview = installSkill({ agent, home, dryRun: true }); assert.equal(fs.existsSync(preview.destination), false);
    const result = installSkill({ agent, home }); assert.equal(fs.existsSync(path.join(result.destination, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(result.destination, 'scripts', 'versify-mcp.mjs')), true);
    assert.throws(() => installSkill({ agent, home }), /already exists/);
  }
});
test('custom and project skill destinations install a self-contained runnable package', t => {
  const root = fixture(t), result = installSkill({ agent: 'claude', scope: 'project', root });
  assert.equal(result.destination, path.join(root, '.claude', 'skills', 'versify'));
  const script = path.join(result.destination, 'scripts', 'versify.mjs');
  const run = spawnSync(process.execPath, [script, 'build', root, '--strict', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).files, 1);
  assert.equal(installSkill({ destination: path.join(root, 'custom-skill') }).installed, true);
});
test('export omits extraction caches and physical external paths', t => {
  const root = fixture(t), digestRoot = path.join(root, 'external'); fs.mkdirSync(digestRoot);
  fs.writeFileSync(path.join(digestRoot, 'API.digest.verse'), '# Verse path: /Epic/API\nAPI := module:\n    Native():void\n');
  const project = path.join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'main.verse'), 'A():void = {}');
  const g = buildIndex(project, { digests: [digestRoot] }), result = exportContext(g), serialized = JSON.stringify(result);
  assert.ok(!('files' in result)); assert.ok(!('config' in result)); assert.ok(!serialized.includes(root.replaceAll('\\', '/'))); assert.ok(!serialized.includes(root));
  assert.ok(result.nodes.some(n => n.sourceFile?.startsWith('external-')));
  assert.ok(exportContext(g, { projectOnly: true }).nodes.every(n => !n.external));
});
test('distribution manifest only includes portable files', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.engines.node, '>=20'); assert.ok(!pkg.dependencies);
  assert.ok(!pkg.files.some(f => f.includes('graph.json') || f.includes('test-output')));
});
test('all executable entrypoints run through a linked directory', t => {
  const root = fixture(t), installed = path.join(root, 'installed');
  installSkill({ destination: installed });
  const alias = path.join(root, 'linked');
  fs.symlinkSync(installed, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const run = (script, args, input) => spawnSync(process.execPath, [path.join(alias, 'scripts', script), ...args], { encoding: 'utf8', input });
  const cli = run('versify.mjs', ['build', root, '--json']);
  assert.equal(cli.status, 0, cli.stderr); assert.ok(cli.stdout.trim(), 'CLI must not silently skip startup');
  assert.equal(JSON.parse(cli.stdout).files, 1);
  const installer = run('install.mjs', ['--dest', path.join(root, 'preview'), '--dry-run']);
  assert.equal(installer.status, 0, installer.stderr); assert.equal(JSON.parse(installer.stdout).dryRun, true);
  const mcp = run('versify-mcp.mjs', ['--root', root], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  assert.equal(mcp.status, 0, mcp.stderr); assert.equal(JSON.parse(mcp.stdout).result.serverInfo.name, 'versify');
});
test('uninstall removes only the unchanged installed skill and preserves neighboring files', t => {
  const root = fixture(t), destination = path.join(root, 'installed'); installSkill({ destination });
  const preview = installSkill({ destination, uninstall: true, dryRun: true }); assert.equal(preview.uninstalled, false); assert.equal(fs.existsSync(destination), true);
  assert.equal(installSkill({ destination, uninstall: true }).uninstalled, true); assert.equal(fs.existsSync(destination), false); assert.equal(fs.existsSync(path.join(root, 'main.verse')), true);
  assert.equal(installSkill({ destination, uninstall: true }).uninstalled, false);
});
test('uninstall refuses unknown, modified, or expanded directories', t => {
  const root = fixture(t); assert.throws(() => installSkill({ destination: root, uninstall: true }), /receipt/);
  const modified = path.join(root, 'modified'); installSkill({ destination: modified }); fs.appendFileSync(path.join(modified, 'SKILL.md'), '\nLocal changes');
  assert.throws(() => installSkill({ destination: modified, uninstall: true }), /modified/); assert.ok(fs.existsSync(modified));
  const expanded = path.join(root, 'expanded'); installSkill({ destination: expanded }); fs.mkdirSync(path.join(expanded, 'user-data'));
  assert.throws(() => installSkill({ destination: expanded, uninstall: true }), /extra files/); assert.ok(fs.existsSync(expanded));
});
