#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const receiptName = '.versify-install.json';
function inventory(root) {
  const entries = {};
  function visit(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name), rel = path.relative(root, full).replaceAll('\\', '/');
      if (rel === receiptName) continue;
      if (e.isSymbolicLink()) throw new Error(`Refusing an installation containing a symbolic link: ${full}`);
      if (e.isDirectory()) { entries[rel + '/'] = 'directory'; visit(full); }
      else if (e.isFile()) entries[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      else throw new Error(`Unexpected filesystem entry: ${full}`);
    }
  }
  visit(root); return entries;
}

export function installSkill({ agent = 'generic', scope = 'user', root = process.cwd(), destination, dryRun = false, uninstall = false, home = os.homedir() } = {}) {
  const dirs = { generic: '.agents', codex: '.agents', claude: '.claude', cursor: '.cursor', kimi: '.kimi-code' };
  if (!dirs[agent]) throw new Error('Agent must be generic, codex, claude, cursor, or kimi. Use --dest for another host.');
  if (!['user', 'project'].includes(scope)) throw new Error('Scope must be user or project');
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let base = scope === 'project' ? path.resolve(root, dirs[agent]) : path.join(home, dirs[agent]);
  if (scope === 'user' && agent === 'kimi' && process.env.KIMI_CODE_HOME) base = path.resolve(process.env.KIMI_CODE_HOME);
  const target = destination ? path.resolve(destination) : path.join(base, 'skills', 'versify');
  if (target === path.parse(target).root || target === path.resolve(home)) throw new Error('Destination must be a dedicated skill folder');
  if (uninstall) {
    if (!fs.existsSync(target)) return { destination: target, uninstalled: false, note: 'Nothing installed at this destination.' };
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing to uninstall through a symbolic link');
    const receiptPath = path.join(target, receiptName);
    if (!fs.existsSync(receiptPath)) throw new Error('No Versify installation receipt. Leave this folder intact; inspect it manually.');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.package !== 'versify-verse' || receipt.destination !== fs.realpathSync(target) || !receipt.files || typeof receipt.files !== 'object') throw new Error('Invalid installation receipt');
    const actual = inventory(target);
    if (Object.keys(actual).length !== Object.keys(receipt.files).length || Object.entries(actual).some(([name, value]) => receipt.files[name] !== value)) throw new Error('Installed files were modified or extra files were added. Nothing removed; back up and inspect this folder manually.');
    // The exact dedicated target and all its contents were verified against the install receipt.
    if (!dryRun) fs.rmSync(target, { recursive: true, force: false });
    return { destination: target, dryRun, uninstalled: !dryRun, note: 'Only the verified skill folder is removed. Project indexes and host MCP settings are untouched.' };
  }
  if (target === source || target.startsWith(source + path.sep)) throw new Error('Installation destination cannot be inside the package');
  if (fs.existsSync(target)) throw new Error(`Destination already exists; nothing overwritten: ${target}`);
  const names = ['SKILL.md', 'agents', 'scripts', 'references', 'package.json', 'README.md', 'LICENSE'];
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(target);
    for (const name of names) fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false });
    fs.writeFileSync(path.join(target, receiptName), JSON.stringify({ package: 'versify-verse', destination: fs.realpathSync(target), files: inventory(target) }, null, 2) + '\n', { flag: 'wx' });
  }
  return { agent, scope, destination: target, dryRun, installed: !dryRun, note: 'Restart or reload the host to discover the skill. Other host settings were not changed.' };
}
export function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log('versify-install [--agent generic|codex|claude|cursor|kimi] [--scope user|project] [--root project] [--dest exact-folder] [--dry-run] [--uninstall]\nInstalls a portable skill or removes an unchanged receipt-verified installation. Existing folders are never overwritten.'); return; }
  const options = {};
  const keys = { '--agent': 'agent', '--scope': 'scope', '--root': 'root', '--dest': 'destination' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') { options.dryRun = true; continue; }
    if (args[i] === '--uninstall') { options.uninstall = true; continue; }
    if (!keys[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid installer option: ${args[i]}`);
    options[keys[args[i]]] = args[++i];
  }
  console.log(JSON.stringify(installSkill(options), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Versify: ${error.message}`); process.exitCode = 1; }
}
