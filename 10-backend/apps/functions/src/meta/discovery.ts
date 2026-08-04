/**
 * meta/discovery.ts — Discovery real de activos Meta + escritura del modelo (Fase 4B)
 * ==================================================================================
 * A partir del WABA y sus phone numbers (vía MetaGraphClient), construye los metaAssets
 * y los persiste junto con metaExternalIndex (para resolver inbound por phone_number_id).
 * buildMetaAssets es puro/testeable; la escritura reemplaza los assets del tenant (idempotente
 * en reconexión). Solo Admin SDK (las reglas deniegan escritura del cliente).
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaAssetType } from '@vpw/shared';
import { declaredAutomationMode, isSessionKey, whatsappSessionKey } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import type { MetaPhoneNumber } from './graphClient.js';

// Mapeo asset → plataforma para el índice global (igual que connect.ts demo).
const PLATFORM_BY_ASSET: Record<string, string> = {
  whatsapp_phone_number: 'whatsapp',
  instagram_account: 'instagram',
  facebook_page: 'messenger',
};

export interface DiscoveredAsset {
  externalId: string;
  assetType: MetaAssetType;
  name: string;
  selected: boolean;
}

export interface BuildAssetsInput {
  businessId?: string;
  businessName?: string;
  wabaId: string;
  wabaName?: string;
  phones: MetaPhoneNumber[];
  selectedPhoneNumberId: string;
}

/** Construye la lista de metaAssets a partir del discovery (PURO). */
export function buildMetaAssets(input: BuildAssetsInput): DiscoveredAsset[] {
  const assets: DiscoveredAsset[] = [];
  if (input.businessId) {
    assets.push({ externalId: input.businessId, assetType: 'business', name: input.businessName || 'Meta Business', selected: true });
  }
  assets.push({ externalId: input.wabaId, assetType: 'whatsapp_business_account', name: input.wabaName || 'WhatsApp Business', selected: true });
  for (const p of input.phones) {
    assets.push({
      externalId: p.id,
      assetType: 'whatsapp_phone_number',
      name: p.displayPhoneNumber || p.verifiedName || p.id,
      selected: p.id === input.selectedPhoneNumberId,
    });
  }
  return assets;
}

/**
 * ADR-0017 — El estado de un asset cuando se corta la conexión ENTERA con Meta (`disconnectMeta`).
 *
 * NO es `'inactive'`, y la diferencia es exactamente la que resuelve la tensión de acá abajo:
 *  · `'inactive'`     ⇒ alguien apagó ESTE número (`deactivateWhatsappNumber`, que además revoca
 *                       el permiso). Reconectar NO puede resucitarlo.
 *  · `'disconnected'` ⇒ se cortó el cable con Meta. Nadie revocó nada, así que el permiso que el
 *                       número ya tenía vuelve con la reconexión.
 *
 * Para todo lo demás se comporta como cualquier estado no-`active`: no cuenta cupo del plan
 * (`countActiveNumbers`), no resuelve credenciales (`resolveTenantWhatsappCredsFor`) y deja pasar
 * una re-alta manual. Y mientras dura la desconexión el número está mudo por el mecanismo de
 * siempre: sin entrada en `metaExternalIndex` el inbound no resuelve empresa.
 */
export const ASSET_STATUS_DESCONECTADO = 'disconnected';

/**
 * ADR-0017 — Campos que SOBREVIVEN a una reconexión.
 *
 * `writeDiscoveredAssets` borra los assets del tenant y los reescribe desde cero. Antes eso solo
 * costaba «se pierde el ruteo local un instante»; con ADR-0017 el permiso para automatizar VIVE en
 * el asset, así que reescribirlo tal cual le sacaría el `live` al número que está atendiendo
 * clientes y lo dejaría mudo hasta que alguien volviera a correr la migración. Por eso el ADR lo
 * marca como requisito de despliegue.
 *
 * Se rescata lo que el discovery NO sabe (Meta no tiene ni idea de nuestro `automationMode`), y
 * SOLO si es válido: preservar no puede convertirse en propagar basura, y un valor irreconocible
 * tiene que volver a caer en el fail-closed. Un documento sin estos campos sale sin ellos.
 */
function camposPreservados(previo: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!previo) return {};
  const conservado: Record<string, unknown> = {};
  const modo = declaredAutomationMode(previo['automationMode']);
  // `null` = el documento no lo tenía. Un `inactive` derivado de basura tampoco se propaga: que
  // el campo quede ausente da el mismo veredicto sin fingir que alguien lo decidió.
  //
  // Y SOLO desde un documento al que NADIE le revocó el permiso: un número que un humano desactivó
  // vuelve a aparecer acá con `status:'inactive'` y su modo viejo intacto; conservarlo lo
  // resucitaría en `live` al reconectar, sin decisión de nadie. El permiso se preserva; no se
  // resucita.
  //
  // `disconnected` sí conserva, y no es una excepción de conveniencia: desconectar Meta es un click
  // del panel que corta la conexión entera, no una decisión sobre ESTE número. Si contara como
  // revocación, un desconectar/reconectar —operación normal— dejaría mudo al número que está
  // vendiendo, que es justamente lo que esta preservación existe para impedir.
  const permisoNoRevocado = previo['status'] === 'active' || previo['status'] === ASSET_STATUS_DESCONECTADO;
  if (permisoNoRevocado && modo !== null && modo === previo['automationMode']) conservado['automationMode'] = modo;
  // La clave del canal se conserva SIEMPRE: perderla no apaga nada, fusiona conversaciones —
  // que es el desenlace peor. Preservarla nunca habilita a nadie.
  if (isSessionKey(previo['sessionKey'])) conservado['sessionKey'] = previo['sessionKey'];
  return conservado;
}

/**
 * ADR-0017 §2 — El canal con el que NACE un número descubierto.
 *
 * Solo para assets que aparecen por PRIMERA vez y que no son el número por defecto del tenant: si
 * nacieran sin `sessionKey`, el resolvedor los mandaría al canal heredado (`active`) y al pasar a
 * `live` compartirían carrito, checkout y takeover con el número que ya está vendiendo.
 *
 * A un asset que YA existía no se le toca el canal aunque no lo declare: mudarlo abandonaría las
 * conversaciones en curso que viven en `sessions/active` (ADR-0017 §2: «no se migra nada»). Ese
 * caso lo cubre la migración, que se niega a automatizar un canal compartido.
 */
function canalDeAlta(a: DiscoveredAsset, previo: Record<string, unknown> | undefined): Record<string, unknown> {
  if (previo || a.assetType !== 'whatsapp_phone_number' || a.selected) return {};
  return { sessionKey: whatsappSessionKey(a.externalId) };
}

/** Reemplaza los activos del tenant + el índice global (Admin SDK). Idempotente en reconexión. */
export async function writeDiscoveredAssets(tenantId: string, connectionId: string, assets: DiscoveredAsset[]): Promise<void> {
  const now = Timestamp.now();
  const batch = db().batch();
  /**
   * ADR-0017 — La limpieza es de ESTA conexión, no del tenant entero.
   *
   * Un número ADICIONAL vive en su propia conexión (`wa_{pnid}`) con su propio token, y el
   * discovery del principal no lo devuelve: borrarlo lo sacaba del índice y lo dejaba MUDO
   * aunque estuviera atendiendo clientes. Un documento sin `connectionId` (escrito antes de que
   * el campo existiera) se considera de esta conexión, así que la limpieza de basura vieja sigue
   * funcionando igual.
   */
  const esDeEstaConexion = (d: Record<string, unknown>): boolean => (d['connectionId'] ?? connectionId) === connectionId;

  // Borra los activos previos de esta conexión y sus entradas de índice (reconexión limpia).
  const oldAssets = await db().collection(paths.metaAssets(tenantId)).get();
  const previoAsset = new Map<string, Record<string, unknown>>();
  oldAssets.docs.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    previoAsset.set(d.id, data);
    if (esDeEstaConexion(data)) batch.delete(d.ref);
  });
  const oldIdx = await db().collection(paths.metaExternalIndex()).where('tenantId', '==', tenantId).get();
  const previoIdx = new Map<string, Record<string, unknown>>();
  oldIdx.docs.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    previoIdx.set(d.id, data);
    if (esDeEstaConexion(data)) batch.delete(d.ref);
  });

  for (const a of assets) {
    const previo = previoAsset.get(a.externalId);
    batch.set(db().doc(paths.metaAsset(tenantId, a.externalId)), {
      id: a.externalId, tenantId, connectionId, assetType: a.assetType, externalId: a.externalId, name: a.name, status: 'active', selected: a.selected, createdAt: now, updatedAt: now,
      ...canalDeAlta(a, previo),
      ...camposPreservados(previo),
    });
    const platform = PLATFORM_BY_ASSET[a.assetType];
    if (platform) {
      const id = `${platform}_${a.externalId}`;
      batch.set(db().doc(paths.metaExternalIndexEntry(id)), {
        id, tenantId, connectionId, assetType: a.assetType, platform, externalId: a.externalId, status: 'active', updatedAt: now,
        ...camposPreservados(previoIdx.get(id)),
      });
    }
  }
  await batch.commit();
}

/** Marca un phone_number como seleccionado (y deselecciona los demás) para el envío. */
export async function selectTenantPhoneNumber(tenantId: string, phoneNumberId: string): Promise<boolean> {
  const snap = await db().collection(paths.metaAssets(tenantId)).where('assetType', '==', 'whatsapp_phone_number').get();
  const target = snap.docs.find((d) => (d.data().externalId as string) === phoneNumberId);
  if (!target) return false;
  const now = Timestamp.now();
  const batch = db().batch();
  for (const d of snap.docs) {
    batch.set(d.ref, { selected: d.id === target.id, updatedAt: now }, { merge: true });
  }
  await batch.commit();
  return true;
}
