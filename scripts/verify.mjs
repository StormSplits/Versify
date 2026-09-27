#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const file of [...Object.values(pkg.bin), 'LICENSE', 'SKILL.md', 'README.md', 'agents/openai.yaml']) if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing package file: ${file}`);
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  if (!/^---\r?\nname: versify\r?\ndescription: [^\r\n]+\r?\n---/.test(skill)) throw new Error('Invalid skill frontmatter');
  if (/\[TODO:/.test(skill)) throw new Error('Unfinished skill placeholder');
  let linkCount = 0;
  const docs = ['README.md', 'SKILL.md', ...fs.readdirSync(path.join(root, 'references')).filter(n => n.endsWith('.md')).map(n => `references/${n}`)];
  for (const file of docs) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:|^#/.test(match[1])) continue;
      const target = path.resolve(root, path.dirname(file), match[1].split('#')[0]);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) throw new Error(`Broken local link in ${file}: ${match[1]}`);
      linkCount++;
    }
  }
  console.log(`Package structure, skill metadata and ${linkCount} documentation links verified.`);
  const result = spawnSync(process.execPath, ['--test', 'scripts/versify.test.mjs', 'scripts/integration.test.mjs'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) { console.error(`Verification failed: ${error.message}`); process.exitCode = 1; }
