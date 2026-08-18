/**
 * conversation/linking.ts — Vínculo conversación ↔ ficha de cliente + búsqueda (ADR-0021 §4)
 * ===========================================================================================
 * La identidad de una conversación es `customerId == número`. `linkedClientId` apunta a OTRO doc
 * de `customers` del MISMO tenant que actúa como ficha canónica (dos números de la misma persona,
 * o una ficha CRM creada a mano con id `crm_<autoid>`). Reglas que este módulo sostiene:
 *
 *  1. PERMISOS (§7): vincular/crear/desvincular = solo TENANT_MANAGER/TENANT_OWNER/PLATFORM_ADMIN.
 *  2. BLOQUEOS, verificados DENTRO de la transacción (el destino se relee en la tx — un
 *     softDelete o un vínculo concurrente no puede colarse entre la validación y la escritura):
 *     destino inexistente ⇒ `client_not_found`; destino softDeleted ⇒ `client_deleted`;
 *     auto-vínculo ⇒ invalid-argument; destino a su vez vinculado (CADENA) ⇒
 *     `client_already_linked`. Cross-tenant: imposible por construcción de ruta + staffAuth.
 *  3. createClient: la ficha nace con `name` CONFIRMADO obligatorio (saneado), sin teléfono, sin
 *     `conversation` (es una ficha, no una bandeja), y el vínculo sale en la MISMA operación
 *     atómica — no existe el estado intermedio "ficha creada pero sin vincular".
 *  4. BÚSQUEDA server-side (§4): dos consultas por PREFIJO con índices single-field automáticos
 *     (SIN índices compuestos): siempre por `name`, y por `whatsappPhone` solo si la query es
 *     numérica. Fusión sin duplicados, softDeleted excluidos, `limit` con clamp y cursor OPACO.
 *
 * `db` viaja como parámetro (patrón de deliveryStatus.ts) para testear sin emulador.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore, Query, Transaction } from 'firebase-admin/firestore';
import { paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { maskPhone } from '@vpw/shared';
import { assertRolPrivilegiado, type ConversationActor } from './lifecycle.js';

export interface LinkResult {
  ok: true;
  /** false = ya estaba exactamente así (no-op idempotente, sin escritura ni audit). */
  changed: boolean;
}

/** Tope del `name` confirmado de una ficha creada a mano (se RECORTA, no se rechaza). */
export const CREATE_CLIENT_NAME_MAX_CHARS = 120;
/** Tope de las notas opcionales de la ficha. */
export const CREATE_CLIENT_NOTES_MAX_CHARS = 1000;

interface CustomerLinkView {
  linkedClientId?: string | null;
  conversation?: { softDeleted?: unknown };
}

/**
 * Bloqueos del SOURCE, compartidos por vincular y crear+vincular (dentro de la MISMA tx):
 *  - B3: una conversación softDeleted no puede recibir vínculos nuevos (coherente con que el
 *    envío manual también se bloquea): primero se restaura.
 *  - M1 (cadena INVERSA): si el source ya es la ficha CANÓNICA de otras conversaciones
 *    (alguien tiene `linkedClientId == customerId`), vincularlo a su vez crearía A→B→C. La
 *    consulta usa el índice single-field automático de `linkedClientId` — sin índices nuevos.
 */
async function assertSourceVinculable(
  dbi: Firestore,
  tx: Transaction,
  tenantId: string,
  customerId: string,
  source: CustomerLinkView | undefined,
): Promise<void> {
  if (source?.conversation?.softDeleted === true) {
    throw new HttpsError('failed-precondition', 'Esta conversación está eliminada. Restaurala antes de vincular.', {
      kind: 'conversation_deleted',
    });
  }
  const inbound = await tx.get(
    dbi.collection(paths.customers(tenantId)).where('linkedClientId', '==', customerId).limit(1),
  );
  if (!inbound.empty) {
    throw new HttpsError(
      'failed-precondition',
      'Esta conversación ya es la ficha canónica de otras: no puede vincularse a su vez.',
      { kind: 'client_is_canonical' },
    );
  }
}

export async function linkConversationToClient(
  dbi: Firestore,
  args: { tenantId: string; customerId: string; clientId: string },
  actor: ConversationActor,
): Promise<LinkResult> {
  assertRolPrivilegiado(actor, 'vincular clientes');
  const { tenantId, customerId, clientId } = args;
  if (clientId === customerId) {
    throw new HttpsError('invalid-argument', 'Una conversación no puede vincularse a sí misma.');
  }

  const sourceRef = dbi.doc(paths.customer(tenantId, customerId));
  const targetRef = dbi.doc(paths.customer(tenantId, clientId));
  const now = Timestamp.now();

  const changed = await dbi.runTransaction<boolean>(async (tx) => {
    const [sourceSnap, targetSnap] = [await tx.get(sourceRef), await tx.get(targetRef)];
    if (!sourceSnap.exists) throw new HttpsError('not-found', 'Esa conversación no existe.');
    await assertSourceVinculable(dbi, tx, tenantId, customerId, sourceSnap.data() as CustomerLinkView | undefined);
    if (!targetSnap.exists) {
      throw new HttpsError('not-found', 'Esa ficha de cliente no existe.', { kind: 'client_not_found' });
    }
    const target = (targetSnap.data() ?? {}) as CustomerLinkView;
    if (target.conversation?.softDeleted === true) {
      throw new HttpsError('failed-precondition', 'Esa ficha está eliminada: restaurala antes de vincular.', {
        kind: 'client_deleted',
      });
    }
    // SIN CADENAS: si el destino ya apunta a otra ficha, vincularse a él crearía A→B→C y el
    // panel tendría que resolver vínculos transitivos. Se rechaza: que vinculen a la canónica.
    if (typeof target.linkedClientId === 'string' && target.linkedClientId !== '') {
      throw new HttpsError('failed-precondition', 'Esa ficha ya está vinculada a otra: vinculá directamente a la ficha canónica.', {
        kind: 'client_already_linked',
      });
    }

    const source = (sourceSnap.data() ?? {}) as CustomerLinkView;
    if ((source.linkedClientId ?? null) === clientId) return false; // idempotente

    tx.set(sourceRef, { id: customerId, tenantId, linkedClientId: clientId, updatedAt: now }, { merge: true });
    return true;
  });

  if (changed) {
    logger.info('Conversación vinculada a ficha de cliente', {
      tenantId,
      customerId: maskPhone(customerId),
      clientId,
    });
  }
  return { ok: true, changed };
}

export async function unlinkConversationClient(
  dbi: Firestore,
  args: { tenantId: string; customerId: string },
  actor: ConversationActor,
): Promise<LinkResult> {
  assertRolPrivilegiado(actor, 'desvincular clientes');
  const { tenantId, customerId } = args;
  const ref = dbi.doc(paths.customer(tenantId, customerId));
  const now = Timestamp.now();

  const changed = await dbi.runTransaction<boolean>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Esa conversación no existe.');
    const vigente = ((snap.data() ?? {}) as CustomerLinkView).linkedClientId ?? null;
    if (vigente === null) return false; // idempotente
    tx.set(ref, { id: customerId, tenantId, linkedClientId: null, updatedAt: now }, { merge: true });
    return true;
  });
  return { ok: true, changed };
}

export interface CreateClientResult {
  ok: true;
  clientId: string;
}

/** Colapsa espacios y recorta al tope. Devuelve '' si no queda nada con contenido. */
const sanearTexto = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/**
 * Crea una ficha CRM desde datos CONFIRMADOS (id `crm_<autoid>`, jamás derivado del teléfono) y
 * la vincula a la conversación EN LA MISMA transacción.
 */
export async function createAndLinkClient(
  dbi: Firestore,
  args: { tenantId: string; customerId: string; name: string; notes?: string },
  actor: ConversationActor,
): Promise<CreateClientResult> {
  assertRolPrivilegiado(actor, 'crear fichas de cliente');
  const { tenantId, customerId } = args;
  const name = sanearTexto(args.name, CREATE_CLIENT_NAME_MAX_CHARS);
  if (name === '') throw new HttpsError('invalid-argument', 'Escribí el nombre del cliente.');
  const notes = sanearTexto(args.notes, CREATE_CLIENT_NOTES_MAX_CHARS);

  // Id nuevo ANTES de la tx (generar ids no lee nada). `crm_` lo distingue de los ids-teléfono.
  const clientId = `crm_${dbi.collection(paths.customers(tenantId)).doc().id}`;
  const sourceRef = dbi.doc(paths.customer(tenantId, customerId));
  const targetRef = dbi.doc(paths.customer(tenantId, clientId));
  const now = Timestamp.now();

  await dbi.runTransaction(async (tx) => {
    const sourceSnap = await tx.get(sourceRef);
    if (!sourceSnap.exists) throw new HttpsError('not-found', 'Esa conversación no existe.');
    // MISMOS bloqueos del source que en el vínculo directo (B3 + cadena inversa M1): crear la
    // ficha sortearía los checks si no se verificara acá también.
    await assertSourceVinculable(dbi, tx, tenantId, customerId, sourceSnap.data() as CustomerLinkView | undefined);

    // Ficha CRM: SIN `conversation` (no es una bandeja) y SIN teléfono (no hay número confirmado).
    // `create()` (no set): si el autoid colisionara, la tx falla en vez de pisar una ficha ajena.
    tx.create(targetRef, {
      id: clientId,
      tenantId,
      whatsappPhone: '',
      name,
      address: null,
      stats: { totalOrders: 0, totalSpent: 0, lastOrderAt: null, firstOrderAt: null },
      tags: [],
      notes,
      createdAt: now,
      updatedAt: now,
    });
    tx.set(sourceRef, { id: customerId, tenantId, linkedClientId: clientId, updatedAt: now }, { merge: true });
  });

  logger.info('Ficha de cliente creada y vinculada', { tenantId, customerId: maskPhone(customerId), clientId });
  return { ok: true, clientId };
}

// ---------------------------------------------------------------------------
// Búsqueda server-side de clientes (ADR-0021 §4)
// ---------------------------------------------------------------------------

export const CUSTOMER_SEARCH_DEFAULT_LIMIT = 10;
export const CUSTOMER_SEARCH_MAX_LIMIT = 20;
export const CUSTOMER_SEARCH_MAX_QUERY_CHARS = 64;

export interface CustomerSearchItem {
  id: string;
  name: string;
  profileName?: string;
  whatsappPhone: string;
}

export interface CustomerSearchResult {
  items: CustomerSearchItem[];
  nextCursor?: string;
}

/**
 * Cursor OPACO por fuente: `n` = seguir la consulta por nombre después de este valor; `p` = ídem
 * teléfono. La AUSENCIA de una clave significa "esa fuente ya se agotó" — así la página siguiente
 * no re-consulta desde cero (duplicaría) ni inventa continuaciones.
 */
interface SearchCursor {
  n?: string;
  p?: string;
}

const encodeCursor = (c: SearchCursor): string => Buffer.from(JSON.stringify(c), 'utf8').toString('base64');

function decodeCursor(raw: string): SearchCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('forma inválida');
    const { n, p } = parsed as SearchCursor;
    if (n !== undefined && typeof n !== 'string') throw new Error('n inválido');
    if (p !== undefined && typeof p !== 'string') throw new Error('p inválido');
    return { ...(n !== undefined ? { n } : {}), ...(p !== undefined ? { p } : {}) };
  } catch {
    throw new HttpsError('invalid-argument', 'Cursor de búsqueda inválido.');
  }
}

interface RawRow {
  id: string;
  data: () => Record<string, unknown> | undefined;
}

/** Una página de UNA fuente: hasta `limit` filas + si quedan más después de la última consumida. */
async function paginaDeFuente(query: Query, limit: number): Promise<{ rows: RawRow[]; hasMore: boolean }> {
  const snap = await query.limit(limit + 1).get();
  const docs = snap.docs as unknown as RawRow[];
  return { rows: docs.slice(0, limit), hasMore: docs.length > limit };
}

/**
 * Búsqueda por prefijo de nombre y (si la query es numérica) de teléfono. El `tenantId` ya viene
 * validado por staffAuth: acá solo se construye la ruta del tenant — jamás una colección global.
 */
export async function searchCustomers(
  dbi: Firestore,
  args: { tenantId: string; query: string; limit?: number; cursor?: string },
): Promise<CustomerSearchResult> {
  const q = sanearTexto(args.query, CUSTOMER_SEARCH_MAX_QUERY_CHARS);
  if (q === '') throw new HttpsError('invalid-argument', 'Escribí algo para buscar.');

  const limit = Math.min(
    CUSTOMER_SEARCH_MAX_LIMIT,
    Math.max(1, Number.isFinite(args.limit as number) ? Math.floor(args.limit as number) : CUSTOMER_SEARCH_DEFAULT_LIMIT),
  );
  const cursor: SearchCursor | null = args.cursor !== undefined ? decodeCursor(args.cursor) : null;

  // Query "numérica" = solo caracteres de teléfono; se busca por SUS DÍGITOS (los teléfonos se
  // persisten a dígitos). 'Mar' jamás dispara la consulta por teléfono.
  const digits = q.replace(/[^0-9]/g, '');
  const esNumerica = digits !== '' && /^[+()0-9\s.-]+$/.test(q);

  const col = dbi.collection(paths.customers(args.tenantId));

  // Con cursor, cada fuente continúa SOLO si su clave está presente (ausente = agotada).
  const seguirNombre = cursor === null || cursor.n !== undefined;
  const seguirTelefono = esNumerica && (cursor === null || cursor.p !== undefined);

  const porNombre = seguirNombre
    ? await paginaDeFuente(
        (cursor?.n !== undefined
          ? col.orderBy('name').startAfter(cursor.n)
          : col.orderBy('name').startAt(q)
        ).endAt(q + ''),
        limit,
      )
    : { rows: [], hasMore: false };

  const porTelefono = seguirTelefono
    ? await paginaDeFuente(
        (cursor?.p !== undefined
          ? col.orderBy('whatsappPhone').startAfter(cursor.p)
          : col.orderBy('whatsappPhone').startAt(digits)
        ).endAt(digits + ''),
        limit,
      )
    : { rows: [], hasMore: false };

  // Fusión sin duplicados + exclusión de softDeleted. Nota honesta: la exclusión es server-side
  // sobre la página leída, así que una página puede volver más corta que `limit` sin estar
  // agotada — el cursor igual avanza y la siguiente trae el resto.
  const vistos = new Set<string>();
  const items: CustomerSearchItem[] = [];
  for (const row of [...porNombre.rows, ...porTelefono.rows]) {
    if (vistos.has(row.id)) continue;
    vistos.add(row.id);
    const d = row.data() ?? {};
    if ((d['conversation'] as { softDeleted?: unknown } | undefined)?.softDeleted === true) continue;
    const profileName = typeof d['profileName'] === 'string' && d['profileName'] !== '' ? d['profileName'] : undefined;
    items.push({
      id: row.id,
      name: typeof d['name'] === 'string' ? d['name'] : '',
      whatsappPhone: typeof d['whatsappPhone'] === 'string' ? d['whatsappPhone'] : '',
      ...(profileName !== undefined ? { profileName } : {}),
    });
  }

  const next: SearchCursor = {};
  if (porNombre.hasMore && porNombre.rows.length > 0) {
    next.n = (porNombre.rows[porNombre.rows.length - 1]!.data()?.['name'] as string) ?? '';
  }
  if (porTelefono.hasMore && porTelefono.rows.length > 0) {
    next.p = (porTelefono.rows[porTelefono.rows.length - 1]!.data()?.['whatsappPhone'] as string) ?? '';
  }
  return { items, ...(next.n !== undefined || next.p !== undefined ? { nextCursor: encodeCursor(next) } : {}) };
}
