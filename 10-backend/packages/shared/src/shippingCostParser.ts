/**
 * SHIPPING-CHAT-1 (ADR-0011) — Parser DETERMINÍSTICO del costo de envío escrito por el vendedor.
 * ====================================================================================================
 * Vive en `@vpw/shared` para que el panel (preview) y el backend (autoridad) importen EXACTAMENTE la
 * misma lógica. El backend lo re-ejecuta y es la autoridad final (SHIPPING-CHAT-3); el frontend solo
 * previsualiza. La IA NUNCA determina dinero.
 *
 * Postura financiera (conservadora): ante cualquier duda devuelve `none`/ambiguo — jamás inventa un
 * monto. Un número solo se considera costo de envío si:
 *   1) lleva una SEÑAL MONETARIA (marcador ₲/Gs, multiplicador mil/k, o agrupación de miles "30.000"),
 *      lo que descarta teléfonos, direcciones, fechas, cantidades y años crudos; y
 *   2) está ASOCIADO a una palabra de contexto de envío (misma cláusula, sin cruzar " y "/coma/punto).
 * Si hay más de un candidato asociado con valores distintos ⇒ ambiguo (none).
 *
 * PRIVACIDAD: función PURA, sin logging. Los callers NUNCA deben loguear el texto del vendedor.
 */

export const PARSER_VERSION = 'shipping-parser-1';

/** Tope defensivo por defecto (guaraníes). Configurable por tenant vía coverage.shippingQuote.maxChargeGs. */
export const DEFAULT_MAX_SHIPPING_GS = 5_000_000;

export type ShippingParseResult =
  | { kind: 'matched'; shippingGs: number; parserVersion: string }
  | { kind: 'free'; shippingGs: 0; parserVersion: string }
  | {
      kind: 'none';
      /** Motivo estable (para tests/telemetría, sin PII): vacio | sin_contexto_envio | sin_monto |
       *  monto_ambiguo | monto_invalido | excede_maximo | cero_sin_gratuidad | gratis_con_monto. */
      reason: string;
      parserVersion: string;
    };

const matched = (gs: number): ShippingParseResult => ({ kind: 'matched', shippingGs: gs, parserVersion: PARSER_VERSION });
const free = (): ShippingParseResult => ({ kind: 'free', shippingGs: 0, parserVersion: PARSER_VERSION });
const none = (reason: string): ShippingParseResult => ({ kind: 'none', reason, parserVersion: PARSER_VERSION });

/** Minúsculas + sin acentos (literal, sin escapes \u). "Envío" → "envio". */
function normalizar(s: string): string {
  return s
    .toLowerCase()
    .replace(/á/g, 'a').replace(/à/g, 'a').replace(/ä/g, 'a')
    .replace(/é/g, 'e').replace(/è/g, 'e').replace(/ë/g, 'e')
    .replace(/í/g, 'i').replace(/ì/g, 'i').replace(/ï/g, 'i')
    .replace(/ó/g, 'o').replace(/ò/g, 'o').replace(/ö/g, 'o')
    .replace(/ú/g, 'u').replace(/ù/g, 'u').replace(/ü/g, 'u')
    .replace(/ñ/g, 'n');
}

/**
 * Palabras de contexto de envío (ya normalizadas; admite plural). Vocabulario DELIBERADO y acotado:
 * sinónimos ambiguos (p.ej. "reparto", que también es reparto de utilidades) se excluyen a propósito;
 * un envío escrito con esas palabras cae a `none` (seguro) y un humano lo confirma manualmente.
 */
const CONTEXTO_RE = /\b(envios?|delivery|entregas?|fletes?|traslados?)\b/g;
/** Frase inequívoca de gratuidad (₲0). "gratis"/"gratuito"/"sin costo"/"sin cargo"/"bonificado". */
const GRATIS_RE = /\b(gratis|gratuito|bonificad[oa]|sin\s+(costo|cargo))\b/;
/**
 * Token de dinero. Captura: 1=núcleo entero (miles con '.' o dígitos crudos); 2=decimal MALFORMADO
 * (para rechazar guaraníes con centavos); 3=multiplicador (mil/k). Prefijo/sufijo ₲/Gs opcionales.
 */
const MONEY_RE = /(₲\s*|gs\.?\s*)?(\d{1,3}(?:\.\d{3})+|\d+)([.,]\d+)?(?:\s?(mil|k))?(?:\s?(gs\.?|₲))?/gi;

/**
 * Separadores que cortan la ventana "después" (coma, " y ", ". ", ";", salto): un monto tras uno de
 * estos límites pertenece a otra cláusula/ítem y NO se asocia al envío (evita tomar el precio del
 * producto, p.ej. "delivery, el perfume cuesta 250.000"). NO incluye " o " (alternativa entre montos
 * de envío ⇒ debe quedar ambiguo). Costo aceptado: un monto pegado tras coma ("envío, cuesta X") cae
 * a none (conservador — jamás cobrar de más).
 */
const CORTE_DESPUES = /,|\sy\s|\. |;|\n/;
/**
 * Relleno admisible entre un monto PREVIO y la palabra de envío ("son ₲30.000 [de] envío").
 * Solo palabras funcionales: si aparece cualquier otra palabra (p.ej. "mas", "perfume"), una coma o un
 * punto (fin de oración), el monto pertenece a otra cláusula y NO se asocia al envío. Sin "\." suelto:
 * un precio de una oración anterior cerrada con punto ("₲250.000. El envío...") no debe puentearse.
 */
const RELLENO_ANTES = /^(?:\s|de|del|el|la|los|las|un|una|por|para|:|=|es|son|cuesta|sale|vale|₲|gs\.?)*$/i;

const VENTANA_DESPUES = 40; // chars tras la palabra de envío donde buscar el monto
const VENTANA_ANTES = 25; // chars antes (para "son ₲30.000 de envío")

interface MoneyToken {
  /** Valor entero en Gs, o null si es money-shaped pero INVÁLIDO (decimal/grouping/overflow/sci/negativo). */
  value: number | null;
  /** ¿Tiene señal monetaria? Sin señal (número crudo) NO se considera costo de envío. */
  hasSignal: boolean;
  index: number;
  end: number;
}

/** Parsea el núcleo de un token a un valor entero en Gs, o null si es inválido. */
function valorDeToken(core: string, decimal: string | undefined, mult: string | undefined, negativo: boolean, pegado: boolean): number | null {
  if (negativo) return null; // "-30000"
  if (decimal) return null; // "30.5" / "30,50" — guaraníes son enteros, sin centavos
  if (pegado) return null; // "3e4" / "30.0000" / "30kg" (basura pegada al número)
  const tieneDot = core.includes('.');
  if (tieneDot && !/^\d{1,3}(\.\d{3})+$/.test(core)) return null; // agrupación de miles inválida
  if (tieneDot && core.startsWith('0')) return null; // grupo líder '0' ("0.500") es agrupación malformada
  if (mult && tieneDot) return null; // "30.000 mil" no tiene sentido
  const digits = core.replace(/\./g, '');
  if (digits.length > 12) return null; // guarda de overflow (antes de Number())
  let v = Number(digits);
  if (!Number.isFinite(v) || !Number.isInteger(v)) return null;
  if (mult) v = v * 1000;
  if (!Number.isSafeInteger(v) || v < 0) return null;
  return v;
}

/** Todos los tokens de dinero del texto normalizado, con valor, señal y posición. */
function tokensDeDinero(n: string): MoneyToken[] {
  const out: MoneyToken[] = [];
  for (const m of n.matchAll(MONEY_RE)) {
    const core = m[2];
    if (core === undefined) continue; // el núcleo numérico es obligatorio en la regex
    const idx = m.index ?? 0;
    const full = m[0];
    const negativo = idx > 0 && n[idx - 1] === '-';
    const after = n[idx + full.length];
    // dígito/letra pegada que NO es unidad ya consumida ⇒ formato inválido:
    //   "3e4" (notación científica), "30.0000" (agrupación mal formada), "30kg" (unidad ajena).
    const pegado = !!after && /[a-z0-9]/.test(after);
    const hasMarker = !!m[1] || !!m[4] || !!m[5]; // marcador ₲/Gs (prefijo o sufijo) o multiplicador mil/k
    const hasGrouping = core.includes('.');
    out.push({
      value: valorDeToken(core, m[3], m[4], negativo, pegado),
      hasSignal: hasMarker || hasGrouping,
      index: idx,
      end: idx + full.length,
    });
  }
  return out;
}

/** ¿Hay gratuidad inequívoca asociada al envío y NO negada? */
function esGratis(n: string, ctxPositions: number[]): boolean {
  for (const pos of ctxPositions) {
    const span = n.slice(Math.max(0, pos - VENTANA_ANTES), pos + VENTANA_DESPUES);
    const at = span.search(GRATIS_RE);
    if (at === -1) continue;
    // negación simple: "no ..." antes de la frase de gratuidad la invalida.
    if (/\bno\b/.test(span.slice(0, at))) continue;
    return true;
  }
  return false;
}

/** Fin de la ventana "después" recortada en el primer separador de cláusula. */
function finDespues(n: string, pos: number): number {
  const raw = n.slice(pos, pos + VENTANA_DESPUES);
  const cut = raw.search(CORTE_DESPUES);
  return pos + (cut === -1 ? raw.length : cut);
}

/**
 * ¿El token PREVIO a la palabra de envío (pos) está asociado? Solo si está dentro de la ventana y lo
 * que hay entre el fin del token y `pos` es puro relleno funcional ("son ₲30.000 de envío").
 */
function asociadoAntes(n: string, pos: number, t: MoneyToken): boolean {
  if (t.end > pos || t.index < pos - VENTANA_ANTES) return false;
  return RELLENO_ANTES.test(n.slice(t.end, pos));
}

/**
 * Detecta el costo de envío en el borrador del vendedor. Determinístico y conservador.
 * @param text  borrador crudo del vendedor (nunca se loguea).
 * @param opts.maxChargeGs  tope defensivo (default DEFAULT_MAX_SHIPPING_GS).
 */
export function parseShippingCost(text: unknown, opts?: { maxChargeGs?: number }): ShippingParseResult {
  const rawMax = opts?.maxChargeGs;
  const max = Number.isSafeInteger(rawMax) && (rawMax as number) > 0 ? (rawMax as number) : DEFAULT_MAX_SHIPPING_GS;
  if (typeof text !== 'string' || text.trim() === '') return none('vacio');
  const n = normalizar(text);

  // 1) Debe haber al menos una palabra de contexto de envío.
  const ctx = [...n.matchAll(CONTEXTO_RE)];
  if (ctx.length === 0) return none('sin_contexto_envio');
  const ctxPositions = ctx.map((m) => m.index ?? 0);

  // 2) Candidatos = tokens CON señal monetaria asociados al envío (ventana después/antes recortada).
  const tokens = tokensDeDinero(n).filter((t) => t.hasSignal);
  const asociados: MoneyToken[] = [];
  for (const pos of ctxPositions) {
    const finD = finDespues(n, pos);
    for (const t of tokens) {
      const enDespues = t.index >= pos && t.index < finD;
      if (enDespues || asociadoAntes(n, pos, t)) asociados.push(t);
    }
  }

  const gratis = esGratis(n, ctxPositions);
  if (asociados.length === 0) {
    // Sin monto asociado: puede ser gratis (frase explícita) o simplemente no hay costo detectable.
    return gratis ? free() : none('sin_monto');
  }

  // 3) Si algún candidato asociado es money-shaped pero inválido ⇒ no adivinar.
  if (asociados.some((t) => t.value === null)) return none('monto_invalido');

  const distintos = [...new Set(asociados.map((t) => t.value as number))];
  if (distintos.length > 1) return none('monto_ambiguo');

  const v = distintos[0];
  if (v === undefined) return none('sin_monto'); // inalcanzable (asociados no vacío); guarda de tipo
  // 4) Frase de gratuidad NO negada + monto asociado: promo condicional ("envío gratis desde ₲X") o
  //    contradicción. JAMÁS cobrar ese monto: 0 confirma gratis; >0 es ambiguo (none).
  if (gratis) return v === 0 ? free() : none('gratis_con_monto');
  // 5) Cero sin gratuidad ("envío 0" / "₲0") ⇒ none.
  if (v === 0) return none('cero_sin_gratuidad');
  if (v > max) return none('excede_maximo');
  return matched(v);
}
