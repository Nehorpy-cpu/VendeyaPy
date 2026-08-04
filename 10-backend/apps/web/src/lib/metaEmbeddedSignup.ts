/**
 * metaEmbeddedSignup.ts — Lanzador del Embedded Signup de Meta (dos flujos · ADR-0017 §5)
 * =======================================================================================
 * Carga el Facebook JS SDK (una sola vez) y corre el Embedded Signup para obtener el `code` que el
 * panel le pasa al callable `connectMeta`. NO intercambia el token, NO lo guarda y NUNCA loguea el
 * `code`: solo lo devuelve al caller, que lo manda al backend (que lo intercambia server-side).
 *
 * DOS FLUJOS EXPLÍCITOS, y la diferencia no es cosmética:
 *
 *  · `standard` — alta de un número nuevo. `featureType: ''`. El string VACÍO **declara** el flujo
 *    estándar; no es «sin configurar». Es el camino que hoy funciona y no puede regresionar.
 *  · `coexistence` — el dueño mete un número que YA usa en la app WhatsApp Business, con clientes
 *    y conversaciones vivas adentro. `featureType: 'whatsapp_business_app_onboarding'` y su PROPIO
 *    `config_id` (el viejo valor `"coexistence"` se invalidó el 2025-05-29). Cierra con el evento
 *    `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, cuyo payload documentado trae **solo `waba_id`**:
 *    por eso acá NO se exige `phone_number_id` — el PNID lo resuelve el backend desde el WABA.
 *    Y va FAIL-CLOSED: sin ese evento válido no se llama al callable, aunque haya `code`.
 *
 * EL POPUP SE ABRE EN EL GESTO DEL USUARIO. `fb.login` se llama SINCRÓNICAMENTE al invocar esta
 * función: con `await` de por medio el navegador bloquea la ventana, y el código anterior reportaba
 * ese bloqueo como «cancelaste la conexión». En el teléfono del dueño, con la ventana de 24 h de
 * Coexistence corriendo, eso es mandarlo a buscar un error que no existe. Por eso el SDK se
 * PRECARGA aparte (`preloadFacebookSdk`) y el click no espera nada.
 *
 * Stubbeable/testeable: si `window.FB` ya existe (p. ej. un stub de test), se usa tal cual y no se
 * carga el script. Config por env: NEXT_PUBLIC_META_APP_ID, NEXT_PUBLIC_META_CONFIG_ID,
 * NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID, NEXT_PUBLIC_META_GRAPH_VERSION (default v19.0).
 */

const DEFAULT_GRAPH_VERSION = 'v19.0';
const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';
const SDK_SCRIPT_ID = 'facebook-jssdk';
/** Si el SDK no cargó en este plazo, se falla y se permite reintentar. Nunca se cuelga. */
const SDK_TIMEOUT_MS = 20_000;
/**
 * Cuánto se espera el postMessage de cierre DESPUÉS de que el SDK ya devolvió el `code`. Los dos
 * canales son independientes (callback del SDK vs `postMessage`) y no hay orden garantizado entre
 * ellos: sin esta gracia, una carrera normal se leería como «no completaste el onboarding».
 */
const CIERRE_GRACIA_MS = 600;
const CIERRE_INTERVALO_MS = 25;

/** Solo estos orígenes pueden hablarle a esta página en nombre del Embedded Signup. */
const ORIGENES_META = Object.freeze(['https://www.facebook.com', 'https://web.facebook.com']);

/** Los dos onboardings posibles. Valores explícitos: un booleano encubierto se lee al revés. */
export type MetaSignupFlow = 'standard' | 'coexistence';

/**
 * Evento de cierre POR FLUJO. Es lo que hace distinguible un FINISH estándar de uno de
 * Coexistence — hasta acá el listener no miraba `msg.event` y los dos eran el mismo mensaje.
 * El estándar acepta también `FINISH_ONLY_WABA` (WABA sin número, que Meta cierra igual).
 */
const EVENTOS_DE_CIERRE: Readonly<Record<MetaSignupFlow, readonly string[]>> = Object.freeze({
  standard: Object.freeze(['FINISH', 'FINISH_ONLY_WABA']),
  coexistence: Object.freeze(['FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING']),
});

/** El `featureType` con el que se declara cada flujo. El vacío ES el estándar (no es «sin valor»). */
const FEATURE_TYPE: Readonly<Record<MetaSignupFlow, string>> = Object.freeze({
  standard: '',
  coexistence: 'whatsapp_business_app_onboarding',
});

export type MetaSignupErrorReason =
  | 'not_configured'
  | 'cancelled'
  | 'sdk_load_failed'
  /** El navegador bloqueó la ventana. NO es una cancelación del usuario. */
  | 'popup_blocked'
  /** Ya hay un onboarding abierto: dos popups se pisarían entre sí. */
  | 'in_progress'
  /** Coexistence fail-closed: no llegó el evento de cierre válido de ESTE flujo. */
  | 'incomplete_signup';

/** Error controlado del Embedded Signup. La UI lo mapea a un mensaje (friendlyMetaError). */
export class MetaSignupError extends Error {
  constructor(
    public readonly reason: MetaSignupErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'MetaSignupError';
  }
}

/** Datos que el popup del Embedded Signup puede entregar (todos opcionales). */
export interface MetaSessionInfo {
  phoneNumberId?: string;
  wabaId?: string;
  businessId?: string;
}

export interface EmbeddedSignupResult {
  code: string;
  /** Con qué flujo se completó. Viaja hasta el callable: el nonce está atado al modo. */
  flow: MetaSignupFlow;
  sessionInfo?: MetaSessionInfo;
}

// ---- Tipos mínimos del FB JS SDK (lo que usamos) ----
interface FBLoginResponse {
  status?: string;
  authResponse?: { code?: string } | null;
}
interface FBSdk {
  init(params: { appId: string; version: string; cookie?: boolean; xfbml?: boolean }): void;
  login(cb: (response: FBLoginResponse) => void, opts?: Record<string, unknown>): void;
}
declare global {
  interface Window {
    FB?: FBSdk;
    fbAsyncInit?: () => void;
  }
}

interface MetaSignupConfig {
  appId: string;
  configId: string;
  version: string;
}

/**
 * Lee la config de env en tiempo de llamada (testeable). null si falta App ID o el config_id DEL
 * FLUJO PEDIDO. Cada acceso a `process.env` es literal a propósito: Next.js solo inlinea las
 * `NEXT_PUBLIC_*` cuando puede verlas escritas, y un índice calculado quedaría `undefined` en el
 * bundle. Coexistence JAMÁS cae al config_id estándar: sería lanzar el onboarding equivocado.
 */
function readConfig(flow: MetaSignupFlow): MetaSignupConfig | null {
  const appId = process.env['NEXT_PUBLIC_META_APP_ID'];
  const configId =
    flow === 'coexistence' ? process.env['NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID'] : process.env['NEXT_PUBLIC_META_CONFIG_ID'];
  if (!appId || !configId) return null;
  return { appId, configId, version: process.env['NEXT_PUBLIC_META_GRAPH_VERSION'] || DEFAULT_GRAPH_VERSION };
}

/**
 * Hay config para el flujo real del Embedded Signup. ÚNICA fuente de verdad de esta pregunta:
 * `integrations.ts` la re-exporta en vez de duplicar la lectura de env (dos lecturas del mismo
 * flag terminan divergiendo, y la laxa es la que muestra un botón que no funciona).
 */
export function isEmbeddedSignupConfigured(flow: MetaSignupFlow = 'standard'): boolean {
  return readConfig(flow) !== null;
}

// ---------------------------------------------------------------------------
// Cargador del SDK
// ---------------------------------------------------------------------------

// Singleton de carga: garantiza que el SDK se cargue/inicialice una sola vez.
let sdkPromise: Promise<FBSdk> | null = null;

function loadFacebookSdk(appId: string, version: string): Promise<FBSdk> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new MetaSignupError('sdk_load_failed', 'El Embedded Signup solo corre en el navegador.'));
  }
  // Ya disponible (incluye stubs de test que setean window.FB) → no cargar el script.
  if (window.FB) return Promise.resolve(window.FB);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<FBSdk>((resolve, reject) => {
    let terminado = false;
    let temporizador: ReturnType<typeof setTimeout> | undefined;

    /**
     * Fallar SIEMPRE deja el mundo listo para reintentar. Antes no: `onerror` limpiaba la promesa
     * pero dejaba el `<script>` muerto en el DOM, así que el intento siguiente entraba por la rama
     * «ya existe» y no resolvía NI rechazaba nunca — el botón quedaba «Conectando…» para siempre.
     */
    const fallar = (mensaje: string) => {
      if (terminado) return;
      terminado = true;
      if (temporizador) clearTimeout(temporizador);
      sdkPromise = null;
      document.getElementById(SDK_SCRIPT_ID)?.remove();
      reject(new MetaSignupError('sdk_load_failed', mensaje));
    };
    const listo = (fb: FBSdk) => {
      if (terminado) return;
      terminado = true;
      if (temporizador) clearTimeout(temporizador);
      resolve(fb);
    };

    window.fbAsyncInit = () => {
      const fb = window.FB;
      if (!fb) {
        fallar('No se pudo inicializar el SDK de Meta.');
        return;
      }
      try {
        fb.init({ appId, version, cookie: false, xfbml: false });
        listo(fb);
      } catch {
        fallar('No se pudo inicializar el SDK de Meta.');
      }
    };

    // Red lenta o script servido pero sin ejecutar `fbAsyncInit`: se falla, no se cuelga.
    temporizador = setTimeout(() => fallar('La conexión con Meta tardó demasiado. Probá de nuevo.'), SDK_TIMEOUT_MS);

    const existente = document.getElementById(SDK_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existente ?? document.createElement('script');
    script.addEventListener('error', () => fallar('No se pudo cargar el SDK de Meta. Revisá tu conexión e intentá de nuevo.'), { once: true });
    if (!existente) {
      script.id = SDK_SCRIPT_ID;
      script.src = SDK_SRC;
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      document.body.appendChild(script);
    }
  });
  return sdkPromise;
}

/**
 * Precarga el SDK para que el click del dueño pueda abrir el popup SIN esperar nada. Se llama
 * desde un efecto de la pantalla cuando ya hay config. Idempotente.
 */
export async function preloadFacebookSdk(flow: MetaSignupFlow = 'standard'): Promise<void> {
  const cfg = readConfig(flow);
  if (!cfg) throw new MetaSignupError('not_configured', 'La conexión con Meta todavía no está habilitada.');
  await loadFacebookSdk(cfg.appId, cfg.version);
}

// ---------------------------------------------------------------------------
// Escucha del postMessage
// ---------------------------------------------------------------------------

interface CierreObservado {
  event: string;
  data: Record<string, unknown>;
}

interface EscuchaSignup {
  /** La ventana que ESTE código abrió; a partir de acá solo se aceptan mensajes suyos. */
  fijarVentana(v: Window | null): void;
  cierre(): CierreObservado | undefined;
  cancelado(): boolean;
  sessionInfo(): MetaSessionInfo | undefined;
  cleanup(): void;
}

/** Lee los ids del payload aceptando solo escalares: un objeto acá sería basura, no un id. */
function leerIds(d: Record<string, unknown>): MetaSessionInfo {
  const capturado: MetaSessionInfo = {};
  const texto = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return undefined;
  };
  const pnid = texto(d['phone_number_id']);
  const waba = texto(d['waba_id']);
  const negocio = texto(d['business_id']);
  if (pnid) capturado.phoneNumberId = pnid;
  if (waba) capturado.wabaId = waba;
  if (negocio) capturado.businessId = negocio;
  return capturado;
}

/**
 * ¿El mensaje vino de la ventana que abrimos? El origin solo dice «lo mandó facebook.com»:
 * cualquier iframe de facebook.com embebido en la página cumple eso y podía inyectar un
 * `sessionInfo` con el WABA que quisiera. La ventana esperada es la que devolvió `window.open`.
 */
function fuenteConfiable(source: MessageEventSource | null, esperada: Window | null): boolean {
  if (esperada) return source === (esperada as unknown as MessageEventSource);
  // Sin handle (el SDK no usó window.open): al menos se rechaza esta misma página y sus iframes.
  if (!source || (source as unknown) === window) return false;
  const frames = window.frames as Window | undefined;
  if (frames) {
    for (let i = 0; i < frames.length; i++) {
      if ((source as unknown) === frames[i]) return false;
    }
  }
  return true;
}

function escucharSignup(flow: MetaSignupFlow): EscuchaSignup {
  let ventanaEsperada: Window | null = null;
  let cierre: CierreObservado | undefined;
  let cancelado = false;
  let info: MetaSessionInfo | undefined;

  const handler = (event: MessageEvent) => {
    if (!ORIGENES_META.includes(event.origin)) return;
    if (!fuenteConfiable(event.source, ventanaEsperada)) return;
    let raw: unknown;
    try {
      raw = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return; // mensaje no-JSON ajeno al ES
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const msg = raw as { type?: unknown; event?: unknown; data?: unknown };
    if (msg.type !== 'WA_EMBEDDED_SIGNUP') return;
    const d = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data) ? (msg.data as Record<string, unknown>) : {};
    const evento = typeof msg.event === 'string' ? msg.event : '';

    if (EVENTOS_DE_CIERRE[flow].includes(evento)) cierre = { event: evento, data: d };
    else if (evento === 'CANCEL' || evento === 'ERROR') cancelado = true;

    // sessionInfo es BEST-EFFORT y se acumula: el estándar lo aprovecha venga en el mensaje que
    // venga (así se comportaba antes), y Coexistence igual solo confía en su evento de cierre.
    const capturado = leerIds(d);
    if (capturado.phoneNumberId || capturado.wabaId || capturado.businessId) info = { ...info, ...capturado };
  };

  window.addEventListener('message', handler);
  return {
    fijarVentana: (v) => { ventanaEsperada = v; },
    cierre: () => cierre,
    cancelado: () => cancelado,
    sessionInfo: () => info,
    cleanup: () => window.removeEventListener('message', handler),
  };
}

// ---------------------------------------------------------------------------
// Lanzamiento
// ---------------------------------------------------------------------------

/**
 * Candado a nivel MÓDULO (no por componente): con dos botones en pantalla, dos popups del Embedded
 * Signup se pisan entre sí y el segundo `code` invalida al primero.
 */
let enCurso = false;

/**
 * Corre `abrir` interceptando `window.open` para (a) quedarse con el handle de la ventana —única
 * forma de validar después el `event.source` del postMessage— y (b) DETECTAR el bloqueo del
 * navegador: si el SDK intentó abrir y no obtuvo ventana, el popup fue bloqueado. Es determinístico,
 * no una heurística de tiempos.
 */
function conInterceptorDePopup(abrir: () => void): { ventana: Window | null; bloqueado: boolean } {
  let ventana: Window | null = null;
  let intento = false;
  const original = window.open;
  window.open = function (...args: Parameters<typeof window.open>) {
    intento = true;
    const w = original.apply(window, args) as Window | null;
    if (!ventana) ventana = w;
    return w;
  } as typeof window.open;
  try {
    abrir();
  } finally {
    window.open = original;
  }
  return { ventana, bloqueado: intento && !ventana };
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cada cuánto se mira si el dueño cerró la ventana, y hasta cuándo se la vigila. */
const VIGILANCIA_MS = 500;
const VIGILANCIA_MAX_MS = 15 * 60_000;

/**
 * El candado de módulo se libera cuando ESTA promesa termina, así que una promesa que nunca
 * termina sería un candado tomado para siempre: el dueño no podría reintentar, justo durante la
 * ventana de 24 h. El SDK avisa cuando el popup se cierra, pero si por lo que sea no avisa, esta
 * vigilancia lo trata como cancelación. Termina sola en cuanto el SDK contesta.
 */
async function esperarRespuesta(respuesta: Promise<FBLoginResponse>, ventana: Window | null): Promise<FBLoginResponse> {
  if (!ventana) return respuesta;
  let terminado = false;
  const marcar = () => { terminado = true; };
  respuesta.then(marcar, marcar);
  const vigilancia = (async (): Promise<FBLoginResponse> => {
    const limite = Date.now() + VIGILANCIA_MAX_MS;
    while (!terminado && Date.now() < limite) {
      await dormir(VIGILANCIA_MS);
      if (terminado) break;
      // Doble confirmación: `closed` puede verse true un instante mientras el SDK redirige.
      if (ventana.closed) {
        await dormir(VIGILANCIA_MS);
        if (terminado) break;
        if (ventana.closed) return { status: 'unknown', authResponse: null };
      }
    }
    return respuesta;
  })();
  return Promise.race([respuesta, vigilancia]);
}

/** Espera el cierre unos milisegundos: los dos canales (SDK y postMessage) corren en paralelo. */
async function esperarCierre(escucha: EscuchaSignup): Promise<CierreObservado | undefined> {
  const limite = Date.now() + CIERRE_GRACIA_MS;
  let observado = escucha.cierre();
  while (!observado && Date.now() < limite) {
    await dormir(CIERRE_INTERVALO_MS);
    observado = escucha.cierre();
  }
  return observado;
}

/**
 * Corre el Embedded Signup del flujo pedido y resuelve con { code, flow, sessionInfo? }.
 *
 * IMPORTANTE PARA QUIEN LA LLAME: invocala DIRECTO en el handler del click, sin `await` antes.
 * El cuerpo abre el popup sincrónicamente; todo lo demás (pedir el nonce, etc.) puede correr en
 * paralelo mientras el dueño está en la ventana de Meta.
 */
export async function launchEmbeddedSignup(flow: MetaSignupFlow = 'standard'): Promise<EmbeddedSignupResult> {
  const cfg = readConfig(flow);
  if (!cfg) {
    throw new MetaSignupError(
      'not_configured',
      flow === 'coexistence'
        ? 'La conexión de un número que ya usás en WhatsApp Business todavía no está habilitada.'
        : 'La conexión con Meta todavía no está habilitada.',
    );
  }
  if (enCurso) {
    throw new MetaSignupError('in_progress', 'Ya hay una conexión con Meta en curso. Terminá esa ventana antes de abrir otra.');
  }
  if (typeof window === 'undefined') {
    throw new MetaSignupError('sdk_load_failed', 'El Embedded Signup solo corre en el navegador.');
  }
  const fb = window.FB;
  if (!fb) {
    // No se espera el SDK acá: esperarlo es justamente lo que hace que el navegador bloquee el
    // popup. La pantalla lo precarga y mantiene el botón deshabilitado hasta que esté listo.
    throw new MetaSignupError('sdk_load_failed', 'Estamos preparando la conexión con Meta. Esperá unos segundos y probá de nuevo.');
  }

  enCurso = true;
  const escucha = escucharSignup(flow);
  try {
    let respuesta!: Promise<FBLoginResponse>;
    const apertura = conInterceptorDePopup(() => {
      respuesta = new Promise<FBLoginResponse>((resolve) => {
        fb.login(resolve, {
          config_id: cfg.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, featureType: FEATURE_TYPE[flow], sessionInfoVersion: '3' },
        });
      });
    });
    escucha.fijarVentana(apertura.ventana);

    if (apertura.bloqueado) {
      throw new MetaSignupError(
        'popup_blocked',
        'El navegador bloqueó la ventana de Meta. Permití las ventanas emergentes para este sitio y volvé a intentarlo.',
      );
    }

    const response = await esperarRespuesta(respuesta, apertura.ventana);
    if (response.status && response.status !== 'connected') {
      throw new MetaSignupError('cancelled', 'Cancelaste la conexión con Meta. Podés intentarlo de nuevo cuando quieras.');
    }
    const code = response.authResponse?.code;
    if (!code) {
      throw new MetaSignupError('cancelled', 'No se completó la autorización de Meta. Probá de nuevo.');
    }

    if (flow === 'coexistence') {
      // FAIL-CLOSED. Un `code` sin el evento de cierre de ESTE flujo no prueba que el dueño haya
      // pasado por el onboarding de la app de WhatsApp Business: conectar igual sería tocar un
      // número con clientes vivos sin la confirmación de Meta.
      const cierre = await esperarCierre(escucha);
      const wabaId = cierre ? leerIds(cierre.data).wabaId : undefined;
      if (!cierre || !wabaId) {
        throw new MetaSignupError(
          'incomplete_signup',
          escucha.cancelado()
            ? 'No se completó la conexión de tu número de WhatsApp Business. Podés volver a intentarlo.'
            : 'Meta no confirmó la conexión de tu número de WhatsApp Business. Volvé a intentarlo desde el botón.',
        );
      }
      // Solo lo que el cierre documentado promete. El `phone_number_id` NO se exige: la página
      // específica de Meta no lo incluye, y el backend lo resuelve desde el WABA.
      return { code, flow, sessionInfo: leerIds(cierre.data) };
    }

    // Estándar: sessionInfo best-effort, igual que siempre. Si no vino, alcanza con el code y el
    // backend descubre el WABA.
    const sessionInfo = escucha.sessionInfo();
    return sessionInfo ? { code, flow, sessionInfo } : { code, flow };
  } finally {
    escucha.cleanup();
    enCurso = false;
  }
}
