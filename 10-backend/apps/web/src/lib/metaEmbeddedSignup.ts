/**
 * metaEmbeddedSignup.ts — Lanzador del Embedded Signup de Meta (Meta Connect UX · M-2)
 * ===================================================================================
 * Carga el Facebook JS SDK (una sola vez) y corre el Embedded Signup para obtener el `code`
 * que M-3 le pasará al callable connectMeta. NO intercambia el token, NO lo guarda y NUNCA
 * loguea el `code`: solo lo devuelve al caller, que lo manda al backend (que lo intercambia
 * server-side). `sessionInfo` (waba/phone/business) es BEST-EFFORT: si el popup lo entrega vía
 * postMessage lo adjuntamos; si no, basta con { code } y el backend descubre el WABA del token.
 *
 * Stubbeable/testeable: si `window.FB` ya existe (p. ej. un stub de test), se usa tal cual y no
 * se carga el script. Config por env: NEXT_PUBLIC_META_APP_ID, NEXT_PUBLIC_META_CONFIG_ID,
 * NEXT_PUBLIC_META_GRAPH_VERSION (default v19.0). Sin config → error controlado `not_configured`.
 */

const DEFAULT_GRAPH_VERSION = 'v19.0';
const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';
const SDK_SCRIPT_ID = 'facebook-jssdk';

export type MetaSignupErrorReason = 'not_configured' | 'cancelled' | 'sdk_load_failed';

/** Error controlado del Embedded Signup. M-3 lo mapea a un mensaje en la UI (friendlyMetaError). */
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

/** Lee la config de env en tiempo de llamada (testeable). null si falta App ID o config_id. */
function readConfig(): MetaSignupConfig | null {
  const appId = process.env['NEXT_PUBLIC_META_APP_ID'];
  const configId = process.env['NEXT_PUBLIC_META_CONFIG_ID'];
  if (!appId || !configId) return null;
  return { appId, configId, version: process.env['NEXT_PUBLIC_META_GRAPH_VERSION'] || DEFAULT_GRAPH_VERSION };
}

/** Hay config para el flujo real del Embedded Signup. */
export function isEmbeddedSignupConfigured(): boolean {
  return readConfig() !== null;
}

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
    window.fbAsyncInit = () => {
      const fb = window.FB;
      if (!fb) {
        reject(new MetaSignupError('sdk_load_failed', 'No se pudo inicializar el SDK de Meta.'));
        return;
      }
      try {
        fb.init({ appId, version, cookie: false, xfbml: false });
        resolve(fb);
      } catch {
        reject(new MetaSignupError('sdk_load_failed', 'No se pudo inicializar el SDK de Meta.'));
      }
    };
    // No cargar dos veces el script (idempotente entre montajes).
    if (document.getElementById(SDK_SCRIPT_ID)) {
      if (window.FB) resolve(window.FB);
      return; // fbAsyncInit resolverá cuando el SDK existente termine de cargar.
    }
    const script = document.createElement('script');
    script.id = SDK_SCRIPT_ID;
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdkPromise = null; // permitir reintento
      reject(new MetaSignupError('sdk_load_failed', 'No se pudo cargar el SDK de Meta. Revisá tu conexión e intentá de nuevo.'));
    };
    document.body.appendChild(script);
  });
  return sdkPromise;
}

/** Escucha el postMessage del Embedded Signup para capturar sessionInfo (best-effort). */
function listenSessionInfo(): { get: () => MetaSessionInfo | undefined; cleanup: () => void } {
  let info: MetaSessionInfo | undefined;
  const handler = (event: MessageEvent) => {
    if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
    let raw: unknown;
    try {
      raw = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return; // mensaje no-JSON ajeno al ES
    }
    const msg = (raw ?? {}) as { type?: string; event?: string; data?: Record<string, unknown> };
    if (msg.type !== 'WA_EMBEDDED_SIGNUP') return;
    const d = msg.data ?? {};
    const captured: MetaSessionInfo = {};
    if (d['phone_number_id']) captured.phoneNumberId = String(d['phone_number_id']);
    if (d['waba_id']) captured.wabaId = String(d['waba_id']);
    if (d['business_id']) captured.businessId = String(d['business_id']);
    if (captured.phoneNumberId || captured.wabaId || captured.businessId) info = captured;
  };
  window.addEventListener('message', handler);
  return { get: () => info, cleanup: () => window.removeEventListener('message', handler) };
}

/**
 * Corre el Embedded Signup y resuelve con { code, sessionInfo? }.
 * Lanza MetaSignupError: 'not_configured' (falta env), 'cancelled' (el usuario cierra/no autoriza),
 * 'sdk_load_failed' (no se pudo cargar/inicializar el SDK). NUNCA loguea el code ni guarda tokens.
 */
export async function launchEmbeddedSignup(): Promise<EmbeddedSignupResult> {
  const cfg = readConfig();
  if (!cfg) {
    throw new MetaSignupError('not_configured', 'La conexión con Meta todavía no está habilitada.');
  }

  const fb = await loadFacebookSdk(cfg.appId, cfg.version);
  const session = listenSessionInfo();
  try {
    const response = await new Promise<FBLoginResponse>((resolve) => {
      fb.login(resolve, {
        config_id: cfg.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      });
    });

    if (response.status && response.status !== 'connected') {
      throw new MetaSignupError('cancelled', 'Cancelaste la conexión con Meta. Podés intentarlo de nuevo cuando quieras.');
    }
    const code = response.authResponse?.code;
    if (!code) {
      throw new MetaSignupError('cancelled', 'No se completó la autorización de Meta. Probá de nuevo.');
    }

    // sessionInfo es opcional: si vino del popup la adjuntamos; si no, { code } basta.
    const sessionInfo = session.get();
    return sessionInfo ? { code, sessionInfo } : { code };
  } finally {
    session.cleanup();
  }
}
