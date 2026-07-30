/**
 * meta/catalogDriftProjection.ts — Proyección de deriva para el bot y el checkout (ADR-0015 §8)
 * ==============================================================================================
 * Une dos piezas que ya existen y NO reimplementa ninguna:
 *  - la PROPIEDAD DECLARADA por campos (`catalogSync.ownership` → `declaredExternalFields`), que
 *    dice qué campos públicos gobierna la fuente externa reconocida por una persona, y
 *  - el ESTADO ACTUAL derivado de la reconciliación (`metaSyncState` + `metaVerifiedAt` +
 *    `metaDrift`), con la caducidad calculada EN LECTURA por `effectiveMetaSyncState`.
 *
 * Lo que devuelve es deliberadamente pobre: ids, nombres de campo y estado. Ni un valor remoto,
 * ni la URL del feed, ni su query string, ni un token — el guard de conversación no los necesita
 * y lo que no viaja no se filtra.
 *
 * Un producto SIN identidad remota (nunca mapeado a un artículo) no está gobernado por nadie de
 * afuera aunque el tenant sea `external_managed`: la fuente externa no lo publica, así que su
 * precio local es la única verdad y el bot puede afirmarlo como siempre.
 *
 * ⚠️ Este módulo se cablea en el ARRANQUE de todas las Cloud Functions (index.ts), así que su
 * grafo de imports tiene que quedarse liviano: nada de cliente HTTP del catálogo ni de la
 * reconciliación paginada. Lo custodia `catalogDriftProjection.arranque.test.ts`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Product } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { CAMPOS_CRITICOS, type DriftProjection, type ProductDriftSnapshot } from '../catalog/driftGuard.js';
import { declaredExternalFields } from './catalogSyncConfig.js';
import { effectiveMetaSyncState, verificationTtlMs } from './catalogVerificationState.js';

/**
 * Memo de UNA evaluación (no es un cache).
 *
 * El costo que resuelve: `activa()` y `snapshots()` preguntan por la MISMA propiedad con
 * milisegundos de diferencia, así que cada búsqueda del bot pagaba DOS lecturas de
 * `tenants/{t}/config/meta`. No se resuelve con un TTL: la propiedad manda sobre dinero y
 * servirla vieja aunque sea un minuto es exactamente la clase de mentira que este programa
 * elimina. El ámbito lo abre el guard por evaluación (`enAmbito`) y muere con ella;
 * `AsyncLocalStorage` (builtin de Node, cero dependencias) lo mantiene atado al contexto async
 * de ESE pedido, así que la propiedad de una evaluación jamás se le sirve a otra.
 *
 * Fuera de un ámbito no hay memo: quien llama directo (el camino que crea la orden) lee fresco.
 */
const ambitoDeEvaluacion = new AsyncLocalStorage<Map<string, Promise<readonly string[]>>>();

/** Campos públicos que la fuente externa gobierna hoy en este tenant (vacío ⇒ guard inerte). */
async function leerCamposExternos(tenantId: string): Promise<readonly string[]> {
  const snap = await db().doc(`tenants/${tenantId}/config/meta`).get();
  // `declaredExternalFields` lee la propiedad DECLARADA sin pasar por el interruptor de sync:
  // que nosotros dejemos de escribir (enabled:false / mode:'off') no apaga el feed del tenant,
  // así que tampoco puede apagar la honestidad. Sigue fail-closed en lo suyo: sin config, con
  // config inválida o con `ownership` legacy devuelve [] y el guard queda inerte.
  return declaredExternalFields((snap.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
}

function camposExternos(tenantId: string): Promise<readonly string[]> {
  const memo = ambitoDeEvaluacion.getStore();
  if (!memo) return leerCamposExternos(tenantId);
  const enCurso = memo.get(tenantId);
  if (enCurso) return enCurso;
  // Se memoiza la PROMESA (no el valor): dos preguntas simultáneas dentro del mismo ámbito
  // comparten la lectura en vez de dispararla dos veces.
  const pedido = leerCamposExternos(tenantId);
  memo.set(tenantId, pedido);
  return pedido;
}

const aMillis = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return typeof t?.toMillis === 'function' ? t.toMillis() : null;
};

/**
 * ¿Este producto tiene una SEGUNDA CARA publicada afuera? Las tres señales cuentan: el retailer id,
 * el `metaProductItemId` del vínculo manual legacy y el estado de reconciliación (que solo existe
 * si alguna vez se lo comparó contra un artículo). Sin ninguna, nadie lo publicó: no hay nada que
 * pueda contradecir su precio local.
 *
 * Vive acá —y no duplicada en cada uso— porque es la MISMA pregunta que decide si un snapshot
 * nace gobernado y la que contesta el fallback fail-closed del guard: si divergieran, el guard
 * bloquearía (o dejaría pasar) productos que la lectura normal clasifica al revés.
 */
const tieneIdentidadRemota = (p: Product | undefined): p is Product =>
  !!p && (!!p.metaProductItemId || !!p.metaRetailerId || !!p.metaSyncState);

/**
 * FALLA INYECTADA — SOLO EMULADOR (mismo contrato que `catalogTestHooks`/`coverageTestHooks`).
 *
 * Por qué existe: la regla más cara de este ADR es que una LECTURA QUE FALLA no vale como "no hay
 * deriva" en los caminos donde hay plata comprometida (§8, `failClosed`). Esa diferencia solo se
 * puede probar de punta a punta si el E2E puede hacer fallar la lectura de verdad: devolver lista
 * vacía es "leí y no hay nada", que es justo el caso contrario. Sin esta costura el único camino
 * era ensuciar el fixture (un productId imposible), y eso prueba otra cosa.
 *
 * En producción es un no-op ANTES de cualquier lectura: la guarda por `FUNCTIONS_EMULATOR` es lo
 * primero, así que no cuesta ni un viaje a Firestore. Y si el propio fixture no se puede leer, no
 * se inventa una falla que el test no pidió.
 *
 * Fixture: `tenants/{t}/_debug/driftFixtures { failAt: 'activa' | 'snapshots' | 'identidad' | [...] }`.
 */
async function fallaInyectada(tenantId: string, punto: 'activa' | 'snapshots' | 'identidad'): Promise<void> {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return;
  let crudo: unknown;
  try {
    crudo = (await db().doc(`tenants/${tenantId}/_debug/driftFixtures`).get()).data()?.failAt;
  } catch {
    return; // el hook jamás fabrica una falla por su cuenta
  }
  const pedidos = Array.isArray(crudo) ? crudo : typeof crudo === 'string' ? [crudo] : [];
  if (pedidos.includes(punto)) throw new Error(`[E2E] lectura de la proyección de deriva forzada a fallar (${punto})`);
}

export const metaDriftProjection: DriftProjection = {
  /**
   * Gate barato (1 lectura de config): solo hay algo que preguntar si una fuente externa gobierna
   * un campo COMERCIAL. Que publique el título o la imagen no habilita a cortar ninguna venta.
   */
  activa: async (tenantId) => {
    await fallaInyectada(tenantId, 'activa');
    const externos = await camposExternos(tenantId);
    return externos.some((f) => (CAMPOS_CRITICOS as readonly string[]).includes(f));
  },

  snapshots: async (tenantId, productIds) => {
    await fallaInyectada(tenantId, 'snapshots');
    const externos = await camposExternos(tenantId);
    if (!externos.length) return [];
    const nowMs = Date.now();
    // TTL: por ahora el techo de 24 h. La declaración de fuente guarda metadata SANEADA (no un
    // schedule tipado), así que no hay período externo confiable que pasar; cuando lo haya, este
    // es el único lugar donde se enchufa.
    const ttlMs = verificationTtlMs(null);
    // COSTO QUE QUEDA (consciente): una lectura por producto consultado. Son documentos que el
    // llamador ya tiene en la mano en el camino conversacional, pero pedirlos de nuevo garantiza
    // que el estado y la fecha de verificación sean los de AHORA y no los de una copia en
    // memoria: sobre dinero, la foto fresca vale la lectura.
    const docs = await Promise.all(productIds.map((id) => db().doc(paths.product(tenantId, id)).get()));
    return docs.map((d, i): ProductDriftSnapshot => {
      const id = productIds[i]!;
      const p = d.data() as Product | undefined;
      // Sin identidad remota no hay artículo publicado que pueda contradecirnos.
      if (!tieneIdentidadRemota(p)) return { productId: id, externalFields: [], state: null };
      return {
        productId: id,
        externalFields: [...externos],
        // La caducidad la deriva la reconciliación en LECTURA: un job que falló envejece el
        // estado en vez de dejarlo afirmando algo que ya no vimos.
        state: effectiveMetaSyncState({ state: p.metaSyncState ?? null, verifiedAtMs: aMillis(p.metaVerifiedAt), nowMs, ttlMs }),
        driftedFields: p.metaDrift?.fields ?? [],
      };
    });
  },

  /**
   * Quiénes de estos productos están publicados afuera. SOLO se pregunta cuando `snapshots` ya
   * falló y el llamador compromete plata (ADR-0015 §8).
   *
   * A propósito NO mira `tenants/{t}/config/meta`: esa es la lectura que se acaba de caer, y la
   * pregunta "¿cómo está configurado el tenant?" es fail-SAFE en todos lados (ante un error
   * responde "no aplica"), así que usarla acá dejaría el guard inerte justo en el parpadeo —
   * creando la orden al precio equivocado en el tenant gobernado por un feed. Esta pregunta se
   * contesta con los PRODUCTOS: sin identidad remota nadie los publica, y eso es cierto esté como
   * esté la config. Si esta lectura tampoco responde, el guard vuelve a bloquear todo.
   */
  conIdentidadRemota: async (tenantId, productIds) => {
    await fallaInyectada(tenantId, 'identidad');
    const docs = await Promise.all(productIds.map((id) => db().doc(paths.product(tenantId, id)).get()));
    return productIds.filter((_, i) => tieneIdentidadRemota(docs[i]?.data() as Product | undefined));
  },

  /**
   * Ámbito de UNA evaluación: todo lo que corra adentro comparte la lectura de propiedad. Lo usa
   * el guard cuando encadena `activa` + `snapshots`; al salir, el memo se tira.
   */
  enAmbito: <T>(fn: () => Promise<T>): Promise<T> => ambitoDeEvaluacion.run(new Map(), fn),
};
