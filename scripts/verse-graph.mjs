import fs from 'node:fs';
import path from 'node:path';
import { parseVerse, hash } from './verse-parser.mjs';

export const VERSION = '1.0.0';
const posix = p => p.replaceAll('\\', '/');
const normalized = p => posix(path.resolve(p));
const ignored = new Set(['node_modules', 'versify-out', 'graphify-out', '__ExternalActors__', '__ExternalObjects__', 'Saved', 'Intermediate', 'Binaries']);
const callable = n => ['function', 'method', 'extension', 'class', 'struct', 'interface'].includes(n.kind);
const container = n => ['class', 'struct', 'interface', 'module', 'file'].includes(n.kind);
export function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
export function writeJSON(file, value) {
  if (!file.toLowerCase().endsWith('.json')) throw new Error('Graph output must end in .json');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Index is locked: ${lock}. If an earlier process crashed, verify that its PID is no longer running before removing the lock.`); throw error; }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}
export function walk(root) {
  const out = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !ignored.has(entry.name)) visit(file); }
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.verse')) out.push(normalized(file));
    }
  }
  if (fs.statSync(root).isFile()) { if (!root.toLowerCase().endsWith('.verse')) throw new Error(`Expected a .verse file: ${root}`); out.push(normalized(root)); }
  else visit(root);
  return out;
}
export function configuration(root, options = {}) {
  root = normalized(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('Project root must be a directory');
  const packages = [{ root, versePath: options.packagePath || '', external: false }];
  const vproject = options.vproject ? normalized(options.vproject) : null;
  if (vproject) {
    const manifest = readJSON(vproject);
    if (!Array.isArray(manifest.packages)) throw new Error('Unsupported .vproject: expected packages array');
    for (const item of manifest.packages) {
      const d = item.desc;
      if (!d?.dirPath) continue;
      const dir = normalized(path.resolve(path.dirname(vproject), d.dirPath));
      if (!fs.existsSync(dir)) throw new Error(`Manifest package is missing: ${dir}`);
      const p = { root: dir, versePath: d.settings?.versePath || '', external: !!item.readOnly || d.settings?.role === 'External' };
      if (dir.toLowerCase() === root.toLowerCase()) Object.assign(packages[0], p, { external: false });
      else packages.push(p);
    }
  }
  for (const digest of options.digests || []) {
    const dir = normalized(digest);
    if (!fs.existsSync(dir)) throw new Error(`Digest root is missing: ${dir}`);
    if (!packages.some(p => p.root.toLowerCase() === dir.toLowerCase())) packages.push({ root: dir, versePath: '', external: true });
  }
  return { root, packages, vproject, manifestHash: vproject ? hash(fs.readFileSync(vproject)) : null, digests: (options.digests || []).map(normalized), packagePath: options.packagePath || '' };
}
function inventory(config) {
  const result = new Map();
  for (const pkg of config.packages) {
    if (!fs.existsSync(pkg.root)) throw new Error(`Indexed root no longer exists: ${pkg.root}. Rebuild with current paths.`);
    const dir = fs.statSync(pkg.root).isDirectory() ? pkg.root : path.dirname(pkg.root);
    for (const full of walk(pkg.root)) {
      if (result.has(full.toLowerCase())) continue;
      const rel = posix(path.relative(config.root, full));
      const sourceFile = rel.startsWith('../') ? full : rel;
      const folder = posix(path.relative(dir, path.dirname(full)));
      let modulePath = [pkg.versePath, folder].filter(Boolean).join('/');
      // Standalone digest roots expose package paths in their generated header comments.
      if (!pkg.versePath && pkg.external) {
        const text = fs.readFileSync(full, 'utf8');
        const firstPath = text.match(/^\s*# Verse path:\s*(\/[^\r\n]+)/m)?.[1];
        const firstModule = text.match(/^(?:\([^\n]+:\))?([A-Za-z_]\w*)(?:<[^\n>]*>)*\s*:=\s*module/m)?.[1];
        if (firstPath) modulePath = firstModule && firstPath.endsWith('/' + firstModule) ? firstPath.slice(0, firstPath.lastIndexOf('/')) : firstPath;
      }
      result.set(full.toLowerCase(), { full, sourceFile, modulePath, packagePath: pkg.versePath, external: pkg.external });
    }
  }
  return [...result.values()].sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
}
export function buildIndex(root, options = {}) {
  const config = configuration(root, options);
  return refresh({ schemaVersion: 1, version: VERSION, config, files: [], nodes: [], edges: [] }, null, true);
}
export function refresh(old, selected = null, full = false) {
  if (old.schemaVersion !== 1) throw new Error('Unsupported graph schema; rebuild the index');
  if (old.version !== VERSION) full = true;
  const config = old.config.vproject ? configuration(old.config.root, old.config) : old.config;
  if (config.manifestHash !== old.config.manifestHash) full = true;
  const current = inventory(config), previous = new Map(old.files.map(f => [f.full.toLowerCase(), f]));
  const targets = !full && selected ? new Set(selected.map(p => normalized(path.resolve(old.config.root, p)).toLowerCase())) : null;
  if (targets) for (const file of targets) if (!previous.has(file) && !current.some(f => f.full.toLowerCase() === file)) throw new Error(`File is outside the configured roots, excluded, or not .verse: ${file}`);
  let extracted = 0, reused = 0, removed = 0;
  const files = [];
  for (const info of current) {
    const prior = previous.get(info.full.toLowerCase());
    const bytes = fs.readFileSync(info.full), digest = hash(bytes);
    if (!full && prior && (prior.hash === digest || targets && !targets.has(info.full.toLowerCase()))) { files.push(prior); reused++; continue; }
    if (targets && !targets.has(info.full.toLowerCase()) && !prior) continue;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    files.push({ ...info, hash: digest, result: parseVerse(text, info.sourceFile, info) }); extracted++;
  }
  for (const prior of old.files) if (!current.some(f => f.full.toLowerCase() === prior.full.toLowerCase())) {
    if (targets && !targets.has(prior.full.toLowerCase())) files.push(prior); else removed++;
  }
  const graph = resolveGraph(files, config);
  const labels = new Map((old.nodes || []).filter(n => n.semanticLabels).map(n => [n.id, n.semanticLabels]));
  for (const node of graph.nodes) if (labels.has(node.id)) node.semanticLabels = labels.get(node.id);
  graph.metadata.refresh = { extracted, reused, removed };
  return graph;
}

export function resolveGraph(files, config = {}) {
  const nodes = files.flatMap(f => f.result.nodes).map(n => ({ ...n }));
  const references = files.flatMap(f => f.result.references);
  const imports = files.flatMap(f => f.result.imports);
  const bindings = files.flatMap(f => f.result.bindings);
  const diagnostics = files.flatMap(f => f.result.diagnostics);
  const byId = new Map(nodes.map(n => [n.id, n])), byName = new Map(), children = new Map(), byOwnerBindings = new Map(), importsByOwner = new Map();
  for (const n of nodes) {
    if (!byName.has(n.label)) byName.set(n.label, []); byName.get(n.label).push(n);
    if (n.parent) { if (!children.has(n.parent)) children.set(n.parent, []); children.get(n.parent).push(n); }
  }
  for (const b of bindings) { if (!byOwnerBindings.has(b.owner)) byOwnerBindings.set(b.owner, []); byOwnerBindings.get(b.owner).push(b); }
  for (const imp of imports) { if (!importsByOwner.has(imp.source)) importsByOwner.set(imp.source, []); importsByOwner.get(imp.source).push(imp); }
  const edges = [], unresolved = [], seenEdges = new Set();
  function edge(source, target, relation, confidence, extra = {}) {
    const e = { source, target, relation, confidence, ...extra };
    const key = JSON.stringify(e); if (!seenEdges.has(key)) { seenEdges.add(key); edges.push(e); }
  }
  function ancestors(node) { const out = []; while (node) { out.push(node); node = byId.get(node.parent); } return out; }
  function visibleImports(context) { return ancestors(context).flatMap(n => importsByOwner.get(n.id) || []).map(i => i.path.startsWith('/') ? i.path : `${i.modulePath}/${i.path}`.replace(/\/+/g, '/')); }
  function lookup(name, context, kinds = null) {
    // Explicit (/domain/Module:)Name and Module.Name qualifiers are retained.
    const explicit = name.match(/^\(([^)]+):\)(.+)$/);
    const clean = explicit ? explicit[2] : name;
    const pieces = clean.split('.'), label = pieces.at(-1);
    let candidates = (byName.get(label) || []).filter(n => n.kind !== 'file' && (!kinds || kinds(n)));
    if (explicit) return candidates.filter(n => n.modulePath === explicit[1] || `${n.modulePath}/${byId.get(n.parent)?.label}` === explicit[1]);
    if (pieces.length > 1) candidates = candidates.filter(n => n.qualifiedName?.endsWith(clean) || n.modulePath?.endsWith('/' + pieces.slice(0, -1).join('/')));
    for (const scope of ancestors(context)) {
      const local = candidates.filter(n => n.parent === scope.id);
      if (local.length) return local;
    }
    const sameModule = candidates.filter(n => n.modulePath === context.modulePath && ['module', 'file'].includes(byId.get(n.parent)?.kind));
    if (sameModule.length) return sameModule;
    const paths = visibleImports(context);
    return candidates.filter(n => ['module', 'file'].includes(byId.get(n.parent)?.kind) && (paths.includes(n.modulePath) || n.modulePath === '/Verse.org/Verse'));
  }
  function typeName(text) {
    if (!text) return '';
    let type = text.replace(/^\?/, '');
    if (type.startsWith('[]') || type.startsWith('[')) return type;
    const explicit = type.match(/^\([^)]*:\)[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/);
    if (explicit) return explicit[0];
    return type.match(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/)?.[0] || '';
  }
  const baseCache = new Map();
  function bases(n) {
    if (!baseCache.has(n.id)) baseCache.set(n.id, (n.bases || []).flatMap(b => lookup(typeName(b), n, container)));
    return baseCache.get(n.id);
  }
  function members(types, name, visited = new Set()) {
    const result = [];
    for (const type of types) {
      if (visited.has(type.id)) continue; visited.add(type.id);
      const own = (children.get(type.id) || []).filter(n => n.label === name);
      if (own.length) result.push(...own); else result.push(...members(bases(type), name, visited));
    }
    return result;
  }
  function classOf(n) { return ancestors(n).find(p => ['class', 'interface', 'struct'].includes(p.kind)); }
  function variable(name, context, offset) {
    const locals = (byOwnerBindings.get(context.id) || []).filter(b => b.name === name && b.start <= offset && offset < b.end);
    if (locals.length) return locals.sort((a, b) => b.start - a.start)[0];
    const parameter = [...(context.parameters || []), context.receiver].filter(Boolean).find(p => p.name === name);
    if (parameter) return parameter;
    const cls = classOf(context);
    const field = cls ? members([cls], name).filter(n => n.kind === 'field') : [];
    if (field.length === 1) return field[0];
    return lookup(name, context, n => ['variable', 'constant', 'field'].includes(n.kind))[0];
  }
  function splitChain(expr) {
    const result = []; let depth = 0, s = 0;
    for (let i = 0; i < expr.length; i++) {
      if ('([{'.includes(expr[i])) depth++;
      else if (')]}'.includes(expr[i])) depth--;
      else if (expr[i] === '.' && !depth) { result.push(expr.slice(s, i)); s = i + 1; }
    }
    result.push(expr.slice(s)); return result;
  }
  function receiverTypes(expr, context, offset, depth = 0) {
    if (!expr || depth > 8) return [];
    const chain = splitChain(expr); let types = [];
    for (let j = 0; j < chain.length; j++) {
      const segment = chain[j], name = segment.match(/^[A-Za-z_]\w*/)?.[0]; if (!name) return [];
      const invoked = /[([{]/.test(segment), indexed = segment.includes('[');
      if (j === 0) {
        if (name === 'Self') { const cls = classOf(context); types = cls ? [cls] : []; continue; }
        const local = variable(name, context, offset);
        if (local) {
          let type = local.type;
          if (local.iteration && local.iterable) {
            const iterable = variable(local.iterable, context, Math.max(0, local.start - 1));
            type = iterable?.type;
            if (!type) {
              const factory = local.iterable.match(/^([A-Za-z_]\w*)\(/)?.[1];
              const defs = factory ? lookup(factory, context, callable) : [];
              if (defs.length === 1) type = defs[0].returnType;
            }
          }
          if (local.iteration || indexed) type = type?.startsWith('[]') ? type.slice(2) : type?.replace(/^\[[^\]]*\]/, '');
          if (type) types = lookup(typeName(type), context, container);
          else if (local.init && local.init.text !== expr) types = receiverTypes(local.init.text, context, offset, depth + 1);
          else types = [];
        } else {
          let matches = lookup(name, context, invoked ? callable : container);
          if (!matches.length && invoked && classOf(context)) matches = members([classOf(context)], name).filter(callable);
          types = matches.flatMap(n => container(n) ? [n] : lookup(typeName(n.returnType), n, container));
        }
      } else {
        types = members(types, name).flatMap(n => container(n) ? [n] : lookup(typeName(invoked ? n.returnType : n.type), n, container));
      }
    }
    return [...new Map(types.map(t => [t.id, t])).values()];
  }
  function select(candidates, ref) {
    if (ref.arity === undefined || ref.relation !== 'calls') return candidates;
    return candidates.filter(n => {
      if (['class', 'struct', 'interface'].includes(n.kind)) return true;
      const ps = n.parameters || [], required = ps.filter(p => !p.optional).length;
      return ref.arity >= required && ref.arity <= ps.length;
    });
  }
  for (const n of nodes) if (n.parent) {
    edge(n.parent, n.id, 'contains', 'EXTRACTED');
    if (n.kind === 'method') edge(n.parent, n.id, 'method', 'EXTRACTED');
  }
  for (const imp of imports) {
    const context = byId.get(imp.source), modulePath = imp.path.startsWith('/') ? imp.path : `${imp.modulePath}/${imp.path}`.replace(/\/+/g, '/');
    const id = `module::${modulePath}`;
    if (!byId.has(id)) {
      const node = { id, label: imp.path, kind: 'module_reference', modulePath, external: true };
      nodes.push(node); byId.set(id, node);
      for (const n of nodes.filter(n => n.kind === 'module' && n.modulePath === modulePath)) edge(id, n.id, 'resolves_to', 'INFERRED');
      for (const n of nodes.filter(n => n.kind === 'file' && n.modulePath === modulePath)) edge(id, n.id, 'resolves_to', 'INFERRED');
    }
    edge(context.id, id, 'imports', 'EXTRACTED', { line: imp.line });
  }
  for (const ref of references) {
    const context = byId.get(ref.source);
    let candidates = [];
    if (ref.relation === 'inherits') candidates = lookup(typeName(ref.name), context, container);
    else if (ref.receiver) {
      const types = receiverTypes(ref.receiver, context, ref.offset);
      candidates = members(types, ref.name).filter(callable);
      if (!candidates.length) {
        const extended = lookup(ref.name, context, n => n.kind === 'extension');
        candidates = extended.filter(n => types.some(t => t.label === typeName(n.receiver?.type)));
      }
    } else {
      const local = variable(ref.name, context, ref.offset);
      // Brackets can be array/map access. Locals and parameters can also shadow functions.
      if (local && ref.style === '[' && /^[?]?\[/.test(local.type || '')) continue;
      if (local) {
        unresolved.push({ ...ref, status: 'dynamic', candidates: [], reason: 'Local value shadows this name; it may be an index or indirect call' }); continue;
      }
      const cls = classOf(context);
      if (cls) candidates = members([cls], ref.name).filter(callable);
      if (!candidates.length) candidates = lookup(ref.name, context, callable);
    }
    candidates = [...new Map(select(candidates, ref).map(n => [n.id, n])).values()];
    if (candidates.length === 1) {
      const target = candidates[0];
      if (ref.relation === 'calls' && ref.style === '[' && ['class', 'interface'].includes(target.kind)) edge(ref.source, target.id, 'casts', 'INFERRED', { line: ref.line });
      else edge(ref.source, target.id, ref.relation, 'INFERRED', { line: ref.line, ...(ref.event ? { event: ref.event } : {}) });
    } else unresolved.push({ ...ref, status: candidates.length ? 'ambiguous' : 'unresolved', candidates: candidates.map(n => n.id) });
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { schemaVersion: 1, version: VERSION, config, nodes, edges, unresolved, diagnostics, files, metadata: { files: files.length, nodes: nodes.length, symbols: nodes.filter(n => !['file', 'module_reference'].includes(n.kind)).length, edges: edges.length, unresolved: unresolved.length, diagnostics: diagnostics.length, parser: 'Verse structural parser (not Epic compiler)', generatedAt: new Date().toISOString() } };
}

export function findSymbol(graph, query, { exact = false, kind, file, external = true } = {}) {
  const lower = query.toLowerCase();
  return graph.nodes.filter(n => (external || !n.external) && (!kind || n.kind === kind) && (!file || n.sourceFile?.includes(posix(file))) && (exact ? [n.id, n.label, n.qualifiedName].includes(query) : [n.id, n.label, n.qualifiedName, ...(n.semanticLabels || [])].some(s => s?.toLowerCase().includes(lower))));
}
export function oneSymbol(graph, name) {
  const exactId = graph.nodes.find(n => n.id === name); if (exactId) return exactId;
  const matches = findSymbol(graph, name, { exact: true });
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous symbol ${name}; use an ID from query:\n${matches.slice(0, 12).map(n => n.id).join('\n')}` : `Symbol not found: ${name}`);
  return matches[0];
}
export function neighbors(graph, name, direction, relations = ['calls']) {
  const symbol = oneSymbol(graph, name), ids = new Map(graph.nodes.map(n => [n.id, n]));
  return graph.edges.filter(e => relations.includes(e.relation) && e[direction === 'in' ? 'target' : 'source'] === symbol.id).map(e => ({ node: ids.get(e[direction === 'in' ? 'source' : 'target']), edge: e }));
}
export const callersOf = (g, n) => neighbors(g, n, 'in');
export const calleesOf = (g, n) => neighbors(g, n, 'out');
export const fileSymbols = (g, file) => g.nodes.filter(n => n.sourceFile === posix(file) && n.kind !== 'file');
export function shortestPath(graph, from, to, { relations = null, directed = false } = {}) {
  const start = oneSymbol(graph, from).id, target = oneSymbol(graph, to).id;
  const adj = new Map();
  for (const e of graph.edges) {
    if (relations && !relations.includes(e.relation)) continue;
    if (!adj.has(e.source)) adj.set(e.source, []); adj.get(e.source).push([e.target, e]);
    if (!directed) { if (!adj.has(e.target)) adj.set(e.target, []); adj.get(e.target).push([e.source, e]); }
  }
  const queue = [start], visited = new Map([[start, null]]);
  for (let i = 0; i < queue.length; i++) {
    const here = queue[i]; if (here === target) break;
    for (const [next, edge] of adj.get(here) || []) if (!visited.has(next)) { visited.set(next, { from: here, edge }); queue.push(next); }
  }
  if (!visited.has(target)) return null;
  const result = { nodes: [target], edges: [] }; let n = target;
  while (visited.get(n)) { const entry = visited.get(n); result.edges.unshift(entry.edge); result.nodes.unshift(entry.from); n = entry.from; }
  return result;
}
export function graphDiff(before, after) {
  const a = new Map(before.nodes.map(n => [n.id, n])), b = new Map(after.nodes.map(n => [n.id, n]));
  const key = e => JSON.stringify([e.source, e.target, e.relation]);
  const ae = new Map(before.edges.map(e => [key(e), e])), be = new Map(after.edges.map(e => [key(e), e]));
  return { newNodes: after.nodes.filter(n => !a.has(n.id)), removedNodes: before.nodes.filter(n => !b.has(n.id)), changedNodes: after.nodes.filter(n => a.has(n.id) && JSON.stringify(n) !== JSON.stringify(a.get(n.id))), newEdges: [...be].filter(([k]) => !ae.has(k)).map(([, e]) => e), removedEdges: [...ae].filter(([k]) => !be.has(k)).map(([, e]) => e) };
}
export function labelNodes(graph, labels) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new Error('Labels must be an object mapping exact symbol IDs to string arrays');
  const ids = new Map(graph.nodes.map(n => [n.id, n]));
  for (const [id, values] of Object.entries(labels)) if (!ids.has(id) || !Array.isArray(values) || values.some(v => typeof v !== 'string')) throw new Error(`Invalid labels or unknown symbol ID: ${id}`);
  for (const [id, values] of Object.entries(labels)) ids.get(id).semanticLabels = [...new Set(values)];
  return graph;
}
export function status(graph) {
  const config = graph.config.vproject ? configuration(graph.config.root, graph.config) : graph.config;
  const manifestChanged = config.manifestHash !== graph.config.manifestHash;
  const current = inventory(config), indexed = new Map(graph.files.map(f => [f.full.toLowerCase(), f]));
  const added = [], changed = [];
  for (const f of current) {
    const old = indexed.get(f.full.toLowerCase());
    if (!old) added.push(f.sourceFile); else if (hash(fs.readFileSync(f.full)) !== old.hash) changed.push(f.sourceFile);
  }
  const present = new Set(current.map(f => f.full.toLowerCase()));
  const removed = graph.files.filter(f => !present.has(f.full.toLowerCase())).map(f => f.sourceFile);
  return { fresh: !manifestChanged && graph.version === VERSION && !added.length && !changed.length && !removed.length, manifestChanged, added, changed, removed, ...graph.metadata };
}

export function exportContext(graph, { projectOnly = false } = {}) {
  const included = graph.nodes.filter(n => !projectOnly || !n.external);
  const idMap = new Map(included.map((n, i) => [n.id, `symbol-${i + 1}`]));
  const externalFiles = new Map();
  const displayFile = file => {
    if (!file) return undefined;
    if (!path.isAbsolute(file) && !/^[A-Za-z]:\//.test(file)) return file;
    if (!externalFiles.has(file)) externalFiles.set(file, `external-${externalFiles.size + 1}/${file.split('/').at(-1)}`);
    return externalFiles.get(file);
  };
  const nodes = included.map(n => {
    const copy = { ...n, id: idMap.get(n.id), sourceFile: displayFile(n.sourceFile) };
    if (n.parent) copy.parent = idMap.get(n.parent);
    if (n.sourceLocation) copy.sourceLocation = `${copy.sourceFile}:${n.line}`;
    return copy;
  });
  return { format: 'versify-context-1', version: VERSION, note: 'Static navigation snapshot, not compiler validation. Source text, symbols and package paths may contain private information; review before sharing. Physical root paths and cached expressions are omitted.', nodes, edges: graph.edges.filter(e => idMap.has(e.source) && idMap.has(e.target)).map(e => ({ ...e, source: idMap.get(e.source), target: idMap.get(e.target) })), diagnostics: graph.diagnostics.filter(d => !projectOnly || graph.files.some(f => !f.external && f.sourceFile === d.sourceFile)).map(d => ({ ...d, sourceFile: displayFile(d.sourceFile) })), unresolvedCount: graph.unresolved.filter(r => idMap.has(r.source)).length };
}
