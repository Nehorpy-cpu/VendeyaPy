/**
 * conversationsUi.test.ts — reglas puras de la bandeja profesional (ADR-0021).
 * Separadores de fecha, hora inteligente, filtros (archivadas/eliminadas ocultas por defecto),
 * enmascarado de teléfono, iniciales/color de avatar, ticks de entrega, borrador local,
 * validación client de adjuntos y merge de ventanas de mensajes sin duplicados.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Customer, Message } from '@vpw/shared';
import {
  AVATAR_PALETTE,
  avatarPaletteIndex,
  clearDraft,
  conversationDisplayName,
  dayLabel,
  deliveryTick,
  draftKey,
  filterConversations,
  initialsFor,
  limpiarBorradores,
  loadDraft,
  maskPhone,
  mergeMessageWindows,
  needsDateSeparator,
  puedeEliminarConversacion,
  puedeAsignarVendedor,
  puedeArchivarConversacion,
  puedeEscribir,
  puedeVerConversaciones,
  puedeVincularCliente,
  saveDraft,
  smartListTime,
  validateComposerFile,
  canalPermiteEnvio,
  friendlySendAttachmentError,
} from './conversationsUi';

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });

function conv(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Customer {
  return {
    id: '595981000001',
    tenantId: 't1',
    whatsappPhone: '+595981000001',
    name: '',
    conversation: {
      lastMessageAt: null,
      lastMessagePreview: 'hola',
      lastMessageDirection: 'in',
      state: null,
      humanTakeover: false,
      unreadForSeller: 0,
      ...meta,
    },
    ...over,
  } as unknown as Customer;
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    tenantId: 't1',
    customerId: 'c1',
    direction: 'in',
    author: 'customer',
    text: 'hola',
    createdAt: ts(new Date(2026, 7, 18, 10, 0)),
    ...over,
  } as Message;
}

describe('identidad visible', () => {
  it('prioridad name (CRM) → profileName → teléfono', () => {
    expect(conversationDisplayName({ id: 'x', name: 'Ana CRM', profileName: 'Ani', whatsappPhone: '+595981' })).toBe('Ana CRM');
    expect(conversationDisplayName({ id: 'x', name: '  ', profileName: '', whatsappPhone: '+595981' })).toBe('+595981');
    expect(conversationDisplayName({ id: 'x', name: '', profileName: null, whatsappPhone: '' })).toBe('x');
  });

  it('P3: el nombre de PERFIL (lo escribe el cliente) se muestra con «~»; el CRM nunca', () => {
    // «Soporte VendeYa» como profileName no puede leerse igual que un nombre CRM confirmado.
    expect(conversationDisplayName({ id: 'x', name: '', profileName: 'Rocío García', whatsappPhone: '+595981' })).toBe('~Rocío García');
    expect(conversationDisplayName({ id: 'x', name: '', profileName: 'Ani', whatsappPhone: '+595981' })).toBe('~Ani');
    expect(conversationDisplayName({ id: 'x', name: 'Ana CRM', profileName: 'Ani', whatsappPhone: '' })).toBe('Ana CRM');
  });

  it('iniciales: dos palabras → dos letras; una palabra → una; teléfono → últimos 2 dígitos', () => {
    expect(initialsFor('María González')).toBe('MG');
    expect(initialsFor('maría de los ángeles')).toBe('MD');
    expect(initialsFor('Ana')).toBe('A');
    expect(initialsFor('+595 981 000 123')).toBe('23');
    expect(initialsFor('')).toBe('?');
  });

  it('P3: la tilde «~» del nombre de perfil NO entra en las iniciales', () => {
    expect(initialsFor('~Rocío García')).toBe('RG');
    expect(initialsFor('~Ani')).toBe('A');
  });

  it('color de avatar determinístico y dentro de la paleta', () => {
    const i = avatarPaletteIndex('595981000001');
    expect(i).toBe(avatarPaletteIndex('595981000001')); // mismo id ⇒ mismo color
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(AVATAR_PALETTE.length);
  });

  it('teléfono ENMASCARADO: prefijo + últimos 3, nunca el número entero', () => {
    const m = maskPhone('+595981123456');
    expect(m).toBe('+595••••456');
    expect(m).not.toContain('123456');
    expect(maskPhone('')).toBe('Información no disponible');
    expect(maskPhone('12345')).toBe('•••345');
  });
});

describe('fechas y horas', () => {
  const now = new Date(2026, 7, 18, 15, 0); // 18/08/2026

  it('smartListTime: hoy → hh:mm, ayer → «Ayer», antes → dd/mm', () => {
    expect(smartListTime(ts(new Date(2026, 7, 18, 9, 5)), now)).toMatch(/09:05|9:05/);
    expect(smartListTime(ts(new Date(2026, 7, 17, 23, 59)), now)).toBe('Ayer');
    expect(smartListTime(ts(new Date(2026, 7, 10, 12, 0)), now)).toBe(new Date(2026, 7, 10).toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit' }));
    expect(smartListTime(null, now)).toBe('');
  });

  it('dayLabel: Hoy / Ayer / fecha completa es-PY', () => {
    expect(dayLabel(ts(new Date(2026, 7, 18, 1, 0)), now)).toBe('Hoy');
    expect(dayLabel(ts(new Date(2026, 7, 17, 1, 0)), now)).toBe('Ayer');
    const vieja = new Date(2026, 6, 2);
    expect(dayLabel(ts(vieja), now)).toBe(vieja.toLocaleDateString('es-PY', { day: 'numeric', month: 'long', year: 'numeric' }));
  });

  it('needsDateSeparator: primer mensaje sí; mismo día no; cambio de día sí', () => {
    const a = msg({ id: 'a', createdAt: ts(new Date(2026, 7, 17, 10, 0)) as never });
    const b = msg({ id: 'b', createdAt: ts(new Date(2026, 7, 17, 18, 0)) as never });
    const c = msg({ id: 'c', createdAt: ts(new Date(2026, 7, 18, 9, 0)) as never });
    expect(needsDateSeparator(null, a)).toBe(true);
    expect(needsDateSeparator(a, b)).toBe(false);
    expect(needsDateSeparator(b, c)).toBe(true);
  });
});

describe('filtros de la lista (ADR-0021 §3)', () => {
  const normal = conv({ id: 'n1', name: 'Normal' });
  const noLeida = conv({ id: 'n2', name: 'ConUnread' }, { unreadForSeller: 3 });
  const mia = conv({ id: 'n3', name: 'Mía', assignedSellerId: 'yo' });
  const tomada = conv({ id: 'n4', name: 'Humana' }, { humanTakeover: true });
  const archivada = conv({ id: 'n5', name: 'Archivada' }, { archived: true });
  const eliminada = conv({ id: 'n6', name: 'Eliminada' }, { softDeleted: true });
  const archivadaYEliminada = conv({ id: 'n7', name: 'ArchYElim' }, { archived: true, softDeleted: true });
  const todas = [normal, noLeida, mia, tomada, archivada, eliminada, archivadaYEliminada];

  it('por defecto EXCLUYE archivadas y eliminadas', () => {
    const ids = filterConversations(todas, 'todas', '', 'yo').map((c) => c.id);
    expect(ids).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('«No leídas»: solo unreadForSeller > 0 (y nunca archivadas/eliminadas)', () => {
    expect(filterConversations(todas, 'noleidas', '', 'yo').map((c) => c.id)).toEqual(['n2']);
  });

  it('«Mías»: solo asignadas a mi uid', () => {
    expect(filterConversations(todas, 'mias', '', 'yo').map((c) => c.id)).toEqual(['n3']);
    expect(filterConversations(todas, 'mias', '', null)).toEqual([]);
  });

  it('«Bot» y «Atención humana» parten por humanTakeover', () => {
    expect(filterConversations(todas, 'bot', '', 'yo').map((c) => c.id)).toEqual(['n1', 'n2', 'n3']);
    expect(filterConversations(todas, 'humano', '', 'yo').map((c) => c.id)).toEqual(['n4']);
  });

  it('«Archivadas» muestra SOLO archivadas no eliminadas; «Eliminadas» solo eliminadas', () => {
    expect(filterConversations(todas, 'archivadas', '', 'yo').map((c) => c.id)).toEqual(['n5']);
    expect(filterConversations(todas, 'eliminadas', '', 'yo').map((c) => c.id)).toEqual(['n6', 'n7']);
  });

  it('búsqueda por nombre, profileName, teléfono y preview', () => {
    const perfil = conv({ id: 'p1', name: '', profileName: 'Rosa Perfil' });
    const tel = conv({ id: 'p2', whatsappPhone: '+595971555444' });
    const preview = conv({ id: 'p3' }, { lastMessagePreview: 'quiero el perfume floral' });
    const lista = [perfil, tel, preview];
    expect(filterConversations(lista, 'todas', 'rosa', null).map((c) => c.id)).toEqual(['p1']);
    expect(filterConversations(lista, 'todas', '555444', null).map((c) => c.id)).toEqual(['p2']);
    expect(filterConversations(lista, 'todas', 'floral', null).map((c) => c.id)).toEqual(['p3']);
    expect(filterConversations(lista, 'todas', 'nadaqver', null)).toEqual([]);
  });
});

describe('ticks de entrega (ADR-0021 §1)', () => {
  it('mapea cada estado a glifo + label textual', () => {
    const base = { direction: 'out' as const, viaMock: false };
    expect(deliveryTick({ ...base, deliveryStatus: 'pending' })?.label).toBe('Enviando…');
    expect(deliveryTick({ ...base, deliveryStatus: 'sent' })).toMatchObject({ glyph: '✓', label: 'Enviado', accent: false });
    expect(deliveryTick({ ...base, deliveryStatus: 'delivered' })).toMatchObject({ glyph: '✓✓', label: 'Entregado', accent: false });
    expect(deliveryTick({ ...base, deliveryStatus: 'read' })).toMatchObject({ glyph: '✓✓', label: 'Leído', accent: true });
    expect(deliveryTick({ ...base, deliveryStatus: 'failed' })).toMatchObject({ label: 'No se pudo entregar', failed: true });
  });

  it('NUNCA en entrantes, históricos sin estado ni retenidos por mock', () => {
    expect(deliveryTick({ direction: 'in', deliveryStatus: 'read', viaMock: false })).toBeNull();
    expect(deliveryTick({ direction: 'out', viaMock: false })).toBeNull();
    expect(deliveryTick({ direction: 'out', deliveryStatus: 'sent', viaMock: true })).toBeNull();
  });
});

describe('matriz de permisos §7 (espejo UI)', () => {
  it('VIEWER: nada; SELLER: ver/tomar/archivar pero NO eliminar/asignar/vincular', () => {
    expect(puedeVerConversaciones('TENANT_VIEWER')).toBe(false);
    expect(puedeVerConversaciones('SELLER')).toBe(true);
    expect(puedeArchivarConversacion('SELLER')).toBe(true);
    expect(puedeEliminarConversacion('SELLER')).toBe(false);
    expect(puedeAsignarVendedor('SELLER')).toBe(false);
    expect(puedeVincularCliente('SELLER')).toBe(false);
  });

  it('MANAGER/OWNER/ADMIN: gestión completa', () => {
    for (const r of ['TENANT_MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN'] as const) {
      expect(puedeEliminarConversacion(r)).toBe(true);
      expect(puedeAsignarVendedor(r)).toBe(true);
      expect(puedeVincularCliente(r)).toBe(true);
    }
  });

  it('escribir: SELLER solo con takeover; MANAGER+ con override sin takeover', () => {
    expect(puedeEscribir('SELLER', true)).toBe(true);
    expect(puedeEscribir('SELLER', false)).toBe(false);
    expect(puedeEscribir('TENANT_MANAGER', false)).toBe(true);
    expect(puedeEscribir('TENANT_VIEWER', true)).toBe(false);
    expect(puedeEscribir(null, true)).toBe(false);
  });
});

describe('borrador local por conversación', () => {
  beforeEach(() => window.localStorage.clear());

  it('clave draft:{tenantId}:{customerId}; guardar → restaurar → limpiar', () => {
    expect(draftKey('t1', 'c1')).toBe('draft:t1:c1');
    saveDraft('t1', 'c1', 'hola che');
    expect(loadDraft('t1', 'c1')).toBe('hola che');
    expect(loadDraft('t1', 'OTRA')).toBe(''); // no se cruza entre conversaciones
    clearDraft('t1', 'c1');
    expect(loadDraft('t1', 'c1')).toBe('');
  });

  it('guardar texto vacío elimina la clave (no deja basura)', () => {
    saveDraft('t1', 'c1', 'algo');
    saveDraft('t1', 'c1', '');
    expect(window.localStorage.getItem('draft:t1:c1')).toBeNull();
  });

  it('B5: limpiarBorradores borra TODOS los draft:* (cualquier tenant) y no toca otras claves', () => {
    saveDraft('t1', 'c1', 'hola');
    saveDraft('t2', 'c9', 'texto de otro tenant');
    window.localStorage.setItem('otraClave', 'se queda');
    window.localStorage.setItem('draftless', 'también se queda'); // no empieza con draft:
    limpiarBorradores();
    expect(window.localStorage.getItem('draft:t1:c1')).toBeNull();
    expect(window.localStorage.getItem('draft:t2:c9')).toBeNull();
    expect(window.localStorage.getItem('otraClave')).toBe('se queda');
    expect(window.localStorage.getItem('draftless')).toBe('también se queda');
  });
});

describe('validación client de adjuntos (espejo del server, ADR-0021 §5)', () => {
  it('acepta jpeg/png/webp ≤5MB y pdf ≤7MB', () => {
    expect(validateComposerFile({ type: 'image/jpeg', size: 1024 })).toEqual({ ok: true, kind: 'image' });
    expect(validateComposerFile({ type: 'image/webp', size: 5 * 1024 * 1024 })).toEqual({ ok: true, kind: 'image' });
    expect(validateComposerFile({ type: 'application/pdf', size: 7 * 1024 * 1024 })).toEqual({ ok: true, kind: 'document' });
  });

  it('rechaza tipos fuera de la allowlist con mensaje claro', () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/zip', 'video/mp4']) {
      const r = validateComposerFile({ type, size: 10 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Formato no permitido/);
    }
  });

  it('rechaza tamaños excedidos con el límite correcto en el mensaje', () => {
    const img = validateComposerFile({ type: 'image/png', size: 5 * 1024 * 1024 + 1 });
    expect(img.ok).toBe(false);
    if (!img.ok) expect(img.error).toMatch(/5 MB/);
    const doc = validateComposerFile({ type: 'application/pdf', size: 7 * 1024 * 1024 + 1 });
    expect(doc.ok).toBe(false);
    if (!doc.ok) expect(doc.error).toMatch(/7 MB/);
  });
});

describe('mergeMessageWindows (paginación sin duplicados)', () => {
  it('concatena viejas + vivas y descarta ids repetidos conservando el orden', () => {
    const viejas = [msg({ id: 'a' }), msg({ id: 'b' })];
    const vivas = [msg({ id: 'b' }), msg({ id: 'c' })];
    expect(mergeMessageWindows(viejas, vivas).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('con ventanas disjuntas no pierde nada', () => {
    expect(mergeMessageWindows([msg({ id: 'a' })], [msg({ id: 'z' })]).map((m) => m.id)).toEqual(['a', 'z']);
  });
});

describe('canales y errores de envío', () => {
  it('solo WhatsApp admite envío; IG/Messenger quedan de solo lectura', () => {
    expect(canalPermiteEnvio('whatsapp')).toBe(true);
    expect(canalPermiteEnvio(undefined)).toBe(true); // default histórico
    expect(canalPermiteEnvio('instagram')).toBe(false);
    expect(canalPermiteEnvio('messenger')).toBe(false);
  });

  it('friendlySendAttachmentError traduce los codes del contrato', () => {
    expect(friendlySendAttachmentError({ code: 'functions/failed-precondition', message: 'x', details: { code: 'channel_send_unsupported' } })).toMatch(/canal/);
    expect(friendlySendAttachmentError({ code: 'functions/failed-precondition', message: 'shipping_quote_required' })).toMatch(/cotización/);
    expect(friendlySendAttachmentError({ code: 'functions/failed-precondition', message: 'operation_in_flight' })).toMatch(/en curso/);
    expect(friendlySendAttachmentError({ code: 'functions/resource-exhausted', message: '' })).toMatch(/tamaño/);
    expect(friendlySendAttachmentError(new Error('otra cosa'))).toBe('otra cosa');
  });
});
