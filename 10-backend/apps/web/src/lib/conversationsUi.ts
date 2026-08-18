/**
 * lib/conversationsUi.ts — helpers PUROS de la bandeja de conversaciones (ADR-0021).
 * Sin React, sin Firebase: todo lo de acá se testea solo con datos.
 *
 * Vive separado de `conversations.ts` (que habla con Firestore/callables) para que los tests
 * de presentación y de reglas de UI no tengan que mockear Firebase.
 */

import type { Customer, Message, MessageChannel, MessageDeliveryStatus } from '@vpw/shared';
import type { Role } from './auth-context';

// ---------------------------------------------------------------------------
// Identidad visible del cliente
// ---------------------------------------------------------------------------

/**
 * ADR-0021 §2: prioridad de display `name (CRM) || profileName || teléfono`.
 * P3: el nombre de PERFIL lo escribe el propio cliente en su WhatsApp (no es dato confirmado):
 * se muestra con el prefijo «~» (patrón WhatsApp Business) en lista y header para que «Soporte
 * VendeYa» no se lea igual que un nombre CRM verificado. El panel de info etiqueta el origen.
 */
export function conversationDisplayName(c: Pick<Customer, 'name' | 'profileName' | 'whatsappPhone' | 'id'>): string {
  const crm = c.name?.trim();
  if (crm) return crm;
  const perfil = c.profileName?.trim();
  if (perfil) return `~${perfil}`;
  return c.whatsappPhone || c.id;
}

/**
 * Iniciales para el avatar. Con letras: primera letra de las dos primeras palabras.
 * Solo dígitos (teléfono): últimos 2 dígitos — un «+5» de país no identifica a nadie.
 * La tilde «~» del nombre de perfil (P3) es un marcador de origen, no parte del nombre.
 */
export function initialsFor(label: string): string {
  const limpio = (label ?? '').trim().replace(/^~\s*/, '');
  if (!limpio) return '?';
  const palabras = limpio.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (palabras.length >= 2) return (primeraLetra(palabras[0]!) + primeraLetra(palabras[1]!)).toUpperCase();
  if (palabras.length === 1) return primeraLetra(palabras[0]!).toUpperCase();
  const digitos = limpio.replace(/\D/g, '');
  if (digitos.length >= 2) return digitos.slice(-2);
  return '?';
}

function primeraLetra(palabra: string): string {
  const m = palabra.match(/\p{L}/u);
  return m ? m[0]! : '';
}

/**
 * Paleta determinística del avatar (pares fondo/texto con contraste AA sobre blanco).
 * Tonos del design system del panel (ink/mint/coral/amber/sky ya se usan en páginas hermanas).
 */
export const AVATAR_PALETTE = [
  'bg-mint-100 text-mint-700',
  'bg-ink-100 text-ink-700',
  'bg-coral-100 text-coral-700',
  'bg-amber-100 text-amber-800',
  'bg-sky-100 text-sky-800',
  'bg-violet-100 text-violet-800',
] as const;

/** Índice determinístico por id: el mismo cliente siempre tiene el mismo color. */
export function avatarPaletteIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % AVATAR_PALETTE.length;
}

/**
 * ADR-0021 §2: en el panel de info el teléfono se muestra ENMASCARADO — prefijo + últimos 3.
 * Un número demasiado corto no se «enmascara» a medias: se oculta entero salvo el final.
 */
export function maskPhone(phone: string | null | undefined): string {
  const p = (phone ?? '').trim();
  if (!p) return 'Información no disponible';
  const digitos = p.replace(/\D/g, '');
  if (digitos.length <= 6) return '•••' + digitos.slice(-3);
  const prefijo = p.startsWith('+') ? p.slice(0, 4) : p.slice(0, 3);
  return `${prefijo}••••${p.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// Fechas y horas (es-PY)
// ---------------------------------------------------------------------------

export function toDateSafe(ts: unknown): Date | null {
  try {
    const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

export function hhmm(ts: unknown): string {
  const d = toDateSafe(ts);
  return d ? d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' }) : '';
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function ayerDe(now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return d;
}

/** Hora «inteligente» de la lista: hh:mm si es de hoy, «Ayer», o dd/mm. */
export function smartListTime(ts: unknown, now: Date = new Date()): string {
  const d = toDateSafe(ts);
  if (!d) return '';
  if (sameDay(d, now)) return d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, ayerDe(now))) return 'Ayer';
  return d.toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit' });
}

/** Rótulo del separador de fecha del historial: Hoy / Ayer / fecha completa es-PY. */
export function dayLabel(ts: unknown, now: Date = new Date()): string {
  const d = toDateSafe(ts);
  if (!d) return '';
  if (sameDay(d, now)) return 'Hoy';
  if (sameDay(d, ayerDe(now))) return 'Ayer';
  return d.toLocaleDateString('es-PY', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** ¿Hace falta separador de fecha ANTES de `actual`? (primer mensaje o cambio de día). */
export function needsDateSeparator(previo: Message | null | undefined, actual: Message): boolean {
  const dActual = toDateSafe(actual.createdAt);
  if (!dActual) return false;
  const dPrevio = previo ? toDateSafe(previo.createdAt) : null;
  if (!dPrevio) return true;
  return !sameDay(dPrevio, dActual);
}

// ---------------------------------------------------------------------------
// Filtros de la lista (client-side sobre la ventana cargada — ADR-0021, deuda aceptada)
// ---------------------------------------------------------------------------

export type ConversationFilter = 'todas' | 'noleidas' | 'mias' | 'bot' | 'humano' | 'archivadas' | 'eliminadas';

export const CONVERSATION_FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'noleidas', label: 'No leídas' },
  { key: 'mias', label: 'Mías' },
  { key: 'bot', label: 'Bot' },
  { key: 'humano', label: 'Atención humana' },
  { key: 'archivadas', label: 'Archivadas' },
  { key: 'eliminadas', label: 'Eliminadas' },
];

/** Mensaje del estado vacío por filtro (honesto y accionable). */
export const EMPTY_BY_FILTER: Record<ConversationFilter, string> = {
  todas: 'Sin conversaciones todavía. Aparecerán cuando un cliente escriba al bot.',
  noleidas: 'No hay conversaciones con mensajes sin leer. Todo al día.',
  mias: 'No tenés conversaciones asignadas todavía.',
  bot: 'Ninguna conversación está siendo atendida por el bot ahora.',
  humano: 'Ninguna conversación está tomada por un vendedor ahora.',
  archivadas: 'No hay conversaciones archivadas.',
  eliminadas: 'No hay conversaciones eliminadas.',
};

/**
 * Filtro + búsqueda client-side. Por defecto (todo filtro que no sea su chip dedicado) se
 * EXCLUYEN archivadas y eliminadas (ADR-0021 §3). El chip «Archivadas» no muestra eliminadas:
 * la eliminación lógica pesa más que el archivado.
 */
export function filterConversations(
  convs: readonly Customer[],
  filter: ConversationFilter,
  search: string,
  uid: string | null,
): Customer[] {
  const needle = search.trim().toLowerCase();
  return convs.filter((c) => {
    const conv = c.conversation;
    const archivada = !!conv?.archived;
    const eliminada = !!conv?.softDeleted;

    if (filter === 'eliminadas') {
      if (!eliminada) return false;
    } else if (filter === 'archivadas') {
      if (!archivada || eliminada) return false;
    } else {
      if (archivada || eliminada) return false;
    }

    if (filter === 'noleidas' && !((conv?.unreadForSeller ?? 0) > 0)) return false;
    if (filter === 'mias' && (!uid || c.assignedSellerId !== uid)) return false;
    if (filter === 'bot' && conv?.humanTakeover) return false;
    if (filter === 'humano' && !conv?.humanTakeover) return false;

    if (needle) {
      const campos = [c.name, c.profileName, c.whatsappPhone, conv?.lastMessagePreview];
      if (!campos.some((v) => (v ?? '').toLowerCase().includes(needle))) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Ticks de entrega (ADR-0021 §1 — solo salientes, nunca inferidos)
// ---------------------------------------------------------------------------

export interface DeliveryTickUi {
  status: MessageDeliveryStatus;
  glyph: string;
  /** Texto accesible (NUNCA solo color): aria-label + title. */
  label: string;
  /** true = «leído»: mismo glifo que entregado pero con color de acento. */
  accent: boolean;
  failed: boolean;
}

/**
 * Tick a mostrar para un mensaje. `null` = no se muestra nada: entrantes, mensajes históricos
 * sin estado, y salientes retenidos por mock (el « · retenido (prueba)» existente ya lo cubre).
 */
export function deliveryTick(
  m: Pick<Message, 'direction' | 'deliveryStatus' | 'viaMock'>,
): DeliveryTickUi | null {
  if (m.direction !== 'out' || !m.deliveryStatus || m.viaMock) return null;
  switch (m.deliveryStatus) {
    case 'pending':
      return { status: 'pending', glyph: '🕓', label: 'Enviando…', accent: false, failed: false };
    case 'sent':
      return { status: 'sent', glyph: '✓', label: 'Enviado', accent: false, failed: false };
    case 'delivered':
      return { status: 'delivered', glyph: '✓✓', label: 'Entregado', accent: false, failed: false };
    case 'read':
      return { status: 'read', glyph: '✓✓', label: 'Leído', accent: true, failed: false };
    case 'failed':
      return { status: 'failed', glyph: '⚠', label: 'No se pudo entregar', accent: false, failed: true };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Matriz de permisos (ADR-0021 §7 — el server manda; la UI la espeja)
// ---------------------------------------------------------------------------

const STAFF_CONVERSACIONES: readonly Role[] = ['SELLER', 'TENANT_MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN'];
const GESTION: readonly Role[] = ['TENANT_MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN'];

/** Ver módulo / leer conversaciones y mensajes. VIEWER queda fuera. */
export const puedeVerConversaciones = (role: Role | null | undefined): boolean =>
  !!role && STAFF_CONVERSACIONES.includes(role);

/** Tomar / devolver al bot; marcar leído; archivar / desarchivar. */
export const puedeTomarConversacion = puedeVerConversaciones;
export const puedeMarcarLeido = puedeVerConversaciones;
export const puedeArchivarConversacion = puedeVerConversaciones;

/** Enviar SIN takeover (override). El SELLER necesita takeover propio. */
export const puedeEnviarSinTakeover = (role: Role | null | undefined): boolean =>
  !!role && GESTION.includes(role);

/** Eliminar lógico / restaurar. */
export const puedeEliminarConversacion = puedeEnviarSinTakeover;
/** Asignar vendedor. */
export const puedeAsignarVendedor = puedeEnviarSinTakeover;
/** Vincular / crear / desvincular cliente. */
export const puedeVincularCliente = puedeEnviarSinTakeover;

/** ¿El compositor puede enviar? SELLER con takeover; MANAGER/OWNER/ADMIN siempre (override). */
export function puedeEscribir(role: Role | null | undefined, humanTakeover: boolean): boolean {
  if (!puedeVerConversaciones(role)) return false;
  return humanTakeover || puedeEnviarSinTakeover(role);
}

// ---------------------------------------------------------------------------
// Borrador local por conversación (localStorage `draft:{tenantId}:{customerId}`)
// ---------------------------------------------------------------------------

export const draftKey = (tenantId: string, customerId: string): string => `draft:${tenantId}:${customerId}`;

export function loadDraft(tenantId: string, customerId: string): string {
  try {
    return window.localStorage.getItem(draftKey(tenantId, customerId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(tenantId: string, customerId: string, text: string): void {
  try {
    if (text) window.localStorage.setItem(draftKey(tenantId, customerId), text);
    else window.localStorage.removeItem(draftKey(tenantId, customerId));
  } catch {
    /* almacenamiento lleno o bloqueado: el borrador es best-effort, nunca rompe el chat */
  }
}

export function clearDraft(tenantId: string, customerId: string): void {
  try {
    window.localStorage.removeItem(draftKey(tenantId, customerId));
  } catch {
    /* idem */
  }
}

/**
 * B5: al CERRAR SESIÓN se borran TODOS los borradores (`draft:*`, de cualquier tenant): son
 * texto de negocio y no pueden quedar legibles en una máquina compartida. No toca otras claves.
 */
export function limpiarBorradores(): void {
  try {
    const claves: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('draft:')) claves.push(k);
    }
    for (const k of claves) window.localStorage.removeItem(k);
  } catch {
    /* best-effort: cerrar sesión nunca falla por el almacenamiento */
  }
}

// ---------------------------------------------------------------------------
// Validación CLIENT de adjuntos salientes (espejo del server — ADR-0021 §5)
// ---------------------------------------------------------------------------

export const COMPOSER_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const COMPOSER_DOCUMENT_TYPES = ['application/pdf'] as const;
export const COMPOSER_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const COMPOSER_DOCUMENT_MAX_BYTES = 7 * 1024 * 1024; // 7 MB

export type ComposerFileCheck =
  | { ok: true; kind: 'image' | 'document' }
  | { ok: false; error: string };

/**
 * Validación espejo del server (la autoridad sigue siendo el callable, que verifica magic
 * bytes). Acá solo se evita subir algo que va a ser rechazado seguro.
 */
export function validateComposerFile(f: { type: string; size: number }): ComposerFileCheck {
  const esImagen = (COMPOSER_IMAGE_TYPES as readonly string[]).includes(f.type);
  const esDocumento = (COMPOSER_DOCUMENT_TYPES as readonly string[]).includes(f.type);
  if (!esImagen && !esDocumento) {
    return { ok: false, error: 'Formato no permitido. Podés enviar fotos JPG, PNG o WEBP, o un PDF.' };
  }
  if (esImagen && f.size > COMPOSER_IMAGE_MAX_BYTES) {
    return { ok: false, error: 'La imagen supera el máximo de 5 MB. Achicala e intentá de nuevo.' };
  }
  if (esDocumento && f.size > COMPOSER_DOCUMENT_MAX_BYTES) {
    return { ok: false, error: 'El documento supera el máximo de 7 MB.' };
  }
  return { ok: true, kind: esImagen ? 'image' : 'document' };
}

// ---------------------------------------------------------------------------
// Ventanas de mensajes (paginación hacia atrás sin duplicados)
// ---------------------------------------------------------------------------

/**
 * Une la ventana de páginas VIEJAS (paginación hacia atrás) con la ventana VIVA (polling de los
 * últimos N) sin duplicar ids: si el polling se solapa con lo ya paginado, gana la primera
 * aparición (orden cronológico: viejas primero).
 */
export function mergeMessageWindows(older: readonly Message[], latest: readonly Message[]): Message[] {
  const vistos = new Set<string>();
  const out: Message[] = [];
  for (const m of [...older, ...latest]) {
    if (m.id) {
      if (vistos.has(m.id)) continue;
      vistos.add(m.id);
    }
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errores de envío de adjuntos → mensajes honestos y accionables
// ---------------------------------------------------------------------------

/** Mapea el HttpsError del callable `conversationSendAttachment` a texto claro es-PY. */
export function friendlySendAttachmentError(e: unknown): string {
  const err = e as { code?: string; message?: string; details?: { code?: string } } | null;
  const code = err?.code ?? '';
  const detailCode = err?.details?.code ?? '';
  const msg = err?.message ?? '';
  if (detailCode === 'channel_send_unsupported' || msg.includes('channel_send_unsupported')) {
    return 'Esta conversación llegó por un canal que todavía no admite envíos desde el panel.';
  }
  if (detailCode === 'shipping_quote_required' || msg.includes('shipping_quote_required')) {
    return 'Antes de enviar, confirmá la cotización de envío pendiente de esta conversación.';
  }
  if (detailCode === 'operation_in_flight' || msg.includes('operation_in_flight')) {
    return 'Ya hay un envío de este archivo en curso. Esperá unos segundos y fijate el historial.';
  }
  if (code === 'functions/resource-exhausted') {
    return 'El archivo supera el tamaño permitido por el servidor.';
  }
  if (code === 'functions/invalid-argument') {
    return msg.trim() || 'El servidor rechazó el archivo (formato o datos inválidos).';
  }
  if (code === 'functions/permission-denied') {
    return 'No tenés permiso para enviar archivos en esta conversación.';
  }
  return msg.trim() || 'No se pudo enviar el archivo. Revisá tu conexión y reintentá.';
}

// ---------------------------------------------------------------------------
// Canales
// ---------------------------------------------------------------------------

export const CHANNEL_ICON: Record<string, string> = { whatsapp: '🟢', instagram: '📸', messenger: '📨' };

export const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  messenger: 'Messenger',
};

/** ¿El canal admite envío saliente desde el panel? Solo WhatsApp (ADR-0021 §6, fail-closed). */
export function canalPermiteEnvio(channel: MessageChannel | undefined): boolean {
  return (channel ?? 'whatsapp') === 'whatsapp';
}
