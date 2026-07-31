import { describe, it, expect, vi } from 'vitest';

/**
 * A3 — EL PRESUPUESTO DE REINTENTOS TIENE QUE ENTRAR EN EL TIMEOUT DE LA FUNCIÓN.
 * ==============================================================================
 * `onWebhookInbox` no declaraba `timeoutSeconds`, así que corría con el default de gen2 (60 s).
 * Desde que ingesta adjuntos, el peor caso de la descarga (metadata + contenido, con 2 reintentos
 * cada una) es ~121,5 s: la función moría a mitad de camino, dejando el adjunto en `downloading`
 * para siempre. Este test ata los dos números para que nadie los desincronice sin enterarse.
 */

// El módulo declara la función al importarse; nada de esto ejecuta el handler.
vi.mock('../../lib/firebase.js', () => ({ db: () => ({}), storage: () => ({}), paths: {} }));

import { onWebhookInbox, ONWEBHOOKINBOX_TIMEOUT_SECONDS, ONWEBHOOKINBOX_MEMORY } from './onWebhookInbox.js';
import { worstCaseDownloadBudgetMs } from '../../meta/mediaClient.js';

/** Config REAL con la que se desplegaría (lo que firebase-functions arma para el endpoint). */
const endpoint = (onWebhookInbox as unknown as { __endpoint: Record<string, unknown> }).__endpoint;

describe('onWebhookInbox — recursos declarados vs. presupuesto real', () => {
  it('el peor caso de descarga entra CON MARGEN en el timeout declarado', () => {
    const presupuestoMs = worstCaseDownloadBudgetMs();
    expect(presupuestoMs).toBeGreaterThan(60_000); // …por eso 60 s (el default) no alcanzaba
    // Margen: además de la descarga quedan la subida a Storage, Firestore y el turno del motor.
    expect(presupuestoMs + 30_000).toBeLessThan(ONWEBHOOKINBOX_TIMEOUT_SECONDS * 1000);
  });

  it('el timeout y la memoria viajan de verdad en la declaración de la función', () => {
    expect(endpoint['timeoutSeconds']).toBe(ONWEBHOOKINBOX_TIMEOUT_SECONDS);
    // firebase-functions normaliza '512MiB' → 512 MB en el endpoint.
    expect(ONWEBHOOKINBOX_MEMORY).toBe('512MiB');
    expect(endpoint['availableMemoryMb']).toBe(512);
  });

  it('sigue por debajo del techo de gen2 para funciones por evento (540 s)', () => {
    expect(ONWEBHOOKINBOX_TIMEOUT_SECONDS).toBeLessThanOrEqual(540);
  });
});
