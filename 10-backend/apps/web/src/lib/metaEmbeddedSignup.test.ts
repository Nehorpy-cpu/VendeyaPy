/**
 * metaEmbeddedSignup.test.ts — DOS FLUJOS, Y UNO DE ELLOS CORRE SOBRE EL NÚMERO QUE VENDE
 * =======================================================================================
 * El lanzador estaba diseñado para ser stubbeable y no tenía un solo test. Estos fijan lo que
 * ADR-0017 §5/§6 y ARCHITECTURE §12.1 exigen del lado del navegador:
 *
 *  · Coexistence manda `featureType: "whatsapp_business_app_onboarding"` y su PROPIO `config_id`.
 *    El string VACÍO declara el flujo ESTÁNDAR — no es «sin configurar» —, así que el estándar
 *    tiene que quedar byte a byte como está: es el camino que hoy funciona.
 *  · El cierre de Coexistence es `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` y su payload documentado
 *    trae SOLO `waba_id`. Exigir `phone_number_id` en el postMessage sería inventar un contrato que
 *    Meta no promete; el PNID lo resuelve el backend desde el WABA.
 *  · Coexistence va FAIL-CLOSED: sin ese evento válido no se llama al callable, aunque haya `code`.
 *  · El popup se abre SINCRÓNICAMENTE en el gesto del usuario. Con dos `await` antes, el navegador
 *    lo bloquea y el código lo reportaba como «cancelaste la conexión»: en el teléfono del dueño eso
 *    quemaría la ventana de 24 h de Coexistence buscando un error que no existe.
 *  · El postMessage se valida por origin Y por VENTANA DE ORIGEN: cualquier iframe de facebook.com
 *    embebido en la página podía inyectar un `sessionInfo`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  launchEmbeddedSignup,
  preloadFacebookSdk,
  isEmbeddedSignupConfigured,
  MetaSignupError,
  type MetaSignupFlow,
} from './metaEmbeddedSignup';

const ORIGEN_META = 'https://www.facebook.com';
const CODE = 'code-de-prueba-no-real';

type LoginCb = (r: { status?: string; authResponse?: { code?: string } | null }) => void;
interface LoginCall {
  opts: Record<string, unknown>;
  cb: LoginCb;
}

/** La ventana que el SDK "abre". El handle es lo que permite validar el `event.source`. */
let ventanaPopup: Window | null;
let llamadas: LoginCall[];
let openOriginal: typeof window.open;

/** Emula al FB JS SDK: `login` abre un popup con window.open y guarda el callback. */
function instalarSdkFalso(opciones: { popupBloqueado?: boolean } = {}) {
  llamadas = [];
  ventanaPopup = opciones.popupBloqueado ? null : ({ closed: false } as unknown as Window);
  window.open = (() => ventanaPopup) as typeof window.open;
  window.FB = {
    init: () => {},
    login: (cb: LoginCb, opts?: Record<string, unknown>) => {
      // El SDK real abre el popup DENTRO de login(), de forma síncrona.
      window.open('about:blank', 'meta', 'popup');
      llamadas.push({ cb, opts: opts ?? {} });
    },
  } as unknown as Window['FB'];
}

/** Un postMessage del Embedded Signup, con control fino de origin, source, type y event. */
function emitir(payload: unknown, opts: { origin?: string; source?: unknown } = {}) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: opts.origin ?? ORIGEN_META,
      data: payload,
      source: ('source' in opts ? opts.source : ventanaPopup) as MessageEventSource,
    }),
  );
}

/** Responde el `login` pendiente (el popup se cerró y el SDK entrega el code). */
function responderLogin(r: { status?: string; authResponse?: { code?: string } | null }) {
  const ultima = llamadas.at(-1);
  if (!ultima) throw new Error('fb.login no fue llamado');
  ultima.cb(r);
}

const finishCoexistence = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '111222333' } };
const finishEstandar = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '999', waba_id: '111222333', business_id: '444' } };

beforeEach(() => {
  openOriginal = window.open;
  process.env['NEXT_PUBLIC_META_APP_ID'] = 'app-id-de-prueba';
  process.env['NEXT_PUBLIC_META_CONFIG_ID'] = 'config-estandar';
  process.env['NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID'] = 'config-coexistence';
  instalarSdkFalso();
});

afterEach(() => {
  window.open = openOriginal;
  delete window.FB;
  delete process.env['NEXT_PUBLIC_META_APP_ID'];
  delete process.env['NEXT_PUBLIC_META_CONFIG_ID'];
  delete process.env['NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID'];
  vi.restoreAllMocks();
});

describe('config de los dos flujos', () => {
  it('el estándar está configurado con App ID + config_id estándar', () => {
    expect(isEmbeddedSignupConfigured('standard')).toBe(true);
  });

  it('Coexistence necesita su PROPIO config_id: sin él NO está configurado', () => {
    delete process.env['NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID'];
    expect(isEmbeddedSignupConfigured('coexistence')).toBe(false);
    // …y el estándar sigue disponible: los dos flujos son independientes.
    expect(isEmbeddedSignupConfigured('standard')).toBe(true);
  });

  it('sin config de Coexistence, lanzarlo falla controlado (jamás cae al config_id estándar)', async () => {
    delete process.env['NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID'];
    await expect(launchEmbeddedSignup('coexistence')).rejects.toMatchObject({ reason: 'not_configured' });
    expect(llamadas).toHaveLength(0);
  });
});

describe('el flujo estándar NO puede regresionar', () => {
  it('manda featureType VACÍO (que ES la declaración del flujo estándar) y el config_id estándar', async () => {
    const p = launchEmbeddedSignup('standard');
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await p;
    const extras = llamadas[0]!.opts['extras'] as Record<string, unknown>;
    expect(llamadas[0]!.opts['config_id']).toBe('config-estandar');
    expect(extras['featureType']).toBe('');
    expect(llamadas[0]!.opts['response_type']).toBe('code');
    expect(llamadas[0]!.opts['override_default_response_type']).toBe(true);
  });

  it('devuelve el code y adjunta el sessionInfo cuando el popup lo entrega (best-effort)', async () => {
    const p = launchEmbeddedSignup('standard');
    emitir(finishEstandar);
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(p).resolves.toMatchObject({
      code: CODE,
      flow: 'standard',
      sessionInfo: { phoneNumberId: '999', wabaId: '111222333', businessId: '444' },
    });
  });

  it('sin sessionInfo alcanza con el code: el backend descubre el WABA', async () => {
    const p = launchEmbeddedSignup('standard');
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    const r = await p;
    expect(r.code).toBe(CODE);
    expect(r.sessionInfo).toBeUndefined();
  });

  it('sin code es cancelación (no un error fatal)', async () => {
    const p = launchEmbeddedSignup('standard');
    responderLogin({ status: 'unknown', authResponse: null });
    await expect(p).rejects.toMatchObject({ reason: 'cancelled' });
  });
});

describe('Coexistence — flujo propio y FAIL-CLOSED', () => {
  it('manda featureType whatsapp_business_app_onboarding y su propio config_id', async () => {
    const p = launchEmbeddedSignup('coexistence');
    emitir(finishCoexistence);
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await p;
    const extras = llamadas[0]!.opts['extras'] as Record<string, unknown>;
    expect(llamadas[0]!.opts['config_id']).toBe('config-coexistence');
    expect(extras['featureType']).toBe('whatsapp_business_app_onboarding');
  });

  it('acepta el FINISH documentado, que trae SOLO waba_id (no se exige phone_number_id)', async () => {
    const p = launchEmbeddedSignup('coexistence');
    emitir(finishCoexistence);
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    const r = await p;
    expect(r.flow).toBe('coexistence');
    expect(r.sessionInfo?.wabaId).toBe('111222333');
    expect(r.sessionInfo?.phoneNumberId).toBeUndefined();
  });

  it('FAIL-CLOSED: con code pero SIN el evento de cierre, NO se conecta', async () => {
    const p = launchEmbeddedSignup('coexistence');
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(p).rejects.toMatchObject({ reason: 'incomplete_signup' });
  });

  it('FAIL-CLOSED: el FINISH del flujo ESTÁNDAR no sirve para cerrar Coexistence', async () => {
    const p = launchEmbeddedSignup('coexistence');
    emitir(finishEstandar);
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(p).rejects.toMatchObject({ reason: 'incomplete_signup' });
  });

  it('FAIL-CLOSED: un FINISH de Coexistence sin waba_id no cierra nada', async () => {
    const p = launchEmbeddedSignup('coexistence');
    emitir({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: {} });
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(p).rejects.toMatchObject({ reason: 'incomplete_signup' });
  });

  it('un CANCEL se reconoce como cancelación, no como error del sistema', async () => {
    const p = launchEmbeddedSignup('coexistence');
    emitir({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'WABA_SELECTION' } });
    responderLogin({ status: 'unknown', authResponse: null });
    await expect(p).rejects.toMatchObject({ reason: 'cancelled' });
  });
});

describe('validación del postMessage', () => {
  it('ignora un mensaje de otro origin', async () => {
    const p = launchEmbeddedSignup('coexistence');
    emitir(finishCoexistence, { origin: 'https://evil.example' });
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(p).rejects.toMatchObject({ reason: 'incomplete_signup' });
  });

  it('ignora un mensaje con type distinto de WA_EMBEDDED_SIGNUP', async () => {
    const p = launchEmbeddedSignup('coexistence');
    emitir({ type: 'OTRA_COSA', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '1' } });
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(p).rejects.toMatchObject({ reason: 'incomplete_signup' });
  });

  it('ignora un mensaje que NO viene de la ventana que este código abrió (iframe inyectado)', async () => {
    const p = launchEmbeddedSignup('coexistence');
    const iframeAjeno = { closed: false } as unknown as Window;
    emitir(finishCoexistence, { source: iframeAjeno });
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(p).rejects.toMatchObject({ reason: 'incomplete_signup' });
  });

  it('un postMessage TARDÍO (llega después de que el SDK respondió) no se pierde', async () => {
    const p = launchEmbeddedSignup('coexistence');
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    emitir(finishCoexistence); // carrera real: el SDK responde antes que el postMessage
    await expect(p).resolves.toMatchObject({ code: CODE, sessionInfo: { wabaId: '111222333' } });
  });
});

describe('el popup se abre en el gesto del usuario', () => {
  it('fb.login se llama SINCRÓNICAMENTE: sin await de por medio no se pierde la activación', async () => {
    const p = launchEmbeddedSignup('coexistence');
    // Sin ningún await: si el lanzador espera al SDK antes de abrir, acá todavía no hay popup.
    expect(llamadas).toHaveLength(1);
    // Se cierra el flujo para no dejar el candado tomado (el popup abierto ES el candado).
    responderLogin({ status: 'unknown', authResponse: null });
    await expect(p).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('popup BLOQUEADO por el navegador se reporta como tal, no como «cancelaste»', async () => {
    instalarSdkFalso({ popupBloqueado: true });
    await expect(launchEmbeddedSignup('coexistence')).rejects.toMatchObject({ reason: 'popup_blocked' });
  });

  it('sin SDK cargado no se miente: se pide reintentar, no se dice que canceló', async () => {
    delete window.FB;
    await expect(launchEmbeddedSignup('standard')).rejects.toMatchObject({ reason: 'sdk_load_failed' });
  });
});

describe('candado de concurrencia', () => {
  it('dos lanzamientos simultáneos no abren dos popups', async () => {
    const primero = launchEmbeddedSignup('standard');
    const segundo = launchEmbeddedSignup('coexistence');
    await expect(segundo).rejects.toMatchObject({ reason: 'in_progress' });
    expect(llamadas).toHaveLength(1);
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(primero).resolves.toMatchObject({ code: CODE });
  });

  it('el candado se libera al terminar: se puede reintentar', async () => {
    const primero = launchEmbeddedSignup('standard');
    responderLogin({ status: 'unknown', authResponse: null });
    await expect(primero).rejects.toMatchObject({ reason: 'cancelled' });
    const segundo = launchEmbeddedSignup('standard');
    responderLogin({ status: 'connected', authResponse: { code: CODE } });
    await expect(segundo).resolves.toMatchObject({ code: CODE });
  });
});

describe('cargador del SDK', () => {
  /**
   * El `<script>` se pre-crea SIN `src` a propósito: un test no le pide nada a la red. Además es
   * exactamente el caso que estaba roto —un elemento ya presente en el DOM—, que antes hacía que
   * el cargador volviera sin resolver ni rechazar.
   */
  const scriptPrecargado = () => {
    const s = document.createElement('script');
    s.id = 'facebook-jssdk';
    document.body.appendChild(s);
    return s;
  };

  it('un fallo de carga NO deja el reintento colgado para siempre', async () => {
    delete window.FB;
    const s1 = scriptPrecargado();
    const primera = preloadFacebookSdk('standard');
    s1.dispatchEvent(new Event('error'));
    await expect(primera).rejects.toMatchObject({ reason: 'sdk_load_failed' });
    // El elemento muerto se saca del DOM: si quedaba, el intento siguiente lo daba por bueno.
    expect(document.getElementById('facebook-jssdk')).toBeNull();

    // El reintento tiene que volver a intentar DE VERDAD: antes la promesa nueva no resolvía NI
    // rechazaba nunca y el botón quedaba «Conectando…» para siempre.
    const s2 = scriptPrecargado();
    const segunda = preloadFacebookSdk('standard');
    s2.dispatchEvent(new Event('error'));
    await expect(segunda).rejects.toMatchObject({ reason: 'sdk_load_failed' });
    document.getElementById('facebook-jssdk')?.remove();
  });

  it('con window.FB ya presente (stub o SDK cargado) no se toca el DOM', async () => {
    await expect(preloadFacebookSdk('standard')).resolves.toBeUndefined();
    expect(document.getElementById('facebook-jssdk')).toBeNull();
  });

  it('sin config no se carga nada: falla controlado', async () => {
    delete process.env['NEXT_PUBLIC_META_APP_ID'];
    await expect(preloadFacebookSdk('standard')).rejects.toBeInstanceOf(MetaSignupError);
  });
});

describe('contrato de tipos del flujo', () => {
  it('los dos flujos son valores explícitos (no un booleano encubierto)', () => {
    const flujos: MetaSignupFlow[] = ['standard', 'coexistence'];
    expect(flujos).toHaveLength(2);
  });
});
