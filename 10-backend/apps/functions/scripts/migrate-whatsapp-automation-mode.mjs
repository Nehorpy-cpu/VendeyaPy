/**
 * migrate-whatsapp-automation-mode.mjs — Declara el permiso de automatización de UN número (ADR-0017)
 * ====================================================================================================
 * ADR-0017 §1 separa dos cosas que hasta ahora eran una: `status` («la credencial sirve») y
 * `automationMode` («el bot puede contestar»). El campo es fail-closed: un asset sin él resuelve
 * `inactive`.
 *
 * DE AHÍ EL ORDEN OBLIGATORIO, que es la razón de ser de este script: **la migración del PNID que
 * hoy vende a `live` corre ANTES de desplegar el gate.** Al revés, ese número leería el campo
 * ausente, resolvería `inactive` y quedaría MUDO hasta que alguien corriera esto. El código
 * desplegado hoy ignora el campo, así que en ese orden no hay ventana de interrupción.
 *
 * QUÉ HACE Y QUÉ NO:
 *  · Escribe UN campo (`automationMode`) en UN documento (`tenants/{t}/metaAssets/{pnid}`). Un
 *    `set` del documento entero borraría `connectionId`, `selected` y el nombre — o sea, el ruteo
 *    del inbound y el número por el que sale la respuesta.
 *  · NO toca el índice global: para el resolvedor, la AUSENCIA del campo en el índice no vota
 *    (ver `declaredAutomationMode`), justamente para que esta migración pueda ser de un solo
 *    documento sin dejar al número mudo en el medio.
 *  · NO toca `updatedAt`: una migración no es una edición humana (mismo criterio que la migración
 *    de propiedad del catálogo).
 *  · NO crea assets. Migrar no es dar de alta un número.
 *  · NO tiene tenant por defecto. Este repo es multi-tenant y multi-vertical: el tenant se pasa.
 *  · NO tiene modo por defecto. Un `--mode` ausente, vacío o irreconocible ABORTA sin escribir:
 *    un tipeo no puede terminar poniendo a un número a contestarle a clientes reales.
 *
 * ENCENDER CUESTA; APAGAR NO. Toda promoción (`shadow`/`live`) exige que el asset sea el que
 * REALMENTE rutea el inbound de ese tenant y que su canal no lo esté automatizando otro número.
 * El rollback (`--mode inactive`) no pasa por ninguna de esas verificaciones: nunca puede haber
 * una razón para no poder callar un número.
 *
 * SEGURO POR DEFECTO: **dry-run** salvo `--apply`. **Idempotente**: un número que ya está en el
 * modo pedido no se reescribe. **Con precondición fresca**: la escritura exige el `updateTime` que
 * se leyó, así que una reconexión o una edición del panel en el medio la hacen fallar en vez de
 * pisar.
 *
 * USO (el `--mode` es OBLIGATORIO):
 *   node scripts/migrate-whatsapp-automation-mode.mjs --tenant <id> --pnid <pnid> --mode live
 *   node scripts/migrate-whatsapp-automation-mode.mjs --tenant <id> --pnid <pnid> --mode live --apply
 *   node scripts/migrate-whatsapp-automation-mode.mjs --tenant <id> --pnid <pnid> --mode shadow --apply
 *
 * PRODUCCIÓN: correr SIEMPRE el dry-run primero y guardar el resumen. `--mode inactive` es el
 * rollback de emergencia: deja el número conectado y sin automatizar, sin desconectar nada.
 *
 * El reporte es SANEADO: el número se imprime enmascarado. Nunca hay tokens acá (el token vive en
 * Secret Manager y este script no lo mira).
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  WHATSAPP_AUTOMATION_MODES,
  AUTOMATION_MODE_FAIL_CLOSED,
  LEGACY_SESSION_KEY,
  parseAutomationMode,
  declaredAutomationMode,
  parseSessionKey,
  whatsappSessionKey,
} from '@vpw/shared';

/** El número JAMÁS se imprime entero (misma convención que los logs del motor). */
export function enmascararPnid(phoneNumberId) {
  return `…${String(phoneNumberId ?? '').slice(-4)}`;
}

const esPreconditionFailed = (e) =>
  e?.code === 9 || e?.code === 'failed-precondition' || /precondition|update time/i.test(String(e?.message ?? e));

/** La conexión del número heredado; los adicionales viven en `wa_{pnid}` (ver `multiNumber.ts`). */
const CONEXION_HEREDADA = 'main';

/**
 * ADR-0017 (consecuencias): «Hay ~25 lugares que hoy asumen `sessions/active`; **migrarlos es
 * condición para pasar a `live`**».
 *
 * Mientras esto sea `false`, el script se niega a poner en `live` a un número que NO vive en el
 * canal heredado: el motor leería su conversación de `sessions/active` —la del número que ya
 * vende— y le contestaría con el carrito y el takeover de otra charla. Es una constante del
 * código y no una bandera de línea de comandos a propósito: el ADR pide verificarlo, no confiar
 * en que el operador se acuerde. Se pone en `true` en el commit que migra esos call sites.
 */
const SESIONES_POR_CANAL_MIGRADAS = false;

/**
 * El canal de un asset, con el MISMO criterio que el resolvedor del webhook
 * (`src/meta/automationMode.ts` → `resolveAutomationMode`), que es la autoridad. Se replica acá
 * porque este script es un `.mjs` que corre suelto contra Firestore, sin el bundle de functions;
 * los dos lados están cubiertos por tests y tienen que moverse juntos.
 */
function canalDeclarado(asset, phoneNumberId) {
  const propia = whatsappSessionKey(phoneNumberId);
  const declarada = asset?.sessionKey;
  if (declarada === undefined || declarada === null) {
    const conexion = asset?.connectionId;
    return conexion === undefined || conexion === null || conexion === CONEXION_HEREDADA ? LEGACY_SESSION_KEY : propia;
  }
  return parseSessionKey(declarada, propia);
}

/**
 * ¿Se puede PROMOVER este asset (a `shadow` o a `live`)? Devuelve el motivo del bloqueo o `null`.
 *
 * El defecto que cierra: el script bendecía el documento que le pasaran, sin comprobar que ese
 * PNID fuera el que recibe los mensajes de ese tenant. Un asset huérfano —sin entrada de índice, o
 * con el índice apuntando a otro tenant— se migraba igual, y el número que de verdad rutea quedaba
 * sin migrar: mudo el día que se despliega el gate.
 */
async function motivoDeBloqueo(db, tenantId, phoneNumberId, asset, mode) {
  // 1) Un asset que alguien desactivó no se promueve: fue una decisión humana.
  if (asset.status !== 'active') return 'asset_inactivo';

  // 2) El inbound entra por el índice global. Sin entrada, o con la entrada de otro tenant, este
  //    asset no recibe nada y bendecirlo solo da una falsa sensación de migración.
  const idxSnap = await db.doc(`metaExternalIndex/whatsapp_${phoneNumberId}`).get();
  if (!idxSnap.exists) return 'sin_ruteo';
  if ((idxSnap.data() ?? {}).tenantId !== tenantId) return 'ruteo_de_otro_tenant';

  // 3) Un canal, un número automatizado. Dos números sobre la misma sesión comparten carrito,
  //    estado de checkout y takeover: el bot podría contestar por uno lo que se pidió por el otro.
  const canal = canalDeclarado(asset, phoneNumberId);
  const hermanos = await db
    .collection(`tenants/${tenantId}/metaAssets`)
    .where('assetType', '==', 'whatsapp_phone_number')
    .get();
  for (const d of hermanos.docs ?? []) {
    if (d.id === phoneNumberId) continue;
    const otro = d.data() ?? {};
    const modoOtro = declaredAutomationMode(otro.automationMode);
    // Un vecino dormido (sin el campo, o `inactive`) no ocupa el canal.
    if (modoOtro === null || modoOtro === AUTOMATION_MODE_FAIL_CLOSED) continue;
    if (canalDeclarado(otro, otro.externalId ?? d.id) === canal) return 'canal_compartido';
  }

  if (mode === 'live') {
    // 4) `live` sobre un canal propio necesita que el código sepa leerlo (ver la constante).
    if (canal !== LEGACY_SESSION_KEY && !SESIONES_POR_CANAL_MIGRADAS) return 'sesion_por_canal_no_migrada';
    // 5) Y que sea el número por defecto del tenant: es el que resuelven las credenciales de
    //    salida cuando el outbound no sabe por qué número entró el mensaje.
    if (asset.selected !== true) return 'no_es_el_numero_por_defecto';
  }
  return null;
}

/**
 * Declara el modo de UN número. Devuelve un resumen SANEADO (sin el PNID, sin el nombre).
 *
 * @param db Firestore (Admin SDK)
 * @param {{tenantId?: string, phoneNumberId?: string, mode?: string, apply?: boolean}} opts
 */
export async function migrarModoAutomatizacion(db, { tenantId, phoneNumberId, mode, apply = false } = {}) {
  // El modo no se echa al reporte tal cual: lo que no es uno de los tres no se imprime.
  const modoPedidoValido = WHATSAPP_AUTOMATION_MODES.includes(mode);
  const base = { tenant: tenantId ?? null, numero: enmascararPnid(phoneNumberId), modoNuevo: modoPedidoValido ? mode : null, apply };
  if (!tenantId || !phoneNumberId) return { ...base, outcome: 'invalid_args', modoPrevio: null };
  // Se valida contra la MISMA constante que usa el gate. NO hay default: el modo ausente cae acá
  // igual que un `'LIVE'` escrito a mano, porque encender un número tiene que ser un acto
  // explícito y no el efecto de olvidarse una bandera.
  if (!modoPedidoValido) return { ...base, outcome: 'invalid_mode', modoPrevio: null };

  const ref = db.doc(`tenants/${tenantId}/metaAssets/${phoneNumberId}`);
  const snap = await ref.get();
  if (!snap.exists) return { ...base, outcome: 'not_found', modoPrevio: null };
  const asset = snap.data() ?? {};
  if (asset.assetType !== undefined && asset.assetType !== 'whatsapp_phone_number') {
    return { ...base, outcome: 'not_a_phone_number', modoPrevio: null };
  }

  const modoPrevio = parseAutomationMode(asset.automationMode);

  // Apagar NUNCA se bloquea: fail-closed significa que cuesta encender, no que cuesta callar.
  if (mode !== AUTOMATION_MODE_FAIL_CLOSED) {
    const bloqueo = await motivoDeBloqueo(db, tenantId, phoneNumberId, asset, mode);
    if (bloqueo) return { ...base, outcome: bloqueo, modoPrevio };
  }

  // Idempotencia por el valor CRUDO, no por el parseado: un `'LIVE'` escrito a mano resuelve
  // `inactive` y tiene que poder corregirse a `'inactive'` de verdad.
  if (asset.automationMode === mode) return { ...base, outcome: 'already', modoPrevio };
  if (!apply) return { ...base, outcome: 'would_write', modoPrevio };

  try {
    // updateMask de UN campo + precondición por el updateTime leído: si alguien tocó el asset
    // entre la lectura y esto (una reconexión reescribe el documento entero), no se pisa.
    await ref.update({ automationMode: mode }, { lastUpdateTime: snap.updateTime });
  } catch (e) {
    if (esPreconditionFailed(e)) return { ...base, outcome: 'precondition_failed', modoPrevio };
    throw e;
  }
  return { ...base, outcome: 'written', modoPrevio };
}

// ----------------------------- CLI (solo cuando se ejecuta directo) -----------------------------
const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/migrate-whatsapp-automation-mode.mjs');
if (isMain) {
  const arg = (nombre) => {
    const i = process.argv.indexOf(`--${nombre}`);
    const valor = i >= 0 ? (process.argv[i + 1] ?? '') : '';
    // `--mode --apply` no es un modo: sin esto, la bandera siguiente se colaría como valor.
    return valor.startsWith('--') ? '' : valor;
  };
  const tenantId = arg('tenant');
  const phoneNumberId = arg('pnid');
  const mode = arg('mode');
  const apply = process.argv.includes('--apply');

  if (!tenantId || !phoneNumberId || !mode) {
    console.log('uso: node scripts/migrate-whatsapp-automation-mode.mjs --tenant <id> --pnid <phone_number_id> --mode inactive|shadow|live [--apply]');
    console.log('     --mode es OBLIGATORIO: no hay modo por defecto (ADR-0017, fail-closed).');
    process.exit(2);
  }

  process.env.GCLOUD_PROJECT ??= 'demo-aiafg';
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = getFirestore();

  console.log(
    `migrate-whatsapp-automation-mode — modo: ${apply ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'} · ` +
      `${onEmulator ? 'EMULADOR' : '⚠️ NO-EMULADOR (¿producción?)'} · tenant="${tenantId}" · número=${enmascararPnid(phoneNumberId)} · destino=${mode}`,
  );
  if (!apply) console.log('  (dry-run: usá --apply para escribir; en prod, guardá este resumen antes de aplicar)');
  if (apply && mode === 'live' && !onEmulator) {
    console.log('  ⚠️ `live` habilita respuestas automáticas sobre este número. ADR-0017: solo después del smoke humano.');
  }

  const r = await migrarModoAutomatizacion(db, { tenantId, phoneNumberId, mode, apply });
  console.log('RESUMEN:', JSON.stringify(r, null, 2));
  // Exit code REAL: un desenlace que no es el esperado no puede parecer un éxito en un pipeline.
  process.exitCode = ['written', 'already', 'would_write'].includes(r.outcome) ? 0 : 1;
}
