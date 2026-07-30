/**
 * lib/catalogOwnership.ts — Helpers PUROS del modelo de propiedad del catálogo (ADR-0015),
 * lado panel.
 *
 * Sin imports de Firebase (solo constantes y funciones): testeables con vitest sin mocks.
 * Acá vive la TRADUCCIÓN a un idioma que entiende un comerciante ("quién publica el precio")
 * y el SANEADO de todo texto que llega del backend antes de pintarlo.
 *
 * Por qué el saneado también vive acá y no solo en el backend: la regla del programa es que
 * una URL firmada, su query string, un token o una credencial JAMÁS se guardan ni se muestran.
 * Confiar en que el emisor ya lo hizo es exactamente el supuesto que convirtió a
 * `sourceOfTruth` en un literal decorativo. Es defensa en profundidad: si un día el backend
 * filtra la URL del feed dentro del nombre de la fuente, el panel NO la pinta.
 */

/**
 * Campos PÚBLICOS del contrato de escritura que pueden tener dueño (espejo de
 * WRITABLE_FIELDS del backend). Deliberadamente NO incluye costo, márgenes ni notas
 * internas: esos son locales y jamás publicables ni delegables.
 */
export const CAMPOS_PUBLICOS = [
  'title',
  'description',
  'price',
  'currency',
  'availability',
  'inventory',
  'brand',
  'category',
  'image',
  'url',
] as const;
export type CampoPublico = (typeof CAMPOS_PUBLICOS)[number];

const SET_CAMPOS = new Set<string>(CAMPOS_PUBLICOS);

export function esCampoPublico(v: unknown): v is CampoPublico {
  return typeof v === 'string' && SET_CAMPOS.has(v);
}

/** Nombre de cada dato público en el idioma del comerciante (nunca el nombre técnico). */
export const CAMPO_LABEL: Record<CampoPublico, string> = {
  title: 'Nombre',
  description: 'Descripción',
  price: 'Precio',
  currency: 'Moneda',
  availability: 'Disponibilidad',
  inventory: 'Stock',
  brand: 'Marca',
  category: 'Categoría',
  image: 'Imagen',
  url: 'Enlace al producto',
};

export function etiquetaCampo(campo: string): string {
  return (CAMPO_LABEL as Record<string, string>)[campo] ?? campo;
}

/**
 * Campos cuya divergencia CORTA la venta automática (ADR-0015 §8): plata y disponibilidad.
 * El resto (nombre, descripción, imagen) es cosmético: avisa, no frena la conversación.
 */
export const CAMPOS_CRITICOS: readonly string[] = ['price', 'currency', 'availability', 'inventory'];

export function esCampoCritico(campo: string): boolean {
  return CAMPOS_CRITICOS.includes(campo);
}

// --- Etiquetas del modelo de propiedad ---------------------------------------

export type ModeloPropiedad = 'vendeyapy_managed' | 'external_managed' | 'hybrid';

export const MODELO_LABEL: Record<ModeloPropiedad, string> = {
  vendeyapy_managed: 'Lo administra VendeYaPy',
  external_managed: 'Lo administra tu propio sistema',
  hybrid: 'Compartido: cada dato tiene un dueño',
};

export const MODELO_EXPLICACION: Record<ModeloPropiedad, string> = {
  vendeyapy_managed:
    'Lo que cargás acá es lo que se publica en Meta. Ningún otro sistema debería estar publicando el mismo catálogo.',
  external_managed:
    'Tu sitio (o tu sistema de gestión) publica el catálogo en Meta. VendeYaPy lo lee, lo compara y te avisa, pero no escribe nada allá.',
  hybrid:
    'Algunos datos los publica VendeYaPy y otros los publica tu sistema. Cada dato tiene un solo dueño.',
};

/** Motivos por los que la propiedad quedó degradada, explicados sin jerga. */
export const MOTIVO_LABEL: Record<string, string> = {
  ownership_missing:
    'Todavía nadie declaró qué datos publica VendeYaPy y cuáles publica tu sistema.',
  ownership_malformed: 'La configuración de propiedad del catálogo quedó incompleta o no se entiende.',
  ownership_conflict: 'Hay datos declarados a la vez por VendeYaPy y por tu sistema: cada dato necesita un solo dueño.',
  ownership_never_publishable:
    'Alguien intentó publicar un dato interno (costo, margen o notas). Esos datos nunca salen de acá.',
  external_declaration_invalid: 'La fuente externa está declarada de forma incompleta y no se puede reconocer.',
  external_required: 'Falta reconocer la fuente externa que publica tu catálogo.',
  owned_fields_required: 'Falta declarar qué datos publica VendeYaPy.',
  hybrid_partition_missing: 'Falta declarar los datos de los dos lados: sin eso no se sabe quién manda.',
};

export function etiquetaMotivo(motivo: string): string {
  return MOTIVO_LABEL[motivo] ?? 'La configuración de propiedad del catálogo necesita revisión.';
}

export const TIPO_FUENTE_LABEL: Record<string, string> = {
  meta_feed: 'Archivo de catálogo de tu sitio',
  commerce_manager: 'Carga hecha en el Administrador de Comercio',
  other_api: 'Otro sistema conectado',
  desconocida: 'Fuente sin identificar',
};

export function etiquetaTipoFuente(kind: string): string {
  return TIPO_FUENTE_LABEL[kind] ?? TIPO_FUENTE_LABEL.desconocida!;
}

// --- Estado actual del artículo publicado (proyección que caduca, ADR-0015 §5) ---

export type EstadoMeta =
  | 'verified'
  | 'drifted'
  | 'drifted_external'
  | 'remote_missing'
  | 'unverifiable'
  | 'stale'
  | 'desconocido';

export const ESTADOS_META: readonly EstadoMeta[] = [
  'verified',
  'drifted',
  'drifted_external',
  'remote_missing',
  'unverifiable',
  'stale',
  'desconocido',
];

/**
 * Cómo se muestra el estado ACTUAL contra lo publicado. `verified` es lo único que puede
 * decir "coincide", y solo se escribe tras leer Meta de verdad: un job viejo en `succeeded`
 * no alcanza (ese fue el error que dejó a Odyssey en verde con 92 % de diferencia).
 */
export const ESTADO_META_INFO: Record<EstadoMeta, { label: string; tono: 'mint' | 'amber' | 'coral' | 'ink'; ayuda: string }> = {
  verified: {
    label: 'Coincide con lo publicado',
    tono: 'mint',
    ayuda: 'Leímos el catálogo publicado y quedó igual que acá.',
  },
  drifted: {
    label: 'Publicado distinto',
    tono: 'coral',
    ayuda: 'Lo publicado no coincide con los datos de acá.',
  },
  drifted_external: {
    label: 'Publicado distinto por tu sistema',
    tono: 'coral',
    ayuda: 'Tu sitio publicó datos distintos a los de acá. Se corrige en el origen que genera esa publicación.',
  },
  remote_missing: {
    label: 'Ya no está publicado',
    tono: 'amber',
    ayuda: 'El artículo dejó de aparecer en el catálogo publicado.',
  },
  unverifiable: {
    label: 'No pudimos verificarlo',
    tono: 'amber',
    ayuda: 'No conseguimos leer el catálogo publicado para comparar.',
  },
  stale: {
    // Se distingue a propósito de `desconocido`: "vencida" es una verificación que existió y
    // caducó; "sin verificar" es una que nunca ocurrió. Mezclarlas en una sola etiqueta hacía
    // imposible saber, mirando la grilla, si alguna vez leímos el catálogo publicado.
    label: 'Verificación vencida',
    tono: 'amber',
    ayuda:
      'Hace demasiado que no comparamos este artículo con lo publicado. Hasta volver a verificarlo no damos por confirmado el precio ni el stock.',
  },
  desconocido: {
    label: 'Sin verificar',
    tono: 'ink',
    ayuda: 'Todavía no comparamos este artículo con lo publicado.',
  },
};

/**
 * Estado que mostramos cuando el eje HISTÓRICO dice que Meta aceptó nuestro último envío pero
 * NADIE leyó el catálogo publicado desde entonces (producto sin `metaVerifiedAt`).
 *
 * Por qué no puede quedar en verde: `metaSyncStatus:'synced'` es una afirmación sobre el pasado
 * que nada caduca. Odyssey estuvo en "Confirmado — Meta confirmó que el artículo quedó igual que
 * acá" mientras el feed del tenant publicaba un precio 92 % más bajo. El verde solo lo puede
 * encender una lectura remota real y fresca (`verified`).
 */
export const ESTADO_SIN_VERIFICAR: { label: string; tono: 'mint' | 'amber' | 'coral' | 'ink'; ayuda: string } = {
  label: 'Sin verificar',
  tono: 'amber',
  ayuda:
    'Meta aceptó nuestro último envío, pero todavía no leímos el catálogo publicado para confirmar que siga igual.',
};

export function esEstadoMeta(v: unknown): v is EstadoMeta {
  return typeof v === 'string' && (ESTADOS_META as readonly string[]).includes(v);
}

// --- Saneado de todo texto que llega del backend ------------------------------

// Cualquier cosa con esquema o con "//host": jamás se pinta.
const RE_URL = /(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s<>"']+/gi;
// Fragmento con query string (?a=b): puede llevar la firma o el token del feed.
const RE_QUERY = /[^\s<>"']*\?[^\s<>"']*=[^\s<>"']*/g;
// Pares clave=valor sensibles sueltos en el texto.
const RE_SECRETO = /\b(?:access_token|token|apikey|api_key|api-key|key|secret|password|passwd|signature|sig|bearer)\s*[=:]\s*[^\s<>"']+/gi;
// Cadena opaca larga sin espacios: ningún nombre humano de feed se ve así.
const RE_OPACO = /[A-Za-z0-9_\-]{32,}/g;
// eslint-disable-next-line no-control-regex
const RE_CONTROL = /[\u0000-\u001F\u007F]/g;

/**
 * Texto público SANEADO: saca URLs, query strings, pares clave=valor sensibles y cadenas
 * opacas largas. Devuelve '' si no queda nada legible (el llamador muestra su fallback).
 */
export function sanitizarTextoPublico(raw: unknown, max = 120): string {
  if (typeof raw !== 'string') return '';
  const limpio = raw
    .replace(RE_CONTROL, ' ')
    .replace(RE_SECRETO, ' ')
    .replace(RE_URL, ' ')
    .replace(RE_QUERY, ' ')
    .replace(RE_OPACO, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1).trimEnd()}…` : limpio;
}

/**
 * Host de un enlace, SIN esquema, sin credenciales, sin ruta y sin query string. Es lo único
 * de un enlace que se puede mostrar sin riesgo de filtrar una firma.
 */
export function hostDe(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const m = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#\s]+)/i.exec(raw);
  const autoridad = m?.[1] ?? '';
  const host = autoridad.includes('@') ? autoridad.slice(autoridad.lastIndexOf('@') + 1) : autoridad;
  // Un host no lleva secretos, pero se corta igual por prolijidad visual.
  return host.toLowerCase().slice(0, 60);
}

/**
 * Horario legible de la fuente externa. Acepta el texto ya armado del backend o el objeto
 * con hora/minuto/zona. Nunca devuelve nada que venga de la URL del feed.
 *
 * `zonaRaw` es para la vista saneada del backend (`MetaCatalogDetectedSource`), que separa el
 * horario (`schedule: '03:33'`) de su zona (`timezone`). No se infiere ninguna frecuencia que
 * la fuente no haya declarado: con una hora suelta se dice "a las 03:33", nunca "todos los días".
 */
export function describirHorario(raw: unknown, zonaRaw?: unknown): string {
  if (typeof raw === 'string') {
    const texto = sanitizarTextoPublico(raw, 60);
    if (!texto) return '';
    const conHora = /^\d{1,2}:\d{2}$/.test(texto) ? `a las ${texto}` : texto;
    const zona = sanitizarTextoPublico(zonaRaw, 40);
    return zona && !conHora.includes(zona) ? `${conHora} (${zona})` : conHora;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const r = raw as Record<string, unknown>;
  const frecuencia =
    r.frequency === 'hourly' || r.interval === 'hourly'
      ? 'cada hora'
      : r.frequency === 'weekly' || r.interval === 'weekly'
        ? 'una vez por semana'
        : 'todos los días';
  const h = typeof r.hour === 'number' && Number.isFinite(r.hour) ? r.hour : null;
  const m = typeof r.minute === 'number' && Number.isFinite(r.minute) ? r.minute : 0;
  const zona = sanitizarTextoPublico(r.timezone ?? zonaRaw, 40);
  if (h == null) return zona ? `${frecuencia} (${zona})` : frecuencia;
  const hhmm = `${String(Math.trunc(h)).padStart(2, '0')}:${String(Math.trunc(m)).padStart(2, '0')}`;
  return zona ? `${frecuencia} a las ${hhmm} (${zona})` : `${frecuencia} a las ${hhmm}`;
}

// --- Valores comparables (local contra publicado) -----------------------------

export function formatearGuaranies(n: number): string {
  return '₲ ' + Math.round(n).toLocaleString('es-PY');
}

/** Disponibilidad de Meta traducida (el vendedor no tiene por qué leer "in stock"). */
export const DISPONIBILIDAD_LABEL: Record<string, string> = {
  'in stock': 'con stock',
  in_stock: 'con stock',
  'out of stock': 'sin stock',
  out_of_stock: 'sin stock',
  'available for order': 'a pedido',
  available_for_order: 'a pedido',
  preorder: 'por encargue',
  discontinued: 'discontinuado',
};

/**
 * Número escrito de cualquier forma razonable ("130000 PYG", "₲ 130.000", "1300,50").
 * El separador final cuenta como decimal solo si le siguen una o dos cifras: así "130.000"
 * es ciento treinta mil (formato local) y "1300.50" es mil trescientos con cincuenta.
 */
export function leerNumero(raw: string): number | null {
  const t = raw.replace(/[^\d.,]/g, '');
  if (!/\d/.test(t)) return null;
  const sep = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
  const cola = sep >= 0 ? t.slice(sep + 1) : '';
  const conDecimales = sep >= 0 && cola.length > 0 && cola.length <= 2 && /^\d+$/.test(cola);
  const enteros = (conDecimales ? t.slice(0, sep) : t).replace(/[.,]/g, '');
  if (!/^\d+$/.test(enteros) || enteros.length > 15) return null;
  const n = Number(conDecimales ? `${enteros}.${cola}` : enteros);
  return Number.isFinite(n) ? n : null;
}

/**
 * Valor de un campo listo para mostrar al lado del publicado.
 *
 * `image` y `url` se reducen al HOST a propósito: el enlace de una imagen publicada suele
 * venir firmado (query string con token) y esta UI nunca puede pintarlo. Con el host alcanza
 * para entender "la imagen la sirve otro sistema" sin filtrar nada. Si el backend ya lo
 * guardó saneado (host + path, sin query), se muestra tal cual pasa por el saneador.
 */
export function valorMostrable(campo: string, v: unknown): string {
  if (v == null || v === '') return '—';
  if (campo === 'image' || campo === 'url') {
    const host = hostDe(v);
    if (host) return `enlace de ${host}`;
    const limpio = sanitizarTextoPublico(v, 60);
    return limpio || '(otro enlace)';
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return campo === 'price' ? formatearGuaranies(v) : String(v);
  }
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (typeof v !== 'string') return '(dato no legible)';
  if (campo === 'availability') {
    const k = v.trim().toLowerCase();
    if (DISPONIBILIDAD_LABEL[k]) return DISPONIBILIDAD_LABEL[k]!;
  }
  if (campo === 'price') {
    // Meta devuelve el precio como texto: si se puede leer un número se muestra con el MISMO
    // formato que el local, porque si no la diferencia hay que buscarla a ojo.
    const n = leerNumero(v);
    if (n != null) return formatearGuaranies(n);
  }
  return sanitizarTextoPublico(v, 60) || '(dato no legible)';
}
