/**
 * conversation/canal.ts — ¿De qué canal es esta conversación, cuando no hay turno que lo diga?
 * =============================================================================================
 * ADR-0017 §2. El webhook sabe el canal porque lo trae el evento: `metadata.phone_number_id` →
 * `resolveAutomationMode` → `sessionKey`. El PANEL no. Los callables de tomar/liberar chat y el
 * mensaje manual solo tienen `tenantId` y `customerId`, y hasta acá resolvían el problema no
 * resolviéndolo: escribían en `sessions/active`, que con más de un número es «la conversación del
 * que ya vende».
 *
 * LA REGLA DURA DE ESTE MÓDULO: acá NO se llama a `whatsappSessionKey(pnid)`. Esa función devuelve
 * `wa_{pnid}` SIEMPRE, así que aplicarla al número que hoy vende mudaría de golpe todas sus
 * conversaciones —carrito, takeover, checkout en curso— a documentos vacíos. El canal se le
 * PREGUNTA a la autoridad, que es la única que sabe que el número heredado vive legítimamente en
 * `active`.
 *
 * Y el fallback legacy es EXPLÍCITO, no un default silencioso: una conversación sin `receivedVia`
 * es anterior al multi-número y vive en `active`. La otra rama —la lectura del permiso se cayó—
 * NO se resuelve adivinando: se falla. Caer a `active` ahí sería tomar (o devolverle al bot) la
 * conversación del número que está vendiendo, por un hipo de Firestore.
 */
import { LEGACY_SESSION_KEY, sessionKeyDePlataforma } from '@vpw/shared';
import { resolveAutomationMode } from '../meta/automationMode.js';
import { db, paths } from '../lib/firebase.js';

/**
 * No se pudo determinar el canal. Es una condición TEMPORAL (la lectura del asset falló), y por
 * eso es un error y no un valor: el llamador la traduce a «probá de nuevo», nunca a `active`.
 */
export class CanalIndeterminadoError extends Error {
  constructor() {
    super('No se pudo determinar el canal de la conversación.');
    this.name = 'CanalIndeterminadoError';
  }
}

/** Canal de la conversación que entró por este `phone_number_id`. */
export async function resolverCanalDePnid(tenantId: string, receivedVia: string | null | undefined): Promise<string> {
  const pnid = (receivedVia ?? '').trim();
  // FALLBACK LEGACY EXPLÍCITO: sin número receptor registrado no hay canal que resolver — son las
  // conversaciones anteriores al multi-número, que viven en `active` y no se migran.
  if (pnid === '') return LEGACY_SESSION_KEY;
  const canal = await resolveAutomationMode(tenantId, pnid);
  if (canal.origen === 'error_lectura') throw new CanalIndeterminadoError();
  return canal.sessionKey;
}

/**
 * Canal propio de una plataforma que NO es WhatsApp, o `null` si la conversación es de WhatsApp
 * (o anterior a que el resumen registrara la plataforma). Pura, sin I/O — es LA regla, y vive en
 * un solo lugar para que el panel y el mensaje manual no puedan divergir.
 *
 * Existe porque `receivedVia` lo escribe únicamente WhatsApp: resolver el canal SOLO por ese campo
 * mandaba las conversaciones de Instagram/Messenger al fallback legacy `active` — el canal del
 * número de WhatsApp que vende — mientras el motor les escribe en `ig`/`msgr`. Tomar un chat de
 * Instagram desde el panel silenciaba al bot en el número equivocado.
 */
export function canalDePlataformaNoWhatsapp(channel: string | null | undefined): string | null {
  const plataforma = (channel ?? '').trim();
  if (plataforma === '' || plataforma === 'whatsapp') return null;
  return sessionKeyDePlataforma(plataforma);
}

/**
 * Canal de la conversación de un cliente, leído de su resumen: primero la PLATAFORMA
 * (`conversation.channel` — Instagram/Messenger tienen canal fijo propio, sin PNID que autorizar)
 * y recién después el número receptor (`conversation.receivedVia`) — el mismo campo que ya decide
 * por qué número SALE el mensaje manual, para que el gate y el envío no puedan estar mirando
 * conversaciones distintas.
 */
export async function resolverCanalDeConversacion(tenantId: string, customerId: string): Promise<string> {
  const snap = await db().doc(paths.customer(tenantId, customerId)).get();
  const conv = (snap.data() as { conversation?: { channel?: string | null; receivedVia?: string | null } } | undefined)?.conversation;
  const porPlataforma = canalDePlataformaNoWhatsapp(conv?.channel);
  if (porPlataforma !== null) return porPlataforma;
  return resolverCanalDePnid(tenantId, conv?.receivedVia ?? null);
}
