/**
 * export-tenant.mjs — EXPORT DE PORTABILIDAD de una empresa. PARCIAL y NO RESTAURABLE.
 * ====================================================================================
 * QUÉ ES ESTO, DICHO SIN EUFEMISMOS
 * ---------------------------------
 * Es un volcado legible de las colecciones de primer nivel de un tenant, para **portabilidad de
 * datos (privacidad) y soporte**. **NO es un backup.** No sirve para restaurar, y creer lo
 * contrario es peor que no tener nada: da la sensación de estar cubierto.
 *
 * Por qué NO es restaurable — la lista completa, sin adornos:
 *  · **Enumera 15 colecciones a mano.** Todo lo demás no existe para este archivo. En concreto se
 *    saltea las **sesiones** y los **mensajes** (subcolecciones de cada customer) y los **ítems de
 *    pedido**: usa `collection().get()`, que no baja por subcolecciones.
 *  · **No lleva el ciphertext de `secrets/`.** Restaurar esto dejaría las conexiones Meta MUERTAS.
 *  · **No lleva `metaExternalIndex`**, que es el ruteo del inbound: sin él, un mensaje que llega al
 *    número real no encuentra tenant.
 *  · **Degrada los tipos.** `Timestamp`, `GeoPoint` y `Bytes` pasan por `JSON.stringify` y salen
 *    como mapas anónimos; al volver a entrar dejan de ser fechas y coordenadas.
 *  · **No lleva la identidad** (usuarios ni custom claims), sin la cual el tenant es inaccesible.
 *
 * El backup RESTAURABLE es la familia `backup-*.mjs` / `restore-*.mjs`. Runbook: `docs/backup-restore.md`.
 *
 * TRES GUARDAS BARATAS QUE ESTE ARCHIVO SÍ NECESITABA
 * --------------------------------------------------
 *  1. **Sin `--tenant` se aborta.** Antes el default era un tenant HARDCODEADO (`'perfumeria'`), lo
 *     que además viola la regla del proyecto de no cablear un tenant en el backend.
 *  2. **El destino de entorno se DECLARA.** Antes, si faltaba todo, caía al emulador en silencio:
 *     un operador podía creer que exportó producción y llevarse un archivo del emulador local.
 *  3. **`--out` absoluto y FUERA del repo.** Antes escribía en el cwd, o sea típicamente adentro
 *     del repo, con datos de clientes reales y sin ninguna regla de `.gitignore` que lo cubriera.
 *
 * Y **exit ≠ 0** cuando el tenant no existe o el export sale vacío. Antes terminaba con
 * `process.exit(0)` pasara lo que pasara: un export vacío que "sale bien" es el peor resultado.
 *
 * USO
 *   node scripts/export-tenant.mjs --tenant <id> --project <projectId> --out <archivo .json absoluto fuera del repo> [--include-private]
 *   · Emulador: exportar `FIRESTORE_EMULATOR_HOST` antes de invocar (se declara, no se adivina).
 *   · Producción: exportar `GOOGLE_APPLICATION_CREDENTIALS` y NO setear ningún `*_EMULATOR_HOST`.
 */
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { writeFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { huella, resolverDestino, AYUDA_DESTINO, validarSalida, AYUDA_SALIDA, prepararSalida, leerFlag } from './backup-lib.mjs';

const PUBLIC_COLLECTIONS = [
  'products', 'categories', 'customers', 'orders', 'promotions', 'insights',
  'followUpTasks', 'trackingSources', 'metaConnections', 'metaAssets',
  'metaCampaigns', 'businessEvents', 'auditLogs', 'config',
];
const PRIVATE_COLLECTIONS = ['productFinancials', 'orderFinancials', 'statsDaily'];

// ---------------------------------------------------------------------------
// Guardas — puras, para poder testearlas sin tocar Firestore
// ---------------------------------------------------------------------------

/** Flags que consumen el argumento siguiente. Sin esta lista, `--project X` haría pasar a `X` por posicional. */
const FLAGS_CON_VALOR = new Set(['--tenant', '--project', '--out']);

/**
 * Argumentos sueltos, o sea los que no son un flag ni el VALOR de un flag.
 *
 * La distinción importa: la primera versión de esta función filtraba "lo que no empieza con `--`" y
 * por lo tanto contaba `demo-aiafg` (el valor de `--project`) como un posicional heredado. Una
 * invocación perfectamente correcta se rechazaba con el mensaje equivocado.
 */
function posicionalesDe(argv) {
  const out = [];
  for (let i = 0; i < (argv ?? []).length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) { if (FLAGS_CON_VALOR.has(a)) i += 1; continue; }
    out.push(a);
  }
  return out;
}

/**
 * Valida los argumentos. Devuelve `{ok:true, ...}` o `{ok:false, motivo, ayuda}`.
 *
 * La forma POSICIONAL heredada (`export-tenant.mjs <tenantId> <out.json>`) se detecta y se rechaza
 * con el comando de reemplazo escrito entero: un error que dice "falta --tenant" a quien acaba de
 * pasar el tenant como primer argumento es un error que no ayuda a nadie.
 */
export function validarArgsExport(argv, env = {}) {
  const posicionales = posicionalesDe(argv);
  const flags = new Set((argv ?? []).filter((a) => typeof a === 'string' && a.startsWith('--')).map((a) => a.split('=')[0]));
  if (posicionales.length > 0 && !flags.has('--tenant')) {
    return {
      ok: false,
      motivo: 'forma_posicional_obsoleta',
      ayuda:
        'la forma posicional `export-tenant.mjs <tenantId> <salida.json>` ya no existe. Usá ' +
        '`--tenant <id> --project <projectId> --out <archivo .json absoluto fuera del repo>`.',
    };
  }

  const tenant = leerFlag(argv, 'tenant');
  if (tenant.ambiguo) return { ok: false, motivo: 'tenant_ambiguo', ayuda: '`--tenant` repetido. Un export pertenece a UN tenant.' };
  if (!tenant.valor) {
    return { ok: false, motivo: 'tenant_ausente', ayuda: 'falta `--tenant <id>`. No hay tenant por defecto: el default hardcodeado anterior era además una violación de la regla del proyecto.' };
  }

  const destino = resolverDestino({ env, argv });
  if (!destino.ok) return { ok: false, motivo: destino.motivo, ayuda: AYUDA_DESTINO[destino.motivo] };

  // El destino de ENTORNO se declara: emulador (host explícito) o credenciales explícitas.
  const hayEmulador = Boolean(env.FIRESTORE_EMULATOR_HOST);
  const hayCredenciales = Boolean(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!hayEmulador && !hayCredenciales) {
    return {
      ok: false,
      motivo: 'entorno_no_declarado',
      ayuda:
        'no está declarado contra QUÉ entorno se exporta. Seteá `FIRESTORE_EMULATOR_HOST` para el ' +
        'emulador o `GOOGLE_APPLICATION_CREDENTIALS` para un proyecto real. Caer al emulador en ' +
        'silencio hacía que un export "exitoso" pudiera no ser de donde el operador creía.',
    };
  }
  if (hayEmulador && hayCredenciales) {
    return { ok: false, motivo: 'entorno_ambiguo', ayuda: 'están seteados FIRESTORE_EMULATOR_HOST y GOOGLE_APPLICATION_CREDENTIALS a la vez. Dos destinos declarados no se resuelven eligiendo uno.' };
  }

  const out = leerFlag(argv, 'out');
  if (out.ambiguo) return { ok: false, motivo: 'out_ambiguo', ayuda: '`--out` repetido.' };
  if (!out.valor) return { ok: false, motivo: 'salida_ausente', ayuda: AYUDA_SALIDA.salida_ausente };
  if (!isAbsolute(out.valor)) return { ok: false, motivo: 'salida_relativa', ayuda: AYUDA_SALIDA.salida_relativa };
  if (!out.valor.endsWith('.json')) return { ok: false, motivo: 'salida_no_json', ayuda: '`--out` tiene que terminar en `.json`.' };
  const dir = validarSalida(dirname(resolve(out.valor)));
  if (!dir.ok) return { ok: false, motivo: dir.motivo, ayuda: AYUDA_SALIDA[dir.motivo] };

  return {
    ok: true,
    tenantId: tenant.valor,
    projectId: destino.projectId,
    esEmulador: hayEmulador,
    outPath: resolve(out.valor),
    outDir: dir.path,
    includePrivate: (argv ?? []).includes('--include-private'),
  };
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

async function main(argv, env) {
  const args = validarArgsExport(argv, env);
  if (!args.ok) throw new Error(`[export-tenant] ABORTADO (${args.motivo}): ${args.ayuda}`);

  const { tenantId, projectId, esEmulador, outPath, outDir, includePrivate } = args;
  if (!getApps().length) {
    initializeApp(esEmulador ? { projectId } : { credential: applicationDefault(), projectId });
  }
  const db = getFirestore();

  const tenantSnap = await db.doc(`tenants/${tenantId}`).get();
  if (!tenantSnap.exists) {
    throw new Error(`[export-tenant] ABORTADO: el tenant #${huella(tenantId)} no existe en ${projectId}. Exportar la nada con éxito es lo que hacía esta herramienta antes.`);
  }

  const cols = includePrivate ? [...PUBLIC_COLLECTIONS, ...PRIVATE_COLLECTIONS] : PUBLIC_COLLECTIONS;
  const collections = {};
  for (const c of cols) {
    const snap = await db.collection(`tenants/${tenantId}/${c}`).get();
    collections[c] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  const counts = Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  prepararSalida(outDir);
  const out = {
    tenantId,
    exportedAt: new Date().toISOString(),
    includePrivate,
    // La etiqueta viaja DENTRO del archivo: quien lo encuentre dentro de seis meses tiene que poder
    // saber, sin leer este script, que no puede restaurar con esto.
    alcance: 'EXPORT DE PORTABILIDAD — PARCIAL Y NO RESTAURABLE. Sin subcolecciones (sesiones, mensajes, ítems de pedido), sin secretos, sin índices globales de ruteo, sin identidad, con tipos degradados. El backup restaurable es la familia backup-*.mjs / restore-*.mjs (docs/backup-restore.md).',
    tenant: tenantSnap.data() ?? null,
    counts,
    collections,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2), { mode: 0o600 });

  if (total === 0) {
    throw new Error(`[export-tenant] ABORTADO: el export del tenant #${huella(tenantId)} quedó VACÍO (0 documentos en ${cols.length} colecciones). El archivo se escribió para diagnóstico, pero esto no es un éxito.`);
  }

  console.log(`[export-tenant] OK: tenant #${huella(tenantId)} en ${projectId} → ${outPath}`);
  console.log(`[export-tenant] conteos: ${JSON.stringify(counts)} (total ${total})`);
  console.log('[export-tenant] RECORDATORIO: esto es un export de PORTABILIDAD, parcial y NO restaurable. Para backup usar backup-firestore.mjs / backup-auth.mjs.');
}

// Guard de CLI: importar este módulo no exporta nada de nadie.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
