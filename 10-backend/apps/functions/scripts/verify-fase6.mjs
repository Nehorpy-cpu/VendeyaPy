/**
 * verify-fase6.mjs — Verifica el export de datos de empresa (Fase 6).
 * Genera un export y comprueba que trae el catálogo/clientes/pedidos, y que por
 * defecto NO incluye finanzas privadas (sí con --include-private).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
// El exportador ahora EXIGE `--out` absoluto y fuera del árbol del repo: un export lleva datos
// privados del tenant y la ruta relativa de antes los dejaba caer adentro del repositorio.
const OUT = join(tmpdir(), 'vpw-fase6-export.json');
// Y exige `--tenant`/`--project` explícitos: el default `'perfumeria'` que tenía violaba la regla
// de no cablear la vertical, y caer al emulador en silencio hacía que un export apuntara a
// cualquier lado sin decirlo.
const EXPORT = ['scripts/export-tenant.mjs', '--tenant', 'perfumeria', '--project', 'demo-aiafg', '--out', OUT];

// 1. Export por defecto (sin finanzas privadas)
execFileSync('node', EXPORT, { stdio: 'ignore' });
check('1. Export generado', existsSync(OUT));
const data = JSON.parse(readFileSync(OUT, 'utf8'));
check('2. Export trae el catálogo', (data.counts?.products ?? 0) >= 1, `products=${data.counts?.products}`);
check('3. Export trae clientes', (data.counts?.customers ?? 0) >= 1, `customers=${data.counts?.customers}`);
check('4. Export trae pedidos', (data.counts?.orders ?? 0) >= 1, `orders=${data.counts?.orders}`);
check('5. Por defecto NO incluye finanzas privadas (privacidad)', !('productFinancials' in (data.collections ?? {})));

// 2. Export con --include-private
execFileSync('node', [...EXPORT, '--include-private'], { stdio: 'ignore' });
const dataP = JSON.parse(readFileSync(OUT, 'utf8'));
check('6. Con --include-private SÍ incluye finanzas', 'orderFinancials' in (dataP.collections ?? {}));

try { unlinkSync(OUT); } catch { /* noop */ }

const ok = results.every((x) => x);
console.log(`\nRESULTADO FASE 6 (export/backup): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
