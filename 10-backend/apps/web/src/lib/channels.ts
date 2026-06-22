/**
 * Capa de acceso a la config por canal del tenant (panel · WhatsApp real · W-1).
 * Doc Firestore: tenants/{t}/config/channels — controla `whatsappSendMode` (mock|live),
 * o sea si el bot responde en WhatsApp REAL (separado del on/off del agente, botEnabled).
 *
 * LECTURA: directa a Firestore (las reglas permiten leer a owner/viewer).
 * ESCRITURA: pasa por el callable seguro `channelConfigUpdate` (owner/admin). El front NO decide
 * `live`: el backend solo lo permite si la conexión Meta del tenant es RESOLUBLE (activa + número +
 * token). Acá nunca se tocan tokens ni se valida nada de Meta en el cliente.
 */

import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable, type FunctionsError } from 'firebase/functions';
import type { ChannelConfig, WhatsappSendMode } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

/** Lee config/channels. Si no existe, default `whatsappSendMode:'mock'` (no se envía a Meta). */
export async function getChannelConfig(tenantId: string): Promise<ChannelConfig> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId, 'config', 'channels'));
  const base: ChannelConfig = { whatsappSendMode: 'mock' };
  return snap.exists() ? { ...base, ...(snap.data() as Partial<ChannelConfig>) } : base;
}

/**
 * Cambia el modo de envío de WhatsApp vía callable `channelConfigUpdate` (NO write directo).
 * `'live'` lo decide el BACKEND: solo lo acepta si la conexión Meta es resoluble; si no, lanza
 * failed-precondition (mapeala con friendlyChannelError). Devuelve el modo efectivo aplicado.
 */
export async function setWhatsappSendMode(tenantId: string, mode: WhatsappSendMode): Promise<WhatsappSendMode> {
  const call = httpsCallable<{ tenantId: string; data: { whatsappSendMode: WhatsappSendMode } }, { ok: boolean; whatsappSendMode: WhatsappSendMode }>(
    firebaseFunctions(),
    'channelConfigUpdate',
  );
  const res = await call({ tenantId, data: { whatsappSendMode: mode } });
  return res.data.whatsappSendMode;
}

/** Mapea errores de channelConfigUpdate a mensajes claros (sin exponer detalles sensibles). */
export function friendlyChannelError(e: unknown): string {
  const err = e as Partial<FunctionsError> & { code?: string; message?: string };
  const code = err?.code ?? '';
  // live bloqueado porque Meta no es resoluble (sin conexión activa / sin número / token).
  if (code === 'functions/failed-precondition') return 'Conectá Meta y elegí un número de WhatsApp antes de activar respuestas reales.';
  if (code === 'functions/permission-denied') return err?.message || 'Solo el dueño o un administrador pueden cambiar el modo de WhatsApp.';
  if (code === 'functions/unauthenticated') return 'Iniciá sesión para continuar.';
  if (code === 'functions/invalid-argument') return err?.message || 'El modo de WhatsApp no es válido.';
  return err?.message || 'No se pudo cambiar el modo de WhatsApp. Probá de nuevo.';
}
