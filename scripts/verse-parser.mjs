// Verse structural parser. Original implementation; no compiler or package dependencies.
import { createHash } from 'node:crypto';
export const hash = text => createHash('sha256').update(text).digest('hex');
const composites = new Set(['class', 'interface', 'struct', 'enum', 'module']);
const controls = new Set(['if', 'else', 'for', 'loop', 'case', 'then', 'block', 'race', 'rush', 'sync', 'spawn', 'branch', 'defer', 'return', 'set', 'not', 'and', 'or', 'yield', 'where']);
const constructors = new Set(['array', 'map', 'option', 'tuple', 'type', 'external']);

export function lex(text) {
  const tokens = [], diagnostics = [];
  let p = 0, line = 1, column = 1;
  const advance = () => { const c = text[p++]; if (c === '\n') { line++; column = 1; } else column += c === '\t' ? 4 : 1; return c; };
  const emit = (kind, start, ln, col) => tokens.push({ kind, value: text.slice(start, p), start, end: p, line: ln, column: col });
  const warn = (message, ln = line) => diagnostics.push({ severity: 'warning', line: ln, message });
  function quoted(quote) {
    const start = p, ln = line, col = column;
    advance();
    while (p < text.length) {
      if (text[p] === '\\') { advance(); if (p < text.length) advance(); continue; }
      if (text[p] === quote) { advance(); emit('literal', start, ln, col); return; }
      if (quote === '"' && text[p] === '{') {
        // String content is opaque; interpolation expressions remain executable tokens.
        emit('literal', start, ln, col);
        const s = p, l = line, c = column; advance(); emit('interpolationStart', s, l, c);
        scan(true);
        const tail = p, tailLine = line, tailCol = column;
        stringTail(tail, tailLine, tailCol);
        return;
      }
      advance();
    }
    emit('literal', start, ln, col); warn('Unterminated string or character literal', ln);
  }
  function stringTail(start, ln, col) {
    while (p < text.length) {
      if (text[p] === '\\') { advance(); if (p < text.length) advance(); continue; }
      if (text[p] === '"') { advance(); emit('literal', start, ln, col); return; }
      if (text[p] === '{') {
        if (p > start) emit('literal', start, ln, col);
        const s = p, l = line, c = column; advance(); emit('interpolationStart', s, l, c);
        scan(true); start = p; ln = line; col = column;
      } else advance();
    }
    warn('Unterminated interpolated string', ln);
  }
  function scan(interpolation = false) {
    let braceDepth = 0;
    while (p < text.length) {
      const start = p, ln = line, col = column, c = text[p];
      if (interpolation && c === '}' && braceDepth === 0) { advance(); emit('interpolationEnd', start, ln, col); return; }
      if (c === '\r' || c === ' ' || c === '\t' || c === '\uFEFF') { advance(); continue; }
      if (c === '\n') { advance(); emit('newline', start, ln, col); continue; }
      if (text.startsWith('<#>', p)) {
        while (p < text.length && text[p] !== '\n') advance();
        while (p < text.length) {
          let q = p + 1, indent = 0;
          while (text[q] === ' ' || text[q] === '\t') indent += text[q++] === '\t' ? 4 : 1;
          if (text[q] !== '\n' && text[q] !== '\r' && q < text.length && indent < col - 1 + 4) break;
          advance(); while (p < text.length && text[p] !== '\n') advance();
        }
        continue;
      }
      if (text.startsWith('<#', p)) {
        advance(); advance(); let depth = 1;
        while (p < text.length && depth) {
          if (text.startsWith('<#', p)) { advance(); advance(); depth++; }
          else if (text.startsWith('#>', p)) { advance(); advance(); depth--; }
          else { const s = p, l = line, cc = column; advance(); if (text[s] === '\n') emit('newline', s, l, cc); }
        }
        if (depth) warn('Unterminated block comment', ln);
        continue;
      }
      if (c === '#') { while (p < text.length && text[p] !== '\n') advance(); continue; }
      if (c === '"' || c === "'") { quoted(c); continue; }
      if (c === '<') {
        const spec = text.slice(p).match(/^<[A-Za-z_]\w*(?:\s*\{[^}\n]*\})?>/);
        if (spec) { for (let n = 0; n < spec[0].length; n++) advance(); emit('specifier', start, ln, col); continue; }
      }
      if (/[A-Za-z_]/.test(c)) {
        while (p < text.length && /[A-Za-z_0-9]/.test(text[p])) advance();
        if (['operator', 'prefix', 'postfix'].includes(text.slice(start, p)) && text[p] === "'") {
          advance(); while (p < text.length && text[p] !== "'" && text[p] !== '\n') advance(); if (text[p] === "'") advance();
        }
        emit('id', start, ln, col); continue;
      }
      if (/[0-9]/.test(c)) {
        while (p < text.length && /[A-Za-z_0-9.]/.test(text[p])) advance();
        emit('number', start, ln, col); continue;
      }
      const pair = text.slice(p, p + 2);
      if ([':=', '=>', '->', '+=', '-=', '*=', '/=', '<=', '>=', '<>'].includes(pair)) { advance(); advance(); }
      else { advance(); if (c === '{') braceDepth++; if (c === '}') braceDepth--; }
      emit('op', start, ln, col);
    }
    if (interpolation) warn('Unterminated string interpolation');
  }
  scan();
  const stack = [], matches = new Map();
  const closing = { ')': '(', ']': '[', '}': '{' };
  tokens.forEach((t, i) => {
    if (['(', '[', '{'].includes(t.value)) stack.push(i);
    else if (closing[t.value]) {
      const last = stack.at(-1);
      if (last !== undefined && tokens[last].value === closing[t.value]) { stack.pop(); matches.set(last, i); matches.set(i, last); }
      else warn(`Unmatched ${t.value}`, t.line);
    }
  });
  for (const i of stack) warn(`Unclosed ${tokens[i].value}`, tokens[i].line);
  return { tokens, matches, diagnostics };
}

export function parseVerse(text, sourceFile, options = {}) {
  const { tokens: ts, matches, diagnostics } = lex(text);
  const nodes = [], references = [], imports = [], bindings = [];
  const fileId = `file::${sourceFile}`;
  const file = { id: fileId, label: sourceFile.split('/').at(-1), kind: 'file', sourceFile, sourceLocation: `${sourceFile}:1`, line: 1, endLine: text.split('\n').length, packagePath: options.packagePath || '', modulePath: options.modulePath || options.packagePath || '', external: !!options.external };
  nodes.push(file);
  const val = i => ts[i]?.value;
  const skipNL = i => { while (ts[i]?.kind === 'newline') i++; return i; };
  const joined = (a, b) => ts.slice(a, b).filter(t => t.kind !== 'newline').map(t => t.value).join('');
  const raw = (a, b) => a < b ? text.slice(ts[a].start, ts[b - 1].end).trim() : '';
  function skipSpec(i) { while (ts[i]?.kind === 'specifier') i++; return i; }
  function topFind(a, b, values) {
    for (let i = a; i < b; i++) {
      if (values.includes(val(i))) return i;
      if (matches.has(i) && matches.get(i) > i) i = matches.get(i);
    }
    return -1;
  }
  function parts(a, b, delimiter = ',') {
    const out = []; let s = a;
    for (let i = a; i < b; i++) {
      if (val(i) === delimiter) { out.push([s, i]); s = i + 1; }
      else if (matches.get(i) > i) i = matches.get(i);
    }
    if (s < b) out.push([s, b]); return out;
  }
  function params(a, b) {
    return parts(a, b).map(([s, e]) => {
      s = skipNL(s); const optional = val(s) === '?'; if (optional) s++;
      const colon = topFind(s, e, [':']), equal = topFind(s, e, ['=']);
      return { name: colon > s ? joined(s, colon) : '', type: colon >= 0 ? joined(colon + 1, equal >= 0 ? equal : e) : '', optional, line: ts[s]?.line || 1 };
    });
  }
  function statementEnd(start, limit) {
    let i = start;
    while (i < limit) {
      if (ts[i].kind === 'newline' || [';', '}'].includes(val(i))) break;
      if (matches.get(i) > i) i = matches.get(i);
      i++;
    }
    return i;
  }
  function indentEnd(start, from, limit) {
    const col = ts[start].column;
    let i = skipNL(from);
    while (i < limit) {
      if (ts[i].kind !== 'newline' && ts[i].column <= col && (i === 0 || ts[i - 1].kind === 'newline')) return i;
      i++;
    }
    return limit;
  }
  function bodyRange(start, marker, limit) {
    let a = marker;
    if ([':', '='].includes(val(a))) a++;
    const next = skipNL(a);
    if (val(next) === '{' && matches.has(next)) return { a: next + 1, b: matches.get(next), end: matches.get(next) + 1 };
    if (ts[a]?.kind === 'newline' && ts[next]?.column > ts[start].column) {
      const b = indentEnd(start, a, limit); return { a: next, b, end: b };
    }
    const b = statementEnd(a, limit); return { a, b, end: b };
  }
  function declaration(start, limit, parent, attributes) {
    let i = start, mutable = false, qualifier = '', receiver = null;
    if (val(i) === 'var') { mutable = true; i = skipSpec(i + 1); }
    if (val(i) === '(' && matches.has(i)) {
      const close = matches.get(i);
      if (val(close + 1) === '.') { receiver = params(i + 1, close)[0]; i = close + 2; }
      else if (val(close - 1) === ':') { qualifier = joined(i + 1, close - 1); i = close + 1; }
      else return null;
    }
    if (val(i) === '(' && matches.has(i) && val(matches.get(i) - 1) === ':') {
      qualifier = joined(i + 1, matches.get(i) - 1); i = matches.get(i) + 1;
    }
    if (ts[i]?.kind !== 'id' || controls.has(val(i)) || constructors.has(val(i))) return null;
    const nameAt = i, label = val(i); i = skipSpec(i + 1);
    let parameters = null;
    if (val(i) === '(' && matches.has(i)) { parameters = params(i + 1, matches.get(i)); i = skipSpec(matches.get(i) + 1); }
    if (![':', ':='].includes(val(i))) return null;
    let kind, type = '', returnType = '', body = null, bases = [], headerEnd, end;
    const sep = i++;
    if (val(sep) === ':=' && composites.has(val(i))) {
      kind = val(i++); i = skipSpec(i);
      if (val(i) === '(' && matches.has(i)) { bases = parts(i + 1, matches.get(i)).map(([s, e]) => joined(s, e)); i = skipSpec(matches.get(i) + 1); }
      headerEnd = i;
      if (val(i) === ':' || val(i) === '{' || val(skipNL(i)) === '{') body = bodyRange(start, val(i) === ':' ? i : skipNL(i), limit);
      end = body?.end ?? statementEnd(i, limit);
    } else if (parameters !== null) {
      kind = receiver ? 'extension' : ['class', 'interface', 'struct'].includes(parent.kind) ? 'method' : 'function';
      const stop = statementEnd(i, limit), eq = topFind(i, stop, ['=']);
      returnType = joined(i, eq >= 0 ? eq : stop);
      headerEnd = eq >= 0 ? eq : stop;
      if (eq >= 0) body = bodyRange(start, eq, limit);
      end = body?.end ?? stop;
    } else {
      kind = ['class', 'interface', 'struct'].includes(parent.kind) ? 'field' : mutable ? 'variable' : 'constant';
      const stop = statementEnd(i, limit), eq = topFind(i, stop, ['=']);
      if (val(sep) === ':') type = joined(i, eq >= 0 ? eq : stop);
      else if (['type', 'tuple', 'int', 'float', 'string', 'logic'].includes(val(i)) || val(i) === '[' || (ts[i]?.kind === 'id' && i + 1 === stop)) kind = 'type_alias';
      headerEnd = eq >= 0 ? eq : val(sep) === ':=' ? sep : stop;
      if (eq >= 0 || val(sep) === ':=') body = bodyRange(start, eq >= 0 ? eq : sep + 1, limit);
      end = body?.end ?? stop;
      if (kind === 'type_alias') type = joined(i, stop);
    }
    const signature = raw(start, headerEnd), qualifiedName = parent.kind === 'file' ? label : `${parent.qualifiedName}.${label}`;
    let id = `${sourceFile}::${qualifiedName}#${hash(joined(start, headerEnd)).slice(0, 12)}`;
    if (nodes.some(n => n.id === id)) { diagnostics.push({ severity: 'warning', line: ts[start].line, message: `Duplicate declaration signature: ${qualifiedName}` }); id += `@${ts[start].line}`; }
    const modulePath = kind === 'module' ? `${qualifier || parent.modulePath}/${label}`.replace(/\/+/g, '/') : parent.modulePath;
    const node = { id, label, kind, qualifiedName, parent: parent.id, modulePath, packagePath: file.packagePath, sourceFile, sourceLocation: `${sourceFile}:${ts[nameAt].line}`, line: ts[nameAt].line, endLine: ts[Math.max(start, end - 1)]?.line || ts[start].line, column: ts[nameAt].column, signature, type, returnType, parameters: parameters || [], receiver, bases, mutable, attributes: [...attributes], specifiers: ts.slice(start, headerEnd).filter(t => t.kind === 'specifier').map(t => t.value.slice(1, -1)), external: file.external, qualifier };
    nodes.push(node);
    for (const base of bases) references.push({ source: id, name: base, relation: 'inherits', line: node.line });
    if (body && composites.has(kind)) scope(body.a, body.b, node);
    else if (body) executable(body.a, body.b, node);
    return { end: Math.max(end, i), node };
  }
  function executable(a, b, owner) {
    const typeTokens = new Set();
    // Keep bindings separate from public declarations. Lexical spans avoid sibling-block leakage.
    const bindingEnd = idx => {
      let end = b;
      for (const [open, close] of matches) if (open < idx && close > idx && ['{', '('].includes(val(open))) end = Math.min(end, close);
      let lineStart = idx; while (lineStart > a && ts[lineStart - 1].kind !== 'newline') lineStart--;
      const col = ts[lineStart]?.column || 1;
      for (let j = idx + 1; j < b; j++) if (ts[j - 1]?.kind === 'newline' && ts[j].kind !== 'newline' && ts[j].column < col) { end = Math.min(end, j); break; }
      return end;
    };
    for (let i = a; i < b; i++) {
      if (typeTokens.has(i) || ts[i].kind !== 'id' || controls.has(val(i)) || constructors.has(val(i))) continue;
      const label = val(i), next = skipSpec(i + 1);
      if ([':=', ':'].includes(val(next)) && val(i - 1) !== '.') {
        const end = statementEnd(next + 1, b), eq = val(next) === ':=' ? next : topFind(next + 1, end, ['=']);
        const stopType = topFind(next + 1, end, [',', ')', ']']);
        const typeEnd = eq >= 0 ? eq : stopType >= 0 ? stopType : end;
        const iteration = val(next) === ':' && eq < 0 && [...matches].some(([open, close]) => open < i && close > i && val(open) === '(' && val(open - 1) === 'for');
        const type = val(next) === ':' && !iteration ? joined(next + 1, typeEnd) : '';
        if (type) for (let k = next + 1; k < typeEnd; k++) typeTokens.add(k);
        const initStart = eq >= 0 ? eq + 1 : -1;
        const init = initStart >= 0 ? expression(initStart, b) : null;
        let bindingLimit = bindingEnd(i);
        // A for/if condition binding is visible in its following indented body.
        if (val(bindingLimit) === ')') {
          const open = matches.get(bindingLimit), before = val(open - 1);
          if (before === 'if' || before === 'for') bindingLimit = bodyRange(open - 1, bindingLimit + 1, b).end;
        }
        bindings.push({ owner: owner.id, name: label, type, init, start: ts[i].start, end: ts[bindingLimit]?.start ?? text.length, iteration, iterable: iteration ? joined(next + 1, typeEnd) : '', line: ts[i].line });
      }
      const expr = expression(i, b);
      if (!expr || val(i - 1) === '.') continue;
      // expression() records nested/chained invocation sites; arguments are visited separately.
      for (const call of expr.calls) references.push({ source: owner.id, relation: call.style === '{' ? 'constructs' : 'calls', name: call.name, receiver: call.receiver, style: call.style, args: call.args, arity: call.args.length, line: call.line, offset: call.offset });
      for (const call of expr.calls.filter(c => c.name === 'Subscribe' && c.args.length === 1)) {
        const handler = call.args[0];
        if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(handler)) references.push({ source: owner.id, relation: 'subscribes', name: handler.split('.').at(-1), receiver: handler.includes('.') ? handler.slice(0, handler.lastIndexOf('.')) : '', line: call.line, offset: call.offset, event: call.receiver });
      }
    }
  }
  function expression(start, limit) {
    if (ts[start]?.kind !== 'id' || controls.has(val(start)) || constructors.has(val(start))) return null;
    let i = start, name = val(i++), receiver = '', calls = [];
    if (val(start - 1) === ')' && val(start - 2) === ':' && matches.has(start - 1)) name = joined(matches.get(start - 1), start) + name;
    let chain = name;
    while (i < limit) {
      i = skipSpec(i);
      if (['(', '[', '{'].includes(val(i)) && matches.has(i)) {
        const close = matches.get(i), args = parts(i + 1, close).map(([s, e]) => joined(s, e));
        calls.push({ name, receiver, style: val(i), args, line: ts[start].line, offset: ts[start].start });
        chain += joined(i, close + 1); i = close + 1;
      }
      if (val(i) === '?' && val(i + 1) === '.') { chain += '?'; i++; }
      if (val(i) !== '.' || ts[i + 1]?.kind !== 'id') break;
      receiver = chain; name = val(i + 1); chain += `.${name}`; i += 2;
    }
    return { text: chain, calls };
  }
  function scope(a, b, parent) {
    let attributes = [], i = a;
    while (i < b) {
      i = skipNL(i); if (i >= b) break;
      if ([';', ','].includes(val(i))) { i++; continue; }
      if (val(i) === '@' && ts[i + 1]?.kind === 'id') {
        attributes.push(val(i + 1)); i += 2;
        while (['{', '('].includes(val(i)) && matches.has(i)) i = matches.get(i) + 1;
        continue;
      }
      if (val(i) === 'using' && val(i + 1) === '{' && matches.has(i + 1)) {
        const close = matches.get(i + 1);
        for (const [s, e] of parts(i + 2, close)) imports.push({ source: parent.id, path: joined(s, e), line: ts[i].line, modulePath: parent.modulePath });
        i = close + 1; continue;
      }
      const result = declaration(i, b, parent, attributes);
      attributes = [];
      if (result) { i = result.end; continue; }
      if (parent.kind === 'enum' && val(i) === '(' && matches.has(i) && val(matches.get(i) - 1) === ':') i = matches.get(i) + 1;
      if (parent.kind === 'enum' && ts[i]?.kind === 'id') {
        const label = val(i), id = `${parent.id}::${label}`;
        nodes.push({ id, label, qualifiedName: `${parent.qualifiedName}.${label}`, kind: 'enum_member', parent: parent.id, sourceFile, sourceLocation: `${sourceFile}:${ts[i].line}`, line: ts[i].line, endLine: ts[i].line, modulePath: parent.modulePath, packagePath: file.packagePath, external: file.external }); i++; continue;
      }
      const end = statementEnd(i, b);
      if (i < end) diagnostics.push({ severity: 'warning', line: ts[i].line, message: `Unrecognized declaration: ${raw(i, Math.min(end, i + 15)).slice(0, 160)}` });
      i = Math.max(i + 1, end);
    }
  }
  scope(0, ts.length, file);
  // A call is often found both through its receiver chain and its own token.
  const unique = new Map(references.map(r => [JSON.stringify(r), r]));
  return { nodes, references: [...unique.values()], imports, bindings, diagnostics: diagnostics.map(d => ({ ...d, sourceFile })) };
}
