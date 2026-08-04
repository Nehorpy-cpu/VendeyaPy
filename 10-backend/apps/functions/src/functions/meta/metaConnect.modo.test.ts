import { describe, it, expect, vi } from 'vitest';

/**
 * ADR-0017 — LA SUPERFICIE ESTÁNDAR SOLO CIERRA ONBOARDINGS ESTÁNDAR.
 * ===================================================================
 * `connectMeta` corre `runMetaConnect`, y ese camino hace dos cosas que sobre un número de
 * Coexistence son destructivas:
 *
 *  1. `getSecretStore().set(metaTokenSecretName(tenantId), token)` — el nombre del secreto es
 *     determinístico POR TENANT, así que el token del onboarding nuevo PISA el de `main`, o sea la
 *     credencial con la que hoy se le contesta a los clientes;
 *  2. `writeDiscoveredAssets(tenantId, 'main', assets)` — cuya limpieza borra todo asset y toda
 *     entrada de índice con `connectionId === 'main'`: el asset del número que vende y su
 *     `metaExternalIndex/whatsapp_…`.
 *
 * Coexistence tiene su propio camino (`coexistenceStart`/`coexistenceConnect` →
 * `runCoexistenceConnect` → conexión `wa_{pnid}`), y el panel ya lo usa. Esto es la DEFENSA EN
 * PROFUNDIDAD: aunque alguien vuelva a cablear el botón, o llame al callable a mano, el modo
 * peligroso no es alcanzable por esta puerta. Se rechaza ANTES de consumir el nonce y ANTES de
 * reclamar el `code`: un rechazo no puede gastar el consentimiento del dueño.
 *
 * El flujo estándar NO puede regresionar: `standard` —y el `mode` ausente, que es lo que mandan
 * los clientes anteriores a Coexistence— siguen pasando.
 */
vi.mock('../../lib/firebase.js', () => ({ db: () => ({}), paths: {} }));

import { rechazoPorModoEnFlujoEstandar } from './metaConnect.js';

describe('rechazoPorModoEnFlujoEstandar — el camino que reescribe `main` no acepta Coexistence', () => {
  it('`coexistence` se rechaza, y el motivo le dice al dueño por dónde va su número', () => {
    const motivo = rechazoPorModoEnFlujoEstandar('coexistence');
    expect(motivo).not.toBeNull();
    expect(motivo).toMatch(/whatsapp business/i);
  });

  it('`standard` pasa: el alta de un número nuevo no cambia', () => {
    expect(rechazoPorModoEnFlujoEstandar('standard')).toBeNull();
  });

  it('el mensaje no filtra nada operativo (ni tokens, ni ids, ni rutas de documentos)', () => {
    const motivo = rechazoPorModoEnFlujoEstandar('coexistence') ?? '';
    expect(motivo).not.toMatch(/token|secret|metaConnections|metaAssets|metaExternalIndex/i);
  });
});
