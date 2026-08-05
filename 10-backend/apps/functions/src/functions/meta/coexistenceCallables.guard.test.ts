/**
 * El historial es EXCLUSIVO de Coexistence (correctivo, MEDIO 12): una conexión `wa_{pnid}` dada
 * de alta A MANO (source `manual_admin`) no tiene historial de Business App que pedir, y dejarla
 * pasar quemaba el ÚNICO disparo contra un número que jamás lo tuvo.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/firebase.js', () => ({ db: () => ({}), paths: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../meta/graphClient.js', () => ({ getMetaGraphClient: vi.fn() }));
vi.mock('../../meta/metaSecrets.js', () => ({ META_APP_SECRET: { name: 'META_APP_SECRET' } }));

import { esConexionDeCoexistence } from './coexistenceCallables.js';

describe('esConexionDeCoexistence — el discriminador del historial', () => {
  it('solo la conexión nacida del Embedded Signup de Coexistence califica', () => {
    expect(esConexionDeCoexistence({ source: 'embedded_signup' })).toBe(true);
  });

  it('un alta manual NO (ese número no tiene historial de la app)', () => {
    expect(esConexionDeCoexistence({ source: 'manual_admin' })).toBe(false);
  });

  it('sin source ni documento tampoco (fail-closed)', () => {
    expect(esConexionDeCoexistence({})).toBe(false);
    expect(esConexionDeCoexistence(null)).toBe(false);
    expect(esConexionDeCoexistence(undefined)).toBe(false);
  });
});
