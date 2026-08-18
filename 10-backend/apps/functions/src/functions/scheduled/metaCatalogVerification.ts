/**
 * META-CATALOG-OWNERSHIP-MODEL-1 (ADR-0015 §6) — Reconciliación PERIÓDICA del catálogo.
 * ==================================================================================
 * Por qué existe, y por qué no es opcional: la proyección de estado actual CADUCA. Declarar la
 * propiedad deja todos los productos sin `metaVerifiedAt`, y sin `metaVerifiedAt` el estado
 * efectivo es `stale`; `stale` bloquea la venta automática (§8). Sin nadie que vuelva a leer
 * Meta, esa caducidad no se levanta nunca y la venta automática queda apagada de forma
 * PERMANENTE — la regla del owner ("lo vencido no cierra venta") solo es sostenible si algo
 * refresca la evidencia periódicamente.
 *
 * TTL EFECTIVO y cadencia (§5). El TTL es el MENOR entre 24 h y el período de la fuente
 * externa reconocida (`verificationTtlMs`); con el feed diario de arfagi son 24 h. La corrida
 * va DOS veces por día —04:30 y 16:30 de Asunción— a propósito: con cadencia de 24 h contra un
 * TTL de 24 h, cualquier demora o corrida fallida vencería el catálogo entero antes del
 * siguiente intento. Con 12 h de cadencia hay dos oportunidades de refrescar dentro de cada
 * ventana de caducidad, así que una corrida perdida no apaga la venta. La de las 04:30 corre
 * justo después de la ventana del feed del sitio (publica de madrugada): la foto es la del
 * catálogo ya republicado, no la del instante anterior al reemplazo.
 *
 * QUÉ TENANTS CORREN (ADR-0015 §8, hallazgo B1): NO lo decide el interruptor de sincronización.
 * Verificar es un GET; escribir es otra cosa. Con `catalogSync.enabled:false` o `mode:'off'` y
 * gobierno externo declarado, el guard del bot sigue ACTIVO (lee la propiedad sin pasar por el
 * interruptor) y esta corrida es el único camino que vuelve a sellar `metaVerifiedAt`: si no
 * corriera, a las 24 h todos los mapeados caducarían a `stale` y la venta automática se apagaría
 * en silencio y para siempre. Regla: **si el guard está activo para un tenant, lo que refresca la
 * evidencia también tiene que poder correr para ese tenant.**
 *
 * Reglas duras, espejo exacto de `metaCatalogOutbox.ts`:
 *  · SOLO tenants `ACTIVE` y sin `deletedAt`;
 *  · FAIL-CLOSED por config: un tenant sin `catalogSync` (credipower) no gasta NI UNA llamada
 *    —`runCatalogVerificationForTenant` corta antes de tocar la red—;
 *  · presupuesto ACOTADO por corrida y por tenant (`MAX_PAGES_POR_TENANT`): un catálogo grande
 *    se termina en corridas sucesivas reanudando el cursor persistido, no en una sola;
 *  · CERO escrituras en Meta: la reconciliación solo hace GET;
 *  · un tenant que falla JAMÁS frena a los demás;
 *  · idempotente: reanuda la corrida activa (claim transaccional con lease) y re-verificar un
 *    producto ya verificado reescribe el mismo estado sin re-alertar.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import {
  CatalogVerificationAlreadyRunningError,
  CatalogVerificationBlockedError,
  CatalogVerificationUnavailableError,
  runCatalogVerificationForTenant,
} from '../../meta/catalogVerification.js';

/**
 * Techo de páginas por tenant y por corrida. Con el tamaño de página por defecto (200) cubre
 * catálogos de varios miles de artículos en una sola pasada, y acota el gasto de una corrida
 * automática que nadie está mirando.
 */
export const MAX_PAGES_POR_TENANT = 15;

export interface VerificacionResumen {
  tenants: number;
  corridas: number;
  completadas: number;
  /** Sin nada que verificar (nadie declaró gobierno externo): es el estado normal, no un problema. */
  saltadas: number;
  /**
   * (ADR-0022 §4) Salteadas porque la relación declarada con Meta es `none` (opt-out explícito
   * del owner). Contador PROPIO a propósito: mezclarlo con `saltadas` escondería la diferencia
   * entre «no hay nada configurado» y «alguien decidió apagar la relación».
   */
  relacionNone: number;
  /**
   * Guard ACTIVO y verificación estructuralmente imposible (config contradictoria). Cuenta
   * APARTE de `saltadas` a propósito: contar esto como una salteada silenciosa es justo lo que
   * hizo invisible el apagado permanente de la venta automática.
   */
  bloqueadas: number;
  errores: number;
}

export async function runMetaCatalogVerificationMaintenance(): Promise<VerificacionResumen> {
  // Igual que el outbox: SOLO empresas vivas. Una suspendida o dada de baja no gasta llamadas.
  const tenants = await db().collection('tenants').select('status', 'deletedAt').get();
  const resumen: VerificacionResumen = { tenants: 0, corridas: 0, completadas: 0, saltadas: 0, relacionNone: 0, bloqueadas: 0, errores: 0 };

  for (const t of tenants.docs) {
    const d = t.data() as { status?: string; deletedAt?: unknown };
    if (d.status !== 'ACTIVE' || d.deletedAt) continue;
    resumen.tenants++;
    try {
      const r = await runCatalogVerificationForTenant({
        tenantId: t.id,
        trigger: 'scheduler',
        maxPages: MAX_PAGES_POR_TENANT,
      });
      resumen.corridas++;
      if (r.status === 'completed') resumen.completadas++;
      logger.info('Verificación de catálogo: corrida programada', {
        tenantId: t.id,
        runId: r.runId,
        status: r.status,
        phase: r.phase,
        pagesDone: r.pagesDone,
        verificados: r.counters.verified,
        derivaPropia: r.counters.drifted,
        derivaExterna: r.counters.driftedExternal,
        sinArticulo: r.counters.remoteMissing,
      });
    } catch (e) {
      // Sin config de catálogo (nivel 1) NO es un fallo: es el estado normal de un tenant que
      // no sincroniza. Se cuenta como salteado y no ensucia la bitácora de errores.
      if (e instanceof CatalogVerificationUnavailableError) {
        // OJO, el orden es LOAD-BEARING: `CatalogVerificationBlockedError` ES un
        // `CatalogVerificationUnavailableError` (subclase), así que la distinción va ACÁ ADENTRO.
        // En una rama posterior nunca se alcanzaría y volveríamos a contar como "saltada"
        // silenciosa justo al tenant con el guard activo que nadie puede desbloquear.
        if (e instanceof CatalogVerificationBlockedError) {
          resumen.bloqueadas++;
          logger.error(
            'Verificación de catálogo: CONFIG CONTRADICTORIA — hay gobierno externo declarado y ningún catálogo que leer; la venta automática de los productos vinculados queda bloqueada hasta que una persona lo corrija',
            e,
            { tenantId: t.id, motivo: e.reason },
          );
          continue;
        }
        // (ADR-0022 §4) Opt-out explícito por relación: contador propio, y el barrido sigue
        // con el próximo tenant (el aislamiento por tenant no se toca).
        if (e.skipReason === 'relationship_none') {
          resumen.relacionNone++;
          continue;
        }
        resumen.saltadas++;
        continue;
      }
      // Otra invocación (el owner desde el panel) tiene la corrida tomada: el scheduler cede.
      if (e instanceof CatalogVerificationAlreadyRunningError) {
        resumen.saltadas++;
        logger.info('Verificación de catálogo: corrida programada cedida (ya había una en curso)', { tenantId: t.id });
        continue;
      }
      resumen.errores++;
      logger.error('Verificación de catálogo: la corrida programada falló para un tenant', e, { tenantId: t.id });
    }
  }
  return resumen;
}

export const metaCatalogVerificationMaintenance = onSchedule(
  // Timeout por debajo de la cadencia y presupuesto de páginas acotado: una corrida colgada no
  // puede solaparse indefinidamente con la siguiente (el claim con lease ya protege, pero el
  // techo corta el gasto igual).
  { schedule: '30 4,16 * * *', timeZone: 'America/Asuncion', region: 'us-central1', timeoutSeconds: 540 },
  async () => {
    const r = await runMetaCatalogVerificationMaintenance();
    logger.info('Verificación de catálogo: mantenimiento programado terminado', { ...r });
  },
);
