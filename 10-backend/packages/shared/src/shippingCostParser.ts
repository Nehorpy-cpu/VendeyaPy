/**
 * SHIPPING-CHAT-1 (ADR-0011) — Parser DETERMINÍSTICO del costo de envío escrito por el vendedor.
 * ====================================================================================================
 * Vive en `@vpw/shared` para que el panel (preview) y el backend (autoridad) importen EXACTAMENTE la
 * misma lógica. El backend lo re-ejecuta y es la autoridad final (SHIPPING-CHAT-3); el frontend solo
 * previsualiza. La IA NUNCA determina dinero.
 *
 * Postura financiera (conservadora): ante cualquier duda devuelve `none`/ambiguo — jamás inventa un
 * monto ni acepta uno inexacto. Un número solo se toma como costo de envío EXACTO si:
 *   1) lleva una SEÑAL MONETARIA (marcador ₲/Gs, multiplicador mil/k, o agrupación de miles "30.000");
 *   2) está ASOCIADO a una palabra de contexto de envío en la misma cláusula (sin cruzar " y "/coma/punto);
 *   3) su cláusula NO lo niega ("no cuesta") ni lo vuelve inexacto ("menos de/hasta/desde/aprox/...").
 * La gratuidad (₲0) solo cuenta si es inequívoca: no negada ("gratis no aplica") ni condicionada
 * ("gratis desde/si/solo para...").
 *
 * PRIVACIDAD: función PURA, sin logging. Los callers NUNCA deben loguear el texto del vendedor.
 */

/** HARDEN-1: subió a 2 porque cambia el comportamiento publicado (negaciones/umbrales/gratuidad/límite). */
export const PARSER_VERSION = 'shipping-parser-2';

/** Tope defensivo por defecto (guaraníes). Configurable por tenant vía coverage.shippingQuote.maxChargeGs. */
export const DEFAULT_MAX_SHIPPING_GS = 5_000_000;

/** Motivos estables (sin PII) por los que el parser NO entrega un monto exacto. Union cerrado. */
export type ShippingParseReason =
  | 'vacio'
  | 'sin_contexto_envio'
  | 'sin_monto'
  | 'monto_ambiguo'
  | 'monto_invalido'
  | 'monto_no_exacto'
  | 'monto_negado'
  | 'excede_maximo'
  | 'limite_invalido'
  | 'cero_sin_gratuidad'
  | 'gratis_con_monto'
  | 'gratuidad_negada'
  | 'gratuidad_condicional';

export type ShippingParseResult =
  | { kind: 'matched'; shippingGs: number; parserVersion: string }
  | { kind: 'free'; shippingGs: 0; parserVersion: string }
  | { kind: 'none'; reason: ShippingParseReason; parserVersion: string };

const matched = (gs: number): ShippingParseResult => ({ kind: 'matched', shippingGs: gs, parserVersion: PARSER_VERSION });
const free = (): ShippingParseResult => ({ kind: 'free', shippingGs: 0, parserVersion: PARSER_VERSION });
const none = (reason: ShippingParseReason): ShippingParseResult => ({ kind: 'none', reason, parserVersion: PARSER_VERSION });

/** Minúsculas + sin acentos (literal, sin escapes \u). "Envío" → "envio". */
function normalizar(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\S\n]/g, ' ') // NBSP y espacios exóticos (thin/nnbsp/tab/\r) → espacio normal; conserva \n
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
/** Frase de gratuidad (₲0). Global: estadoGratis analiza cada coincidencia por separado. */
const GRATIS_RE = /\b(gratis|gratuito|bonificad[oa]|sin\s+(?:costo|cargo))\b/g;
/** Token de dinero. m1=marcador líder ₲/Gs; m2=núcleo; m3=decimal malformado; m4=mil/k; m5=marcador final. */
// El marcador FINAL (gs/₲) no debe capturar un ₲/Gs seguido de dígitos: ese es el PREFIJO del monto
// siguiente ("24 ₲30.000" ⇒ el ₲ es de 30.000, no sufijo de 24). Negative lookahead `(?!\s*\d)`.
const MONEY_RE = /(₲\s*|gs\.?\s*)?(\d{1,3}(?:\.\d{3})+|\d+)([.,]\d+)?(?:\s?(mil|k))?(?:\s?(gs\.?|₲)(?!\s*\d))?/gi;

/**
 * Separadores que cortan la ventana "después" (coma, " y ", ". ", ";", salto): un monto tras uno de
 * estos límites pertenece a otra cláusula/ítem y NO se asocia al envío (evita tomar el precio del
 * producto). NO incluye " o " (alternativa entre montos de envío ⇒ debe quedar ambiguo).
 */
const CORTE_DESPUES = /,|\sy\s|\. |;|\n/;
/**
 * Relleno admisible entre un monto PREVIO y la palabra de envío ("son ₲30.000 [de] envío").
 * Solo palabras funcionales: cualquier otra palabra, coma o punto ⇒ el monto es de otra cláusula.
 */
const RELLENO_ANTES = /^(?:\s|de|del|el|la|los|las|un|una|por|para|:|=|es|son|cuesta|sale|vale|₲|gs\.?)*$/i;

/**
 * Modificador de NEGACIÓN del importe al final de la cláusula previa ("... no (te) cuesta (ni) ₲X").
 * Admite negadores (no/tampoco/nunca/jamás) y pronombre/"siempre"/"ni" entre el negador y el verbo.
 */
const MOD_NEGADO_END =
  /\b(?:no|tampoco|nunca|jamas)\s+(?:(?:te|le|me|nos|se|siempre|ni)\s+){0,2}(?:cuesta|cuestan|sale|salen|vale|valen|es|son)\b(?:\s+ni)?\s*$/;
/**
 * Modificador de INEXACTITUD (umbral/cota/rango/aprox) pegado antes del importe ("... menos de ₲X").
 * Cubre cotas ("no supera/no pasa de/no llega a/por lo menos/al menos/arriba de/minimo/maximo"),
 * aproximaciones ("mas o menos/cerca de/aproximadamente/unos/ronda/como/algo de/sobre") y "entre/desde/hasta".
 */
const MOD_NO_EXACTO_END =
  /\b(?:no supera|no pasa de|no llega a|no baja de|menos de|mas de|mas o menos|a partir de|alrededor de|cerca de|por lo menos|al menos|arriba de|encima de|por encima de|aproximadamente|aprox|unos|unas|minimo|maximo|rondando|rondan|ronda|como|algo de|sobre|hasta|desde|entre|estimad[oa]|depende|menos)\b\s*(?:el|la|los|las|un|una|unos|unas|de|costar|valer|salir)?\s*$/;
/** Modificador de INEXACTITUD que sigue al importe ("₲X aproximadamente / o menos / depende..."). */
const MOD_NO_EXACTO_POST =
  /^\s*(?:o\s+(?:mas|menos)|mas\s+o\s+menos|en\s+adelante|para\s+arriba|para\s+abajo|aproximad\w*|aprox\b|depende|estimad\w*|o\s+asi)/;
/**
 * Rango de importe ANCLADO AL TOKEN (no a la oración): el token debe ser un EXTREMO del rango
 * ("entre ₲X y [t]" / "de ₲X a [t]" cota superior; "entre [t] y ₲Y" / "de [t] a ₲Y" cota inferior).
 * Anclarlo al token evita envenenar un monto de envío único cuando hay OTRO rango en la misma oración
 * (umbral de compra "de ₲100.000 a ₲200.000", horario "de 8 a 18"). El token ya trae señal monetaria.
 */
const RANGO_UPPER_RE = /\b(?:entre|de)\s+(?:₲\s*|gs\.?\s*)?\d[\d.]*(?:\s*(?:mil|k))?\s+(?:y|a)\s*$/;
const RANGO_LOWER_POST_RE = /^\s*(?:mil|k)?\s*(?:y|a)\s+(?:₲\s*|gs\.?\s*)?\d/;

const VENTANA_DESPUES = 40; // chars tras la palabra de envío donde buscar el monto
const VENTANA_ANTES = 25; // chars antes (para "son ₲30.000 de envío")

/** Signos de "menos" (hyphen-minus, minus sign, en/em dash) que anteceden un negativo. */
const SIGNOS_MENOS = new Set(['-', '−', '–', '—']);

/** Límites [start,end) de la ORACIÓN que contiene idx (bounded por ". "/";"/salto; NO por " y "/coma). */
function oracionBounds(n: string, idx: number): [number, number] {
  const before = n.slice(0, idx);
  const sep = /\. |;|\n/g;
  let start = 0;
  let mm: RegExpExecArray | null;
  while ((mm = sep.exec(before)) !== null) start = mm.index + mm[0].length;
  const mA = /\. |;|\n/.exec(n.slice(idx));
  return [start, mA ? idx + mA.index : n.length];
}

/** ¿El token es un EXTREMO de un rango de importes ("entre ₲X y [t]" / "de ₲X a [t]" y viceversa)? */
function esExtremoDeRango(n: string, t: MoneyToken): boolean {
  const [os] = oracionBounds(n, t.index);
  // Token = cota SUPERIOR: "entre ₲X y " / "de ₲X a " justo antes (misma oración, ventana corta).
  if (RANGO_UPPER_RE.test(n.slice(Math.max(os, t.index - 28), t.index))) return true;
  // Token = cota INFERIOR: "entre "/"de " justo antes Y " y/a ₲Y" justo después.
  if (
    /\b(?:entre|de)\s+$/.test(n.slice(Math.max(os, t.index - 7), t.index)) &&
    RANGO_LOWER_POST_RE.test(n.slice(t.end, t.end + 22))
  ) {
    return true;
  }
  return false;
}

interface MoneyToken {
  /** Valor entero en Gs, o null si es money-shaped pero INVÁLIDO (decimal/grouping/overflow/sci/negativo). */
  value: number | null;
  /** ¿Tiene señal monetaria? Sin señal (número crudo) NO se considera costo de envío. */
  hasSignal: boolean;
  index: number;
  end: number;
}

/**
 * ¿El token está precedido por un signo negativo, aun con espacios y/o marcador (₲/Gs) en medio?
 * "-₲30.000", "- ₲30.000", "− ₲30.000" ⇒ negativo. (El ₲ ya lo absorbió el prefijo del token.)
 */
function esNegativo(n: string, tokenIndex: number): boolean {
  let i = tokenIndex - 1;
  // Saltar TODOS los espacios (ya normalizados a ' '); NO cruzar salto de línea.
  while (i >= 0 && n[i] === ' ') i--;
  return i >= 0 && SIGNOS_MENOS.has(n[i] as string);
}

/** Parsea el núcleo de un token a un valor entero en Gs, o null si es inválido. */
function valorDeToken(core: string, decimal: string | undefined, mult: string | undefined, negativo: boolean, pegado: boolean): number | null {
  if (negativo) return null; // "-30000" / "- ₲30.000"
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
    const after = n[idx + full.length];
    // dígito/letra pegada que NO es unidad ya consumida ⇒ formato inválido:
    //   "3e4" (notación científica), "30.0000" (agrupación mal formada), "30kg" (unidad ajena).
    const pegado = !!after && /[a-z0-9]/.test(after);
    const hasMarker = !!m[1] || !!m[4] || !!m[5]; // marcador ₲/Gs (prefijo o sufijo) o multiplicador mil/k
    const hasGrouping = core.includes('.');
    out.push({
      value: valorDeToken(core, m[3], m[4], esNegativo(n, idx), pegado),
      hasSignal: hasMarker || hasGrouping,
      index: idx,
      end: idx + full.length,
    });
  }
  return out;
}

/** Estado de la gratuidad respecto al envío. */
type EstadoGratis = 'valid' | 'negated' | 'conditional' | 'none';

/**
 * Clasifica la gratuidad: inequívoca (valid), negada, condicionada, o inexistente.
 * HARDEN-1b: la ventana de análisis se ancla al match de GRATUIDAD (no a la palabra de contexto), para que
 * los calificadores que siguen a "gratis" (no aplica / solo para / excepto / desde...) NUNCA se pierdan por
 * la distancia al contexto. La gratuidad debe pertenecer al envío: misma ORACIÓN que algún contexto
 * (sin ". "/";"/salto entre ambos; la coma NO separa — "..., es gratis" sigue siendo del envío).
 */
function estadoGratis(n: string, ctxPositions: number[]): EstadoGratis {
  let vioNegada = false;
  let vioCondicional = false;
  for (const m of n.matchAll(GRATIS_RE)) {
    const gi = m.index ?? 0;
    const len = m[0].length;
    const [os, oe] = oracionBounds(n, gi);
    if (!ctxPositions.some((p) => p >= os && p < oe)) continue; // la gratuidad debe ser del envío (misma oración)
    const antes = n.slice(os, gi);
    const despues = n.slice(gi + len, oe);
    // NEGADA: negador pegado antes de "gratis" ("no es gratis"), o "no [verbo de gratuidad]" en la oración
    //         ("no tenemos/ofrecemos/hacemos ... gratis"), o contradicción/"no aplica..." después.
    const negAntes =
      /\b(?:no|tampoco|nunca|jamas)\b[^.]{0,10}$/.test(antes) ||
      /\b(?:no|tampoco|nunca|jamas)\s+(?:\w+\s+){0,3}?(?:tenemos|tenes|tiene|hay|es|era|sera|seria|habra|hacemos|hacen|ofrecemos|ofrece|contamos|damos|manejamos|trabajamos|existe|incluye|aplica|va|corre)\b/.test(antes);
    const negDespues =
      /\b(?:ya\s+)?no\s+(?:\w+\s+){0,2}(?:aplica|disponible|corre|rige|vigente|vale|va)\b/.test(despues) ||
      /\b(?:se\s+cobra|se\s+abona|tiene\s+(?:un\s+)?costo|con\s+costo|hay\s+recargo|ahora\s+(?:cuesta|se\s+cobra)|pero\s+(?:cuesta|se\s+cobra|ahora|se\s+abona))\b/.test(despues);
    // CONDICIONADA: calificador de condición/excepción en la oración de la gratuidad (tras "gratis").
    const cond =
      /\b(?:si\b|solo|solamente|unicamente|excepto|salvo|desde|a\s+partir|superior|superiores|mayor(?:es)?\s+a|mas\s+de|por\s+compras?|en\s+compras?|con\s+(?:la\s+)?compra|en\s+pedidos?|por\s+pedidos?|para\s+(?:compras?|pedidos?|la\s+primera|el\s+primer|primer|primera|nuevos|nuevas|clientes\s+nuevos|mayoristas)|abonando|pagando|en\s+efectivo|por\s+transferencia|llevando|comprando|dentro\s+de|minimo|siempre\s+que|cuando\b|durante|arriba\s+de|hasta\s+cierto)\b/.test(
        despues,
      );
    if (negAntes || negDespues) {
      vioNegada = true;
      continue;
    }
    if (cond) {
      vioCondicional = true;
      continue;
    }
    return 'valid'; // gratuidad inequívoca del envío
  }
  if (vioCondicional) return 'conditional';
  if (vioNegada) return 'negated';
  return 'none';
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

/** Fragmento de cláusula ANTES del token (desde el último separador). Para detectar modificadores. */
function fragmentoAntes(n: string, tokenIndex: number): string {
  const pre = n.slice(0, tokenIndex);
  const seps = /,|\. |;|\n|\sy\s/g;
  let start = 0;
  let mm: RegExpExecArray | null;
  while ((mm = seps.exec(pre)) !== null) start = mm.index + mm[0].length;
  return pre.slice(start);
}

/** ¿La cláusula del token lo NIEGA o lo vuelve INEXACTO (umbral/cota/rango/aprox)? */
function modificadorDe(n: string, t: MoneyToken): 'negado' | 'no_exacto' | null {
  const pre = fragmentoAntes(n, t.index);
  if (MOD_NEGADO_END.test(pre)) return 'negado';
  if (MOD_NO_EXACTO_END.test(pre)) return 'no_exacto';
  // Rangos "entre ₲X y ₲Y" / "de ₲X a ₲Y": el token es un extremo (anclado, no por oración completa).
  if (esExtremoDeRango(n, t)) return 'no_exacto';
  if (MOD_NO_EXACTO_POST.test(n.slice(t.end))) return 'no_exacto';
  return null;
}

/**
 * Detecta el costo de envío en el borrador del vendedor. Determinístico y conservador.
 * @param text  borrador crudo del vendedor (nunca se loguea).
 * @param opts.maxChargeGs  tope defensivo (default DEFAULT_MAX_SHIPPING_GS). Inválido ⇒ `limite_invalido`.
 */
export function parseShippingCost(text: unknown, opts?: { maxChargeGs?: number }): ShippingParseResult {
  // 0) Límite: ausente ⇒ default; válido ⇒ se usa; inválido ⇒ falla cerrado (JAMÁS amplía en silencio).
  const rawMax = opts?.maxChargeGs;
  let max: number;
  if (rawMax === undefined) max = DEFAULT_MAX_SHIPPING_GS;
  else if (Number.isSafeInteger(rawMax) && rawMax > 0) max = rawMax;
  else return none('limite_invalido');

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

  const gratis = estadoGratis(n, ctxPositions);

  if (asociados.length === 0) {
    // Sin monto asociado: la gratuidad (inequívoca) manda; negada/condicionada ⇒ none con su razón.
    if (gratis === 'valid') return free();
    if (gratis === 'conditional') return none('gratuidad_condicional');
    if (gratis === 'negated') return none('gratuidad_negada');
    return none('sin_monto');
  }

  // 3) Si algún candidato asociado es money-shaped pero inválido ⇒ no adivinar.
  if (asociados.some((t) => t.value === null)) return none('monto_invalido');

  const distintos = [...new Set(asociados.map((t) => t.value as number))];
  if (distintos.length > 1) return none('monto_ambiguo');

  const v = distintos[0];
  if (v === undefined) return none('sin_monto'); // inalcanzable (asociados no vacío); guarda de tipo

  // 4) Cero: solo con gratuidad inequívoca ⇒ free; si no, none.
  if (v === 0) return gratis === 'valid' ? free() : none('cero_sin_gratuidad');

  // 5) Gratuidad inequívoca + monto positivo ⇒ contradicción; condicionada ⇒ umbral (no cobrar).
  if (gratis === 'valid') return none('gratis_con_monto');
  if (gratis === 'conditional') return none('gratuidad_condicional');

  // 6) Modificadores en la cláusula del monto: negado / inexacto ⇒ none con razón estable.
  for (const t of asociados) {
    const mod = modificadorDe(n, t);
    if (mod === 'negado') return none('monto_negado');
    if (mod === 'no_exacto') return none('monto_no_exacto');
  }

  // 7) Tope defensivo.
  if (v > max) return none('excede_maximo');
  return matched(v);
}
