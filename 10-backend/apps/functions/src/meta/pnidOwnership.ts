/**
 * meta/pnidOwnership.ts — De quién es un phone_number_id (ADR-0017)
 * ==================================================================
 * `metaExternalIndex/whatsapp_{pnid}` es lo que resuelve a QUÉ empresa pertenece un inbound.
 * Reclamar un PNID que ya es de otro tenant no es un detalle de ruteo: desvía las conversaciones
 * de los clientes de ese negocio hacia este, y la respuesta sale por el número equivocado.
 *
 * POR QUÉ EXISTE ESTE MÓDULO. La regla vivía duplicada en dos caminos de alta (`manualConnect` y
 * `multiNumber`) y AUSENTE en el tercero (`discovery`, que es el que usa el Embedded Signup real —
 * el mismo por donde va a entrar el número que hoy vende desde la app del vendedor). Dos copias de
 * la misma regla terminan divergiendo, y la que deja pasar es la que gana.
 *
 * Y POR QUÉ EL GUARD VA DENTRO DE LA TRANSACCIÓN. Las dos copias que existían chequeaban ANTES de
 * escribir, con el commit varios pasos después: entre la lectura y la escritura hay una ventana
 * real (TOCTOU) en la que otro tenant reclama el mismo PNID y termina pisado. Por eso la única
 * función que autoriza (`assertPnidLibre`) exige la transacción como argumento: no se puede llamar
 * "por las dudas" desde afuera y creer que alcanza.
 */
import type { Transaction } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';

/** Clave del índice global para un phone_number_id de WhatsApp. */
export function whatsappIndexId(phoneNumberId: string): string {
  return `whatsapp_${phoneNumberId}`;
}

/**
 * Clave del índice global para un WABA (ADR-0020, G11). No rutea inbounds — es el RECLAMO de
 * propiedad de la cuenta: dos tenants no pueden conectar el mismo WABA con números distintos.
 */
export function wabaIndexId(wabaId: string): string {
  return `waba_${wabaId}`;
}

/** El PNID pedido ya es de otra empresa. Lleva el dueño para que el callable pueda explicarlo. */
export class PnidOcupadoError extends Error {
  constructor(
    readonly pnid: string,
    readonly conflictTenantId: string,
  ) {
    super('El número de WhatsApp ya está conectado en otra empresa.');
    this.name = 'PnidOcupadoError';
  }
}

/** El WABA pedido ya es de otra empresa (G11). Mismo contrato que PnidOcupadoError. */
export class WabaOcupadaError extends Error {
  constructor(
    readonly wabaId: string,
    readonly conflictTenantId: string,
  ) {
    super('La cuenta de WhatsApp Business ya está conectada en otra empresa.');
    this.name = 'WabaOcupadaError';
  }
}

/**
 * Decisión PURA. `null` = no hay entrada de índice ⇒ el número está libre.
 *
 * Un dueño vacío (entrada existente SIN `tenantId`, p. ej. a medio escribir o corrupta) se trata
 * como AJENO a propósito: fail-closed. Equivocarse hacia «libre» significa quedarse con el ruteo de
 * otro negocio; equivocarse hacia «ocupado» solo obliga a un humano a mirar el índice.
 */
export function pnidEstaLibre(tenantId: string, duenoActual: string | null | undefined): boolean {
  if (duenoActual === null || duenoActual === undefined) return true;
  return duenoActual === tenantId;
}

/** Lee el dueño de un snapshot del índice: `null` = no existe; `''` = existe sin `tenantId`. */
function duenoDeSnapshot(snap: { exists: boolean; data(): unknown } | undefined): string | null {
  if (!snap?.exists) return null;
  const t = (snap.data() as { tenantId?: unknown } | undefined)?.tenantId;
  return typeof t === 'string' ? t : '';
}

/**
 * Chequeo TEMPRANO, fuera de transacción. Sirve para devolverle al usuario un motivo claro antes de
 * gastar trabajo (guardar tokens, llamar a Graph), pero NO autoriza: entre esta lectura y la
 * escritura hay una ventana. Quien escribe usa `assertPnidLibre`.
 */
export async function duenoActualDePnid(phoneNumberId: string): Promise<string | null> {
  return duenoDeSnapshot(await db().doc(paths.metaExternalIndexEntry(whatsappIndexId(phoneNumberId))).get());
}

/**
 * Guard AUTORITATIVO: corre dentro de la transacción que escribe el índice, así que la lectura y el
 * reclamo son el mismo acto. Lanza `PnidOcupadoError` — y como está dentro de la transacción, el
 * rechazo deja CERO escrituras, no un alta a medio hacer.
 *
 * Firestore exige todas las lecturas antes de la primera escritura: llamarla después de haber
 * escrito en la transacción falla en runtime, así que va siempre al principio del cuerpo.
 */
export async function assertPnidLibre(tx: Transaction, tenantId: string, phoneNumberId: string): Promise<void> {
  const ref = db().doc(paths.metaExternalIndexEntry(whatsappIndexId(phoneNumberId)));
  const dueno = duenoDeSnapshot(await tx.get(ref));
  if (!pnidEstaLibre(tenantId, dueno)) throw new PnidOcupadoError(phoneNumberId, dueno ?? '');
}

/**
 * Guard AUTORITATIVO del WABA (ADR-0020, G11): misma regla «libre o mío» y mismo lugar — dentro
 * de la transacción que escribe el índice. Ausencia de entrada = libre (sin migración: los WABAs
 * ya conectados se reclaman en la próxima conexión/reconexión, documentado en el ADR). Una
 * entrada corrupta sin `tenantId` es AJENA: fail-closed, igual que el PNID.
 */
export async function assertWabaLibre(tx: Transaction, tenantId: string, wabaId: string): Promise<void> {
  const ref = db().doc(paths.metaExternalIndexEntry(wabaIndexId(wabaId)));
  const dueno = duenoDeSnapshot(await tx.get(ref));
  if (!pnidEstaLibre(tenantId, dueno)) throw new WabaOcupadaError(wabaId, dueno ?? '');
}
