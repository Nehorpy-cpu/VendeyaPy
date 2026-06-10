#!/usr/bin/env node
/**
 * Valida que cada workflow JSON tenga la estructura mínima esperada de n8n.
 * Se corre en CI para evitar commits de JSONs corruptos.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(__dirname, '..', 'workflows');

const REQUIRED_FIELDS = ['name', 'nodes', 'connections'];

let hasError = false;

const files = (await readdir(workflowsDir)).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.log('No hay workflows todavía — OK.');
  process.exit(0);
}

for (const file of files) {
  const content = await readFile(join(workflowsDir, file), 'utf8');
  try {
    const wf = JSON.parse(content);
    const missing = REQUIRED_FIELDS.filter((f) => !(f in wf));
    if (missing.length > 0) {
      console.error(`❌ ${file}: faltan campos ${missing.join(', ')}`);
      hasError = true;
    } else {
      console.log(`✅ ${file}`);
    }
  } catch (err) {
    console.error(`❌ ${file}: JSON inválido — ${err.message}`);
    hasError = true;
  }
}

process.exit(hasError ? 1 : 0);
