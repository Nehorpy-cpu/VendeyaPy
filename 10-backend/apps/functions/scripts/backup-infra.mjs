/**
 * backup-infra.mjs — Manifiesto de INFRAESTRUCTURA: lo que un restore de datos no repone.
 * =======================================================================================
 * POR QUÉ EXISTE
 * --------------
 * Un backup de documentos y usuarios describe el CONTENIDO. Lo que hace funcionar ese contenido es
 * otra cosa: qué commit está desplegado, qué Functions existen, qué Rules las protegen, qué índices
 * resuelven las consultas, **qué políticas TTL borran lo que tiene que borrarse**, qué schedulers
 * corren y qué secretos hay declarados. Nada de eso vuelve solo, y dos hechos lo hacen crítico:
 *
 *   · **Un restore NO repone las políticas TTL.** El TTL es configuración de la BASE, no un dato.
 *     Si se restaura sobre una base nueva y nadie las recrea, `metaWebhookHistory`,
 *     `metaWebhookAppState` y `metaWebhookShadow` —que guardan hasta 180 días de conversaciones
 *     privadas y el texto de los mensajes en observación— dejan de purgarse y crecen sin límite.
 *     Este manifiesto las enumera EXACTAMENTE como están declaradas, para poder recrearlas.
 *   · **Un backup gestionado de Firestore retiene hasta 14 semanas.** Eso choca de frente con el
 *     TTL de 48 h del archivo de Coexistence: lo que el TTL borra a las 48 h sigue vivo dentro del
 *     backup gestionado durante semanas. Hay que saberlo antes de responder un pedido de borrado.
 *
 * QUÉ LEE, Y DE DÓNDE — cada dato dice su PROCEDENCIA
 * --------------------------------------------------
 * Por defecto **no toca la red**: reconstruye el manifiesto desde el repo (commit desplegable,
 * Rules, índices, TTL declarados, Functions exportadas, schedulers con su cron y zona horaria,
 * NOMBRES de configuración y de secretos). Con `--vivo` complementa con lecturas **estrictamente
 * de solo lectura** del CLI de firebase que el repo ya usa. Cada campo lleva `origen: 'repo'` o
 * `origen: 'vivo'`, porque un manifiesto que mezcla lo declarado con lo desplegado sin decir cuál
 * es cuál es justamente lo que hace que una deriva pase inadvertida.
 *
 * NUNCA registra VALORES de secretos ni de variables de entorno: solo NOMBRES y, en `--vivo`,
 * referencias de versión.
 *
 * USO
 *   node scripts/backup-infra.mjs --project <id> --out <dir absoluto> [--apply] [--vivo]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sha256, resolverDestino, AYUDA_DESTINO, validarSalida, AYUDA_SALIDA, prepararSalida,
  leerFlag, esAplicar, tieneFlag, manifiestoBase, RAIZ_BACKEND, RAIZ_REPO,
} from './backup-lib.mjs';

// ---------------------------------------------------------------------------
// Lógica PURA — se testea sin disco ni red
// ---------------------------------------------------------------------------

/**
 * Políticas TTL DECLARADAS en `firestore.indexes.json`.
 *
 * Se leen de `fieldOverrides[].ttl === true`, que es la única declaración versionada que existe.
 * Ojo con lo que este dato NO dice: el TTL de `metaWebhookInbox` es política de CONSOLA y no está
 * en el archivo, así que el manifiesto lo marca como incompleto en vez de fingir cobertura total.
 */
export function ttlDeclaradas(indexesJson) {
  const overrides = Array.isArray(indexesJson?.fieldOverrides) ? indexesJson.fieldOverrides : [];
  return overrides
    .filter((f) => f?.ttl === true)
    .map((f) => ({ coleccion: f.collectionGroup, campo: f.fieldPath }))
    .sort((a, b) => `${a.coleccion}.${a.campo}`.localeCompare(`${b.coleccion}.${b.campo}`));
}

/** Nombres de las funciones re-exportadas desde `src/index.ts` (las que existen para firebase). */
export function functionsExportadas(fuenteIndex) {
  const sinComentarios = fuenteIndex
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const nombres = new Set();
  for (const m of sinComentarios.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
    for (const bruto of m[1].split(',')) {
      const n = bruto.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) nombres.add(n);
    }
  }
  for (const m of sinComentarios.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)/g)) nombres.add(m[1]);
  return [...nombres].sort();
}

/** Schedulers declarados en el código, con su cron y su zona horaria. */
export function schedulersDeclarados(archivos) {
  const out = [];
  for (const { archivo, texto } of archivos) {
    for (const m of texto.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*onSchedule\(/g)) {
      const desde = m.index ?? 0;
      const ventana = texto.slice(desde, desde + 900);
      const cron = /schedule:\s*['"`]([^'"`]+)['"`]/.exec(ventana);
      const tz = /timeZone:\s*['"`]([^'"`]+)['"`]/.exec(ventana);
      out.push({ nombre: m[1], archivo, cron: cron?.[1] ?? null, zonaHoraria: tz?.[1] ?? null });
    }
  }
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/** NOMBRES de los secretos declarados con `defineSecret`. Nunca valores. */
export function secretosDeclarados(archivos) {
  const nombres = new Set();
  for (const { texto } of archivos) for (const m of texto.matchAll(/defineSecret\(\s*['"`]([^'"`]+)['"`]/g)) nombres.add(m[1]);
  return [...nombres].sort();
}

/** NOMBRES de variables de un `.env.example`. El `.example` no tiene valores reales por contrato. */
export function nombresDeEnv(texto) {
  return [...new Set(
    texto.split('\n')
      .map((l) => /^\s*([A-Z0-9_]+)\s*=/.exec(l)?.[1])
      .filter(Boolean),
  )].sort();
}

// ---------------------------------------------------------------------------
// Efectos de LECTURA (repo)
// ---------------------------------------------------------------------------

const leer = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const hashDe = (p) => (existsSync(p) ? sha256(readFileSync(p)) : null);

/** Recorre `src/` recolectando los `.ts` que no son tests. */
function fuentesTs(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) fuentesTs(p, acc);
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) acc.push({ archivo: p.slice(RAIZ_BACKEND.length + 1).replace(/\\/g, '/'), texto: readFileSync(p, 'utf8') });
  }
  return acc;
}

function commitDesplegable() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: RAIZ_REPO, encoding: 'utf8' }).trim();
    const sucio = execFileSync('git', ['status', '--porcelain'], { cwd: RAIZ_REPO, encoding: 'utf8' }).trim().length > 0;
    return { commit, arbolSucio: sucio };
  } catch (e) {
    return { commit: null, arbolSucio: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Lecturas VIVAS, estrictamente de solo lectura, con el CLI de firebase del propio repo.
 *
 * `execFileSync` sin shell (nada de interpolación), subcomandos de listado únicamente y `--project`
 * explícito. Si una falla, se registra el error y se sigue: un manifiesto parcial y honesto vale
 * más que ninguno, y **el fallo queda escrito** en vez de desaparecer.
 */
export function lecturasVivas(projectId, { ejecutar = ejecutarFirebase } = {}) {
  const comandos = {
    functions: ['functions:list', '--json'],
    indices: ['firestore:indexes', '--json'],
    apps: ['apps:list', '--json'],
  };
  const out = {};
  for (const [clave, args] of Object.entries(comandos)) {
    try {
      out[clave] = { origen: 'vivo', datos: JSON.parse(ejecutar([...args, '--project', projectId])) };
    } catch (e) {
      out[clave] = { origen: 'vivo', error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

function ejecutarFirebase(args) {
  const bin = join(RAIZ_BACKEND, 'node_modules', '.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
  return execFileSync(bin, args, { encoding: 'utf8', cwd: RAIZ_BACKEND, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Lo que este manifiesto NO puede leer y hay que verificar aparte, con el comando exacto.
 *
 * Se escribe la deuda en vez de dejar el campo vacío: un manifiesto con huecos silenciosos hace
 * creer que la infraestructura está cubierta cuando no lo está.
 */
export const PENDIENTES_FUERA_DE_ALCANCE = [
  { que: 'Políticas TTL ACTIVAS en la base', comando: 'gcloud firestore fields ttls list --project <projectId>', porque: 'un restore NO las repone y `firestore.indexes.json` no incluye la de `metaWebhookInbox`, que es política de consola.' },
  { que: 'Jobs de Cloud Scheduler realmente creados', comando: 'gcloud scheduler jobs list --project <projectId>', porque: 'el cron declarado en el código y el job desplegado pueden divergir; un rollback de código no frena un scheduler.' },
  { que: 'Bindings de IAM del service account de Functions', comando: 'gcloud projects get-iam-policy <projectId>', porque: 'el grant `iam.serviceAccountTokenCreator` sobre sí mismo es lo que permite firmar las URLs de comprobantes: sin él, el visor deja de funcionar y nada en los datos lo explica.' },
  { que: 'Versiones de los secretos gestionados', comando: 'firebase functions:secrets:access <NOMBRE> --project <projectId>  (NO ejecutar: imprime el VALOR; usar la consola para ver solo versiones)', porque: 'el manifiesto guarda NOMBRES y referencias; los valores no se respaldan nunca.' },
  { que: 'Reglas de Firestore/Storage realmente desplegadas', comando: 'firebase deploy --only firestore:rules --dry-run  /  consola → Rules → historial de versiones', porque: 'el hash del archivo del repo prueba qué dice el repo, no qué está publicado.' },
];

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

async function main(argv, env) {
  const destino = resolverDestino({ env, argv });
  if (!destino.ok) throw new Error(`[backup-infra] ABORTADO (${destino.motivo}): ${AYUDA_DESTINO[destino.motivo]}`);

  const outFlag = leerFlag(argv, 'out');
  if (outFlag.ambiguo) throw new Error('[backup-infra] ABORTADO: `--out` repetido.');
  const salida = validarSalida(outFlag.valor);
  if (!salida.ok) throw new Error(`[backup-infra] ABORTADO (${salida.motivo}): ${AYUDA_SALIDA[salida.motivo]}`);

  const aplicar = esAplicar(argv);
  const vivo = tieneFlag(argv, 'vivo');
  const { projectId, esEmulador } = destino;

  const indexesPath = join(RAIZ_BACKEND, 'firestore.indexes.json');
  const indexes = JSON.parse(readFileSync(indexesPath, 'utf8'));
  const fuentes = fuentesTs(join(RAIZ_BACKEND, 'apps', 'functions', 'src'));

  const infra = {
    ...manifiestoBase({ herramienta: 'backup-infra', projectId, esEmulador, tenantId: null, aplicado: aplicar }),
    codigo: { origen: 'repo', ...commitDesplegable() },
    reglas: {
      origen: 'repo',
      firestoreRulesSha256: hashDe(join(RAIZ_BACKEND, 'firestore.rules')),
      storageRulesSha256: hashDe(join(RAIZ_BACKEND, 'storage.rules')),
      advertencia: 'El hash prueba qué dice el REPO, no qué está publicado en el proyecto.',
    },
    indices: {
      origen: 'repo',
      sha256: hashDe(indexesPath),
      compuestos: Array.isArray(indexes.indexes) ? indexes.indexes.length : 0,
      fieldOverrides: Array.isArray(indexes.fieldOverrides) ? indexes.fieldOverrides.length : 0,
    },
    ttl: {
      origen: 'repo',
      declaradas: ttlDeclaradas(indexes),
      advertencia:
        'UN RESTORE NO REPONE LAS POLÍTICAS TTL: son configuración de la base, no datos. Y esta lista ' +
        'es INCOMPLETA por diseño — el TTL de `metaWebhookInbox` es política de consola y no está ' +
        'versionado. Verificar con `gcloud firestore fields ttls list`.',
      choqueConBackupGestionado:
        'Un backup gestionado de Firestore retiene hasta 14 semanas. El archivo de Coexistence tiene ' +
        'TTL de 48 h: lo que el TTL borra sigue existiendo dentro del backup gestionado por semanas.',
    },
    functions: { origen: 'repo', exportadas: functionsExportadas(readFileSync(join(RAIZ_BACKEND, 'apps', 'functions', 'src', 'index.ts'), 'utf8')) },
    schedulers: { origen: 'repo', declarados: schedulersDeclarados(fuentes) },
    secretos: {
      origen: 'repo',
      declaradosConDefineSecret: secretosDeclarados(fuentes),
      politica: 'Se registran NOMBRES y referencias. Los VALORES no se respaldan, no se imprimen y no se descifran.',
    },
    configuracionPublica: {
      origen: 'repo',
      functionsEnvExample: nombresDeEnv(leer(join(RAIZ_BACKEND, 'apps', 'functions', '.env.example')) ?? ''),
      webEnvExample: nombresDeEnv(leer(join(RAIZ_BACKEND, 'apps', 'web', '.env.example')) ?? ''),
      nota: 'Solo NOMBRES: los `.env` reales nunca se leen ni se copian acá.',
    },
    hosting: { origen: 'repo', firebaseJsonSha256: hashDe(join(RAIZ_BACKEND, 'firebase.json')), firebaseFunctionsJsonSha256: hashDe(join(RAIZ_BACKEND, 'firebase.functions.json')) },
    pendientesFueraDeAlcance: PENDIENTES_FUERA_DE_ALCANCE,
  };

  if (vivo) infra.vivo = lecturasVivas(projectId);

  if (!aplicar) {
    console.log(`[backup-infra] DRY-RUN destino=${projectId}: ${infra.functions.exportadas.length} functions exportadas, ${infra.schedulers.declarados.length} schedulers, ${infra.ttl.declaradas.length} políticas TTL declaradas, ${infra.secretos.declaradosConDefineSecret.length} secretos declarados.`);
    console.log('[backup-infra] nada escrito. Repetir con `--apply`.');
    return;
  }

  prepararSalida(salida.path);
  writeFileSync(join(salida.path, 'manifest-infra.json'), `${JSON.stringify(infra, null, 2)}\n`, { mode: 0o600 });
  console.log(`[backup-infra] OK → ${salida.path} (functions=${infra.functions.exportadas.length} schedulers=${infra.schedulers.declarados.length} ttl=${infra.ttl.declaradas.length}${vivo ? ' +vivo' : ''})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
