import { describe, it, expect } from 'vitest';

/**
 * ADR-0017 §2 — LA SESIÓN ES POR CANAL, Y `active` ES EL CANAL HEREDADO.
 * =======================================================================
 * El default del tercer argumento no es comodidad: es la garantía de retrocompatibilidad. Hay
 * ~25 llamadores que hoy asumen `sessions/active` y NO se migran en este despliegue (el ADR lo
 * fija como condición para pasar a `live`, no para desplegar la fundación). Si el parámetro no
 * tuviera default, o el default fuera otro, todos ellos empezarían a mirar una conversación que
 * no existe — y el número que hoy vende perdería carrito, takeover y pedido pendiente.
 */
import { paths } from './firebase.js';

const T = 'tnt_alpha';
const C = '595991234567';

describe('paths.session', () => {
  it('sin clave apunta al canal HEREDADO: exactamente el path de siempre', () => {
    expect(paths.session(T, C)).toBe(`tenants/${T}/customers/${C}/sessions/active`);
  });

  it('con clave apunta al canal de ese número', () => {
    expect(paths.session(T, C, 'wa_111222333')).toBe(`tenants/${T}/customers/${C}/sessions/wa_111222333`);
  });

  it('dos canales del mismo cliente son documentos DISTINTOS', () => {
    expect(paths.session(T, C, 'wa_111222333')).not.toBe(paths.session(T, C, 'wa_444555666'));
    expect(paths.session(T, C, 'wa_111222333')).not.toBe(paths.session(T, C));
  });

  it('pasar explícitamente `active` es idéntico a no pasar nada', () => {
    expect(paths.session(T, C, 'active')).toBe(paths.session(T, C));
  });
});
