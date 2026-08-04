import { describe, it, expect } from 'vitest';

/**
 * ADR-0017 §2 — LA SESIÓN ES POR CANAL, Y `active` ES EL CANAL HEREDADO.
 * =======================================================================
 * ETAPA E cambió el contrato: el tercer argumento pasó de tener default (`'active'`) a ser
 * OBLIGATORIO. La razón no es estética. Mientras hubo default, «me olvidé de pasar el canal» y
 * «esta conversación es la del número heredado» se escribían igual, así que el compilador no podía
 * enumerar los callsites pendientes y la auditoría tuvo que contarlos a mano — y contó de menos.
 *
 * Ahora el llamador que legítimamente habla del número que ya vende lo DICE, escribiendo
 * `LEGACY_SESSION_KEY`. Eso es una decisión visible en el diff; una omisión no lo era.
 *
 * Lo que no cambió, y es lo que protege al número en producción: `active` sigue siendo el mismo
 * documento de siempre. No se migra ni una conversación.
 */
import { LEGACY_SESSION_KEY } from '@vpw/shared';
import { paths } from './firebase.js';

const T = 'tnt_alpha';
const C = '595991234567';

describe('paths.session', () => {
  it('el canal HEREDADO apunta al path de siempre', () => {
    expect(paths.session(T, C, LEGACY_SESSION_KEY)).toBe(`tenants/${T}/customers/${C}/sessions/active`);
    expect(LEGACY_SESSION_KEY).toBe('active');
  });

  it('con la clave de un número apunta al canal de ese número', () => {
    expect(paths.session(T, C, 'wa_111222333')).toBe(`tenants/${T}/customers/${C}/sessions/wa_111222333`);
  });

  it('dos canales del mismo cliente son documentos DISTINTOS', () => {
    expect(paths.session(T, C, 'wa_111222333')).not.toBe(paths.session(T, C, 'wa_444555666'));
    expect(paths.session(T, C, 'wa_111222333')).not.toBe(paths.session(T, C, LEGACY_SESSION_KEY));
  });

  it('el canal es un SEGMENTO del path: nunca se sale de las sesiones del cliente', () => {
    // Las claves llegan de Firestore; quien las lee las pasa por `parseSessionKey`, que solo deja
    // pasar ids de documento seguros. Acá se fija el contrato del path: un segmento, y uno solo.
    expect(paths.session(T, C, 'wa_111222333').split('/')).toHaveLength(6);
  });
});
