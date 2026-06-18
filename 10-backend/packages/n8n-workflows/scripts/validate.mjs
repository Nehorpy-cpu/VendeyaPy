#!/usr/bin/env node
/**
 * validate.mjs — Valida los workflows de n8n.
 * ===========================================
 * FUENTE ÚNICA DE VERDAD: `20-n8n/workflows/` (en la raíz del repo). Este paquete
 * NO guarda los workflows; solo provee la validación (CI + local).
 * Chequea JSON válido + estructura mínima de n8n: name, nodes, connections.
 *
 * Uso:  pnpm --filter @vpw/n8n-workflows validate
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts → n8n-workflows → packages → 10-backend → <repo>, luego 20-n8n/workflows.
const workflowsDir = join(__dirname, '..', '..', '..', '..', '20-n8n', 'workflows');

const REQUIRED_FIELDS = ['name', 'nodes', 'connections'];

if (!existsSync(workflowsDir)) {
  console.error(`❌ No existe la carpeta de workflows: ${workflowsDir}`);
  process.exit(1);
}

const files = (await readdir(workflowsDir)).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.log('ℹ️  No hay workflows todavía — OK.');
  process.exit(0);
}

let hasError = false;
let placeholders = 0;
for (const file of files) {
  try {
    const raw = (await readFile(join(workflowsDir, file), 'utf8')).replace(/^﻿/, '');
    const wf = JSON.parse(raw);
    const missing = REQUIRED_FIELDS.filter((f) => !(f in wf));
    if (missing.length > 0) {
      console.error(`❌ ${file}: faltan campos ${missing.join(', ')}`);
      hasError = true;
    } else if (wf._placeholder) {
      placeholders++;
      console.log(`☐ ${file}: placeholder OK (${wf.name})`);
    } else {
      console.log(`✅ ${file}: ${wf.name} (${Array.isArray(wf.nodes) ? wf.nodes.length : '?'} nodos)`);
    }
  } catch (err) {
    console.error(`❌ ${file}: JSON inválido — ${err.message}`);
    hasError = true;
  }
}

console.log(`\nFuente: 20-n8n/workflows · ${files.length} workflow(s) · ${placeholders} placeholder(s) · ${hasError ? 'CON ERRORES' : 'OK'}.`);
process.exit(hasError ? 1 : 0);
