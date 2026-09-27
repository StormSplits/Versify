import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lex, parseVerse } from './verse-parser.mjs';
import { buildIndex, refresh, resolveGraph, findSymbol, oneSymbol, callersOf, calleesOf, shortestPath, graphDiff, labelNodes, writeJSON, readJSON, status, fileSymbols, acquireLock } from './verse-graph.mjs';

const graph = (sources, options = {}) => resolveGraph(Object.entries(sources).map(([name, code]) => ({ sourceFile: name, result: parseVerse(code, name, options) })));
const symbols = result => result.nodes.filter(n => n.kind !== 'file');
const related = (g, from, to, relation = 'calls') => g.edges.some(e => e.source === oneSymbol(g, from).id && e.target === oneSymbol(g, to).id && e.relation === relation);
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'versify-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, code) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, code); return target; };
  return { root, put };
}

test('comments, nested block comments, indented comments, and string text are opaque', () => {
  const r = parseVerse(`# Fake() : void = {}
<# outer <# inner #> Fake2():void={} #>
<#>
    Fake3():void={}
Real():void = Print("Fake4() # <# text #>")
`, 'comments.verse');
  assert.deepEqual(symbols(r).map(n => n.label), ['Real']);
  assert.deepEqual(r.references.filter(r => r.relation === 'calls').map(r => r.name), ['Print']);
  assert.equal(r.diagnostics.length, 0);
});
test('blank lines and comments do not close class or method bodies', () => {
  const r = parseVerse(`demo := class:
    @editable
    Count:int = 1

    # Comment separating members
    Go():void =
        A()

        B()

    Stop():void = {}
`, 'demo.verse');
  assert.deepEqual(symbols(r).map(n => n.qualifiedName), ['demo', 'demo.Count', 'demo.Go', 'demo.Stop']);
  assert.equal(r.references.find(r => r.name === 'B').source, r.nodes.find(n => n.label === 'Go').id);
});
test('braced modules/classes and semicolon methods retain nesting', () => {
  const r = parseVerse('M := module { C := class { F():void = { G() }; G():void = {} } }', 'braced.verse');
  assert.deepEqual(symbols(r).map(n => n.qualifiedName), ['M', 'M.C', 'M.C.F', 'M.C.G']);
  assert.equal(r.diagnostics.length, 0);
});
test('multiline parameters, specifiers, defaults, and optional parameters', () => {
  const r = parseVerse(`F<public>(
    X:int,
    ?Y:float = 1.0
)<transacts><decides>:int = X
`, 'params.verse');
  const f = r.nodes[1];
  assert.equal(f.kind, 'function'); assert.equal(f.parameters.length, 2);
  assert.equal(f.parameters[0].optional, false); assert.equal(f.parameters[1].optional, true);
  assert.deepEqual(f.specifiers, ['public', 'transacts', 'decides']);
});
test('declarations in digests include qualified extensions, prefix operators and enum values', () => {
  const r = parseVerse(`M<public> := module:
    e := enum:
        (/Example/M/e:)A
        B
    (V:thing).(/Example/M:)Act<public>()<transacts>:void
    (/Example/M:)prefix'-'<public>(X:int):int
`, 'digest.verse', { packagePath: '/Example', external: true });
  assert.equal(r.diagnostics.length, 0);
  assert.equal(r.nodes.find(n => n.label === 'Act').receiver.type, 'thing');
  assert.deepEqual(r.nodes.filter(n => n.kind === 'enum_member').map(n => n.label), ['A', 'B']);
  assert.equal(r.nodes.find(n => n.label === "prefix'-'").kind, 'function');
});
test('parameterized attributes attach to following field', () => {
  const r = parseVerse('C := class:\n    @editable_number(int) {MinValue := option{1}}\n    var Value<public>:int = external {}\n', 'attr.verse');
  const f = r.nodes.find(n => n.label === 'Value');
  assert.deepEqual(f.attributes, ['editable_number']); assert.equal(f.mutable, true); assert.equal(r.diagnostics.length, 0);
});
test('interpolation expressions yield calls, plain text never does', () => {
  const r = parseVerse('F():void = Print("Fake() {GetValue()} and {Other()} end")\n', 'string.verse');
  assert.deepEqual(r.references.map(r => r.name), ['Print', 'GetValue', 'Other']); assert.equal(r.diagnostics.length, 0);
});
test('nested strings inside interpolation and escaped braces are safe', () => {
  const r = parseVerse('F():void = Print("\\{Fake()} {Wrap("hello")} tail")\n', 'nested.verse');
  assert.deepEqual(r.references.map(r => r.name), ['Print', 'Wrap']); assert.equal(r.diagnostics.length, 0);
});
test('line numbers survive BOM, CRLF, nested comments and tabs', () => {
  const r = parseVerse('\uFEFFC := class:\r\n\t<# a\r\n\t<# b #> #>\r\n\tGo():void = {}\r\n', 'win.verse');
  assert.equal(r.nodes.find(n => n.label === 'Go').line, 4); assert.equal(r.nodes.find(n => n.label === 'Go').kind, 'method');
});
test('unknown declarations and malformed input are surfaced', () => {
  assert.ok(parseVerse('unsupported ???\nF(:void = {\n', 'bad.verse').diagnostics.length > 0);
  assert.ok(lex('<# unclosed').diagnostics.some(d => /Unterminated/.test(d.message)));
  assert.ok(lex('"unclosed').diagnostics.some(d => /Unterminated/.test(d.message)));
});
test('same-folder cross-file calls resolve and keep directed callers/callees', () => {
  const g = graph({ 'a.verse': 'A():void = B()\n', 'b.verse': 'B():void = {}\n' });
  assert.ok(related(g, 'A', 'B')); assert.equal(callersOf(g, 'B')[0].node.label, 'A'); assert.equal(calleesOf(g, 'A')[0].node.label, 'B');
  assert.equal(callersOf(g, 'A').length, 0);
});
test('failable calls and casts are distinct from typed array/map indexing', () => {
  const g = graph({ 'a.verse': `C := class {}
Check()<decides><transacts>:void = {}
Run(Items:[]int, Lookup:[int]int, Obj:any):void =
    if (Check[], Value := Items[0], Other := Lookup[1], Cast := C[Obj]) {}
` });
  assert.ok(related(g, 'Run', 'Check')); assert.ok(related(g, 'Run', 'C', 'casts'));
  assert.ok(!g.unresolved.some(r => ['Items', 'Lookup'].includes(r.name)));
});
test('typed receivers and inherited methods resolve without global-name guessing', () => {
  const g = graph({ 'a.verse': `Base := class:
    Act():void = {}
Child := class(Base) {}
Other := class:
    Act():void = {}
Run(X:Child):void = X.Act()
` });
  assert.ok(related(g, 'Child', 'Base', 'inherits')); assert.ok(related(g, 'Run', 'Base.Act')); assert.ok(!related(g, 'Run', 'Other.Act'));
});
test('unknown receivers do not resolve to a unique unrelated method', () => {
  const g = graph({ 'a.verse': 'C := class { Act():void = {} }\nRun():void = Unknown.Act()\n' });
  assert.ok(!related(g, 'Run', 'C.Act')); assert.ok(g.unresolved.some(r => r.name === 'Act'));
});
test('extension method resolves from receiver type', () => {
  const g = graph({ 'a.verse': 'C := class {}\n(X:C).Act():void = {}\nRun(X:C):void = X.Act()\n' });
  assert.ok(related(g, 'Run', 'Act'));
});
test('same-name overloads stay separate and uncertain calls stay ambiguous', () => {
  const g = graph({ 'a.verse': 'F(X:int):void = {}\nF(X:string):void = {}\nRun(X:any):void = F(X)\n' });
  assert.equal(findSymbol(g, 'F', { exact: true }).length, 2);
  assert.throws(() => oneSymbol(g, 'F'), /Ambiguous/);
  assert.equal(g.unresolved.find(r => r.name === 'F').status, 'ambiguous');
});
test('arity distinguishes overloads and named optional arguments are accepted', () => {
  const g = graph({ 'a.verse': 'F():void = {}\nF(X:int, ?Y:int = 0):void = {}\nRun():void = F(1, ?Y := 2)\n' });
  const target = g.nodes.find(n => n.label === 'F' && n.parameters.length === 2);
  assert.ok(g.edges.some(e => e.source === oneSymbol(g, 'Run').id && e.target === target.id && e.relation === 'calls'));
});
test('event subscription records callback separately from direct calls', () => {
  const g = graph({ 'a.verse': 'Handler(X:int):void = {}\nRun():void = Device.Event.Subscribe(Handler)\n' });
  assert.ok(related(g, 'Run', 'Handler', 'subscribes')); assert.ok(!related(g, 'Run', 'Handler'));
});
test('local constructed receivers and handler objects resolve', () => {
  const g = graph({ 'a.verse': 'C := class { Act():void = {} }\nRun():void =\n    X := C{}\n    X.Act()\n    Event.Subscribe(X.Act)\n' });
  assert.ok(related(g, 'Run', 'C', 'constructs')); assert.ok(related(g, 'Run', 'C.Act')); assert.ok(related(g, 'Run', 'C.Act', 'subscribes'));
});
test('type annotations do not create runtime call edges', () => {
  const g = graph({ 'a.verse': 'box(t:type) := class {}\nRun():void =\n    var Boxes:[]box(int) = array{}\n' });
  assert.ok(!related(g, 'Run', 'box')); assert.ok(!g.unresolved.some(r => r.name === 'box'));
});
test('loop variables inherit element types from typed arrays', () => {
  const g = graph({ 'a.verse': 'C := class { Act():void = {} }\nRun(Items:[]C):void =\n    for (Item : Items):\n        Item.Act()\n' });
  assert.ok(related(g, 'Run', 'C.Act'));
});
test('sibling block locals do not overwrite an outer receiver', () => {
  const g = graph({ 'a.verse': 'C := class { Act():void = {} }\nD := class { Act():void = {} }\nRun():void =\n    Outer := C{}\n    if (true?):\n        Outer := D{}\n        Outer.Act()\n    Outer.Act()\n' });
  assert.ok(related(g, 'Run', 'C.Act')); assert.ok(related(g, 'Run', 'D.Act'));
});
test('array fields use indexed element type for chained method calls', () => {
  const g = graph({ 'a.verse': 'C := class { Act():void = {} }\nRun(Items:[]C):void = Items[0].Act()\n' });
  assert.ok(related(g, 'Run', 'C.Act'));
});
test('qualified runtime calls select the specified module', () => {
  const g = graph({ 'a.verse': 'M := module { F<public>():void = {} }\nF():void = {}\nRun():void = (/Example/M:)F()\n' }, { packagePath: '/Example' });
  assert.ok(related(g, 'Run', 'M.F')); assert.ok(!related(g, 'Run', g.nodes.find(n => n.qualifiedName === 'F').id));
});
test('function-return chains resolve each invocation exactly once per site', () => {
  const g = graph({ 'a.verse': 'C := class { Act():void = {} }\nGet():C = C{}\nRun():void = Get().Act()\n' });
  assert.ok(related(g, 'Run', 'Get')); assert.ok(related(g, 'Run', 'C.Act'));
  assert.equal(g.unresolved.length, 0);
});
test('function-local shadows do not leak into sibling methods', () => {
  const g = graph({ 'a.verse': 'F():void = {}\nA(F:type{_():void}):void = F()\nB():void = F()\n' });
  assert.ok(!related(g, 'A', 'F')); assert.ok(related(g, 'B', 'F')); assert.equal(g.unresolved.find(r => r.source === oneSymbol(g, 'A').id).status, 'dynamic');
});
test('module imports control cross-module visibility', () => {
  const g = graph({ 'a.verse': 'M := module { F<public>():void = {} }\nN := module { F<public>():void = {} }\nusing {M}\nRun():void = F()\n' });
  assert.ok(related(g, 'Run', 'M.F')); assert.ok(!related(g, 'Run', 'N.F')); assert.ok(g.edges.some(e => e.relation === 'imports'));
});
test('class and parameterized type factories retain bases and type parameters', () => {
  const r = parseVerse('base(t:type) := interface {}\nbox<public>(t:type) := class<unique>(base(t)):\n    Value:t\n', 'generic.verse');
  const box = r.nodes.find(n => n.label === 'box'); assert.equal(box.kind, 'class'); assert.equal(box.parameters[0].name, 't'); assert.deepEqual(box.bases, ['base(t)']);
});
test('constructors retain constructor specifiers', () => {
  const r = parseVerse('Make<constructor>(X:int):thing = thing{Value := X}\n', 'constructor.verse');
  assert.ok(r.nodes[1].specifiers.includes('constructor')); assert.equal(r.references[0].relation, 'constructs');
});
test('stable symbol IDs survive blank lines and body edits', () => {
  const a = parseVerse('F():int = 1\n', 'stable.verse'), b = parseVerse('\n\nF():int = 2\n', 'stable.verse');
  assert.equal(a.nodes[1].id, b.nodes[1].id);
});
test('paths respect directions and relation filters', () => {
  const g = graph({ 'a.verse': 'A():void = B()\nB():void = C()\nC():void = {}\n' });
  assert.equal(shortestPath(g, 'A', 'C', { directed: true, relations: ['calls'] }).edges.length, 2);
  assert.equal(shortestPath(g, 'C', 'A', { directed: true, relations: ['calls'] }), null);
});
test('graph diff distinguishes reversed edges', () => {
  const a = graph({ 'a.verse': 'A():void = B()\nB():void = {}\n' }), b = graph({ 'a.verse': 'A():void = {}\nB():void = A()\n' });
  const d = graphDiff(a, b); assert.equal(d.newEdges.filter(e => e.relation === 'calls').length, 1); assert.equal(d.removedEdges.filter(e => e.relation === 'calls').length, 1);
});
test('labels are searchable and invalid IDs are rejected before any mutation', () => {
  const g = graph({ 'a.verse': 'F():void = {}\n' }), id = oneSymbol(g, 'F').id;
  labelNodes(g, { [id]: ['voice', 'team'] }); assert.equal(findSymbol(g, 'voice')[0].id, id);
  assert.throws(() => labelNodes(g, { [id]: ['changed'], wrong: ['bad'] }), /Invalid/); assert.deepEqual(oneSymbol(g, 'F').semanticLabels, ['voice', 'team']);
});
test('hash refresh reuses unchanged files, discovers additions and removes deleted symbols', t => {
  const { root, put } = workspace(t); const a = put('a.verse', 'A():void = B()\n'); put('b.verse', 'B():void = {}\n');
  const first = buildIndex(root); const same = refresh(first); assert.deepEqual(same.metadata.refresh, { extracted: 0, reused: 2, removed: 0 });
  put('b.verse', 'B():void = C()\n'); put('c.verse', 'C():void = {}\n'); fs.unlinkSync(a);
  assert.equal(status(first).fresh, false);
  const next = refresh(first); assert.deepEqual(next.metadata.refresh, { extracted: 2, reused: 0, removed: 1 }); assert.equal(findSymbol(next, 'A', { exact: true }).length, 0); assert.ok(related(next, 'B', 'C'));
});
test('targeted update re-resolves unchanged callers and preserves labels', t => {
  const { root, put } = workspace(t); put('a.verse', 'A():void = B()\n'); put('b.verse', 'B():void = {}\n');
  const first = buildIndex(root), id = oneSymbol(first, 'A').id; labelNodes(first, { [id]: ['entry'] });
  put('b.verse', 'C():void = {}\n'); const next = refresh(first, ['b.verse']);
  assert.equal(next.metadata.refresh.reused, 1); assert.deepEqual(oneSymbol(next, 'A').semanticLabels, ['entry']); assert.ok(next.unresolved.some(r => r.name === 'B')); assert.ok(!next.edges.some(e => e.target.includes('::B#')));
});
test('renames and explicit deleted-file updates remove stale nodes', t => {
  const { root, put } = workspace(t); const old = put('old.verse', 'A():void = {}\n'); const first = buildIndex(root); fs.renameSync(old, path.join(root, 'new.verse'));
  const next = refresh(first, ['old.verse', 'new.verse']); assert.equal(next.files.length, 1); assert.equal(fileSymbols(next, 'new.verse')[0].label, 'A');
});
test('manifest resolves package paths and reads API digests without modifying them', t => {
  const { root, put } = workspace(t);
  put('project/main.verse', 'using {/Epic/API}\nRun():void = NativeCall()\n');
  const digest = put('digest/API.digest.verse', 'API<public> := module:\n    NativeCall<native><public>():void\n'); const original = fs.readFileSync(digest);
  const manifest = put('p.vproject', JSON.stringify({ packages: [{ desc: { dirPath: 'project', settings: { versePath: '/Me' } } }, { desc: { dirPath: 'digest', settings: { versePath: '/Epic', role: 'External' } }, readOnly: true }] }));
  const g = buildIndex(path.join(root, 'project'), { vproject: manifest }); assert.ok(related(g, 'Run', 'API.NativeCall')); assert.equal(oneSymbol(g, 'API.NativeCall').external, true); assert.deepEqual(fs.readFileSync(digest), original);
});
test('ignored folders and non-Verse files do not enter the graph', t => {
  const { root, put } = workspace(t); put('a.verse', 'A():void = {}'); put('.hidden/b.verse', 'B():void = {}'); put('node_modules/c.verse', 'C():void = {}'); put('image.uasset', 'D():void = {}');
  assert.equal(buildIndex(root).files.length, 1);
});
test('UTF-8 errors and nonexistent configured digests fail explicitly', t => {
  const { root, put } = workspace(t); put('bad.verse', Buffer.from([0xff])); assert.throws(() => buildIndex(root), /encoded data/); assert.throws(() => buildIndex(root, { digests: [path.join(root, 'absent')] }), /missing/);
});
test('JSON writes round-trip without temporary file residue', t => {
  const { root } = workspace(t), target = path.join(root, 'out', 'graph.json'); writeJSON(target, { test: 1 }); writeJSON(target, { test: 2 }); assert.deepEqual(readJSON(target), { test: 2 }); assert.deepEqual(fs.readdirSync(path.dirname(target)), ['graph.json']);
});
test('write locks reject concurrent writers and release cleanly', t => {
  const { root } = workspace(t), file = path.join(root, 'out', 'graph.json');
  const release = acquireLock(file); assert.throws(() => acquireLock(file), /locked/); release(); const next = acquireLock(file); next(); assert.equal(fs.existsSync(file + '.lock'), false);
});
test('output extension guard protects Verse files', t => {
  const { put } = workspace(t), source = put('a.verse', 'A():void = {}'); assert.throws(() => writeJSON(source, {}), /\.json/); assert.equal(fs.readFileSync(source, 'utf8'), 'A():void = {}');
});
test('manifest changes invalidate package mappings even when source bytes are unchanged', t => {
  const { root, put } = workspace(t); put('project/a.verse', 'M := module { F():void = {} }');
  const manifestData = prefix => ({ packages: [{ desc: { dirPath: 'project', settings: { versePath: prefix } } }] });
  const manifest = put('project.vproject', JSON.stringify(manifestData('/Old')));
  const initial = buildIndex(path.join(root, 'project'), { vproject: manifest });
  put('project.vproject', JSON.stringify(manifestData('/New'))); assert.equal(status(initial).manifestChanged, true);
  const next = refresh(initial); assert.equal(oneSymbol(next, 'M').modulePath, '/New/M'); assert.equal(status(next).fresh, true);
});
test('standalone digest headers preserve asset root paths', t => {
  const { root, put } = workspace(t); put('project/a.verse', 'Run():void = {}');
  const digest = put('digest/assets.digest.verse', '# Verse path: /Me/Game\n(/Me/Game:)Widgets := module:\n    hud := class {}\n');
  const g = buildIndex(path.join(root, 'project'), { digests: [digest] }); assert.equal(oneSymbol(g, 'Widgets').modulePath, '/Me/Game/Widgets');
});
test('CLI builds, queries and reports controlled errors', t => {
  const { root, put } = workspace(t); put('a.verse', 'A():void = {}');
  const cli = fileURLToPath(new URL('./versify.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  const built = run(['build', '.', '--json', '--strict']); assert.equal(built.status, 0, built.stderr); assert.equal(JSON.parse(built.stdout).files, 1);
  const queried = run(['query', 'versify-out/graph.json', 'A', '--exact', '--json']); assert.equal(queried.status, 0, queried.stderr); assert.equal(JSON.parse(queried.stdout)[0].label, 'A');
  const bad = run(['query', 'missing.json', 'A']); assert.equal(bad.status, 1); assert.ok(bad.stderr.startsWith('Versify:'));
  put('bad.verse', '???'); const strict = run(['build', '.', '--strict']); assert.equal(strict.status, 1); assert.equal(readJSON(path.join(root, 'versify-out/graph.json')).files.length, 1);
});
