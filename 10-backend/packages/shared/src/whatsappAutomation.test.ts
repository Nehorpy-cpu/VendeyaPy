import { describe, it, expect } from 'vitest';

/**
 * ADR-0017 §1 — EL PERMISO PARA AUTOMATIZAR, FAIL-CLOSED.
 * ======================================================
 * «Un PNID nuevo, o sin el campo, o con un valor que no sea exactamente uno de los tres, es
 * `inactive`. Ante inconsistencia entre asset, índice y conexión gana el estado más restrictivo.»
 *
 * Este archivo es la red de ese párrafo, con el mismo criterio que `attachmentRollout.test.ts`:
 * no prueba el camino feliz —eso lo prueba el webhook— sino que NINGUNA forma parecida a `live`
 * encienda la automatización sobre un número con clientes reales.
 */
import {
  WHATSAPP_AUTOMATION_MODES,
  AUTOMATION_MODE_FAIL_CLOSED,
  isWhatsappAutomationMode,
  parseAutomationMode,
  declaredAutomationMode,
  masRestrictivo,
  permiteAutomatizacion,
  persisteEntrante,
  LEGACY_SESSION_KEY,
  isSessionKey,
  parseSessionKey,
  whatsappSessionKey,
  PLATFORM_SESSION_KEYS,
  sessionKeyDePlataforma,
} from './whatsappAutomation.js';

/** Todo lo que un panel mal tipado, un import o un dedo distraído puede dejar escrito. */
const FORMAS_QUE_NO_SON_MODO: readonly unknown[] = [
  undefined,
  null,
  '',
  ' ',
  'Live',
  'LIVE',
  ' live',
  'live ',
  'active',
  'enabled',
  'on',
  true,
  false,
  1,
  0,
  'shadow_mode',
  'inactivo',
  {},
  { mode: 'live' },
  [],
  ['live'],
  new Date(),
  NaN,
];

describe('WHATSAPP_AUTOMATION_MODES — los tres modos existen en RUNTIME, no solo como tipo', () => {
  it('es un arreglo congelado de exactamente tres valores, del más al menos restrictivo', () => {
    expect(WHATSAPP_AUTOMATION_MODES).toEqual(['inactive', 'shadow', 'live']);
    // Un `as const` que no exista en runtime no sirve para validar un documento de Firestore.
    expect(Array.isArray(WHATSAPP_AUTOMATION_MODES)).toBe(true);
    expect(Object.isFrozen(WHATSAPP_AUTOMATION_MODES)).toBe(true);
  });

  it('el valor fail-closed es `inactive`', () => {
    expect(AUTOMATION_MODE_FAIL_CLOSED).toBe('inactive');
  });
});

describe('parseAutomationMode — solo los tres strings EXACTOS', () => {
  it('reconoce los tres modos tal cual', () => {
    for (const m of WHATSAPP_AUTOMATION_MODES) {
      expect(parseAutomationMode(m)).toBe(m);
      expect(isWhatsappAutomationMode(m)).toBe(true);
    }
  });

  it('cualquier otra cosa es `inactive` (fail-closed)', () => {
    for (const forma of FORMAS_QUE_NO_SON_MODO) {
      expect(parseAutomationMode(forma), String(forma)).toBe('inactive');
      expect(isWhatsappAutomationMode(forma), String(forma)).toBe(false);
    }
  });

  it('un String("live") objeto tampoco enciende (es un objeto, no el primitivo)', () => {
    // eslint-disable-next-line no-new-wrappers
    expect(parseAutomationMode(new String('live'))).toBe('inactive');
  });
});

/**
 * La distinción que hace posible desplegar sin apagar el número que vende: AUSENTE no es lo
 * mismo que MAL ESCRITO. El asset es la autoridad y su ausencia ya cae en `inactive`; que el
 * índice —una proyección de ruteo— no repita el campo NO puede degradar a `inactive` un número
 * que el asset declara `live`, porque entonces la migración tendría que escribir dos documentos
 * en el mismo instante o el número quedaría mudo en el medio.
 */
describe('declaredAutomationMode — ausente = SIN OPINIÓN; presente y raro = inactive', () => {
  it('ausente (undefined / null) devuelve null: no vota', () => {
    expect(declaredAutomationMode(undefined)).toBeNull();
    expect(declaredAutomationMode(null)).toBeNull();
  });

  it('presente y válido devuelve el modo', () => {
    expect(declaredAutomationMode('live')).toBe('live');
    expect(declaredAutomationMode('shadow')).toBe('shadow');
    expect(declaredAutomationMode('inactive')).toBe('inactive');
  });

  it('presente pero irreconocible vota `inactive` (alguien escribió algo que no entendemos)', () => {
    for (const forma of FORMAS_QUE_NO_SON_MODO) {
      if (forma === undefined || forma === null) continue;
      expect(declaredAutomationMode(forma), String(forma)).toBe('inactive');
    }
  });
});

describe('masRestrictivo — el desempate ante inconsistencia', () => {
  it('gana siempre el más restrictivo del conjunto', () => {
    expect(masRestrictivo('live', 'live')).toBe('live');
    expect(masRestrictivo('live', 'shadow')).toBe('shadow');
    expect(masRestrictivo('shadow', 'live')).toBe('shadow');
    expect(masRestrictivo('live', 'inactive')).toBe('inactive');
    expect(masRestrictivo('inactive', 'shadow', 'live')).toBe('inactive');
    expect(masRestrictivo('shadow', 'shadow')).toBe('shadow');
  });

  it('sin argumentos ⇒ `inactive`: nadie declaró nada', () => {
    expect(masRestrictivo()).toBe('inactive');
  });

  it('un valor basura entre modos válidos ARRASTRA a inactive (no se ignora)', () => {
    expect(masRestrictivo('live', 'LIVE')).toBe('inactive');
    expect(masRestrictivo('live', 42)).toBe('inactive');
    expect(masRestrictivo('shadow', undefined)).toBe('inactive');
  });

  it('es conmutativo: el orden de las fuentes no cambia el veredicto', () => {
    expect(masRestrictivo('shadow', 'live', 'inactive')).toBe(masRestrictivo('live', 'inactive', 'shadow'));
  });
});

describe('permiteAutomatizacion / persisteEntrante — qué habilita cada modo', () => {
  it('SOLO `live` automatiza', () => {
    expect(permiteAutomatizacion('live')).toBe(true);
    expect(permiteAutomatizacion('shadow')).toBe(false);
    expect(permiteAutomatizacion('inactive')).toBe(false);
  });

  it('`shadow` y `live` persisten el entrante; `inactive` no deja rastro conversacional', () => {
    expect(persisteEntrante('live')).toBe(true);
    expect(persisteEntrante('shadow')).toBe(true);
    expect(persisteEntrante('inactive')).toBe(false);
  });
});

/**
 * ADR-0017 §2 — LA SESIÓN ES POR CANAL. `active` se CONSERVA como la clave del canal heredado:
 * las conversaciones que ya existen no se migran ni se tocan.
 */
describe('sessionKey — derivación y compatibilidad con el canal heredado', () => {
  it('la clave del canal heredado es `active`', () => {
    expect(LEGACY_SESSION_KEY).toBe('active');
  });

  it('deriva del PNID, es determinística y no colisiona con la heredada', () => {
    expect(whatsappSessionKey('111222333')).toBe('wa_111222333');
    expect(whatsappSessionKey('111222333')).toBe(whatsappSessionKey('111222333'));
    expect(whatsappSessionKey('111222333')).not.toBe(LEGACY_SESSION_KEY);
    expect(whatsappSessionKey('444555666')).not.toBe(whatsappSessionKey('111222333'));
  });

  it('sanea el PNID: la clave es un id de documento, jamás un path', () => {
    expect(whatsappSessionKey('a/b')).toBe('wa_a_b');
    expect(whatsappSessionKey('../x')).not.toContain('/');
    expect(isSessionKey(whatsappSessionKey('../x'))).toBe(true);
  });

  it('sin PNID no hay canal propio: cae al canal heredado', () => {
    expect(whatsappSessionKey('')).toBe(LEGACY_SESSION_KEY);
    expect(whatsappSessionKey('   ')).toBe(LEGACY_SESSION_KEY);
  });

  it('isSessionKey rechaza todo lo que no sea un id de documento seguro', () => {
    expect(isSessionKey('active')).toBe(true);
    expect(isSessionKey('wa_123')).toBe(true);
    for (const malo of ['', ' ', '.', '..', 'a/b', 'a b', 'á', 'x'.repeat(65), 42, null, undefined, {}]) {
      expect(isSessionKey(malo), String(malo)).toBe(false);
    }
  });

  it('parseSessionKey: ausente o malformada ⇒ el fallback que decide el llamador', () => {
    expect(parseSessionKey('wa_9', 'active')).toBe('wa_9');
    expect(parseSessionKey(undefined, 'active')).toBe('active');
    expect(parseSessionKey('a/b', 'wa_9')).toBe('wa_9');
    expect(parseSessionKey(42, 'active')).toBe('active');
  });
});

/**
 * ADR-0017 §2 aplicado a las plataformas SIN número. Instagram y Messenger compartían el canal
 * mutable `active` (vía el escape del gate): un cliente escribiendo por Instagram y por WhatsApp
 * compartía carrito, takeover y estado con el número que vende — y Messenger con Instagram entre
 * sí. La clave de canal por plataforma sale de ACÁ, de la misma abstracción central que la de
 * WhatsApp, para que nadie vuelva a construirla a mano en un borde.
 */
describe('sessionKeyDePlataforma — el canal PROPIO de una plataforma sin PNID', () => {
  it('Instagram y Messenger tienen clave propia, estable y distinta entre sí', () => {
    expect(sessionKeyDePlataforma('instagram')).toBe('ig');
    expect(sessionKeyDePlataforma('messenger')).toBe('msgr');
    expect(sessionKeyDePlataforma('instagram')).not.toBe(sessionKeyDePlataforma('messenger'));
    expect(PLATFORM_SESSION_KEYS).toEqual({ instagram: 'ig', messenger: 'msgr' });
    expect(Object.isFrozen(PLATFORM_SESSION_KEYS)).toBe(true);
  });

  it('ninguna clave de plataforma es el canal heredado ni pisa el espacio de WhatsApp', () => {
    for (const p of ['instagram', 'messenger', 'plataforma_nueva']) {
      const k = sessionKeyDePlataforma(p);
      expect(k, p).not.toBe(LEGACY_SESSION_KEY);
      expect(k.startsWith('wa_'), p).toBe(false);
      expect(isSessionKey(k), p).toBe(true);
    }
  });

  it('una plataforma DESCONOCIDA estrena clave derivada propia, jamás `active` ni la de otra', () => {
    expect(sessionKeyDePlataforma('threads')).toBe('ch_threads');
    // Solo el string EXACTO mapea (mismo criterio que parseAutomationMode): una variante rara no
    // puede terminar en el canal de la plataforma real.
    expect(sessionKeyDePlataforma('Instagram')).toBe('ch_Instagram');
    expect(sessionKeyDePlataforma('a/b c')).not.toContain('/');
    expect(isSessionKey(sessionKeyDePlataforma('a/b c'))).toBe(true);
  });

  it('WhatsApp NO tiene canal de plataforma: su canal se deriva del PNID', () => {
    expect(() => sessionKeyDePlataforma('whatsapp')).toThrow(/PNID/);
    expect(() => sessionKeyDePlataforma('')).toThrow();
    expect(() => sessionKeyDePlataforma('   ')).toThrow();
  });
});
