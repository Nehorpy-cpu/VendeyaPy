/**
 * validate-n8n.mjs — Valida que los workflows de n8n (20-n8n/) sean JSON parseable.
 * Chequeo liviano para CI: no ejecuta n8n, sólo asegura que ningún workflow esté corrupto.
 * Uso (desde la raíz del repo):  node scripts/validate-n8n.mjs
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '20-n8n';
if (!existsSync(DIR)) {
  console.log('ℹ️  No existe 20-n8n/, nada que validar.');
  process.exit(0);
}

const files = [];
function walk(d) {
  for (const entry of readdirSync(d)) {
    if (entry === 'node_modules') continue;
    const p = join(d, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith('.json')) files.push(p);
  }
}
walk(DIR);

let bad = 0;
for (const f of files) {
  try {
    JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    bad++;
    console.error(`❌ JSON inválido: ${f} — ${e.message}`);
  }
}
console.log(`Validados ${files.length} workflow(s) n8n · ${bad} con error.`);
process.exit(bad ? 1 : 0);
