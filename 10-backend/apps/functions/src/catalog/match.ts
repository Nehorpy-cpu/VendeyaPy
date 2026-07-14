/**
 * catalog/match.ts — Matcher parcial tokenizado por nombre/marca (F1B)
 * ====================================================================
 * PURO (sin E/S), compartido por la tool `buscar_productos` (prioriza el producto que el cliente
 * nombró en `consulta`) y por `findProductByName` (agregar al carrito por nombre PARCIAL:
 * "agregá la belle" → "La Vie Est Belle"; antes exigía el nombre completo).
 *
 * Diseño: se comparan TOKENS normalizados (sin acentos/mayúsculas) del texto del cliente contra
 * los del nombre + marca. Las palabras genéricas de compra (perfume, quiero, agregá, precio...)
 * NO identifican productos: van a una stoplist en AMBOS lados — así "agregá el perfume" no matchea
 * "Perfume Supremacy..." por la palabra 'perfume'.
 */

/** Minúsculas, sin acentos/diacríticos, solo [a-z0-9] y espacios simples. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palabras que nunca identifican un producto (categoría, acción de compra, filtros hablados). */
const STOPWORDS = new Set([
  'perfume', 'perfumes', 'fragancia', 'fragancias', 'colonia', 'colonias', 'producto', 'productos',
  'quiero', 'quisiera', 'busco', 'buscando', 'tenes', 'tienes', 'tienen', 'tiene', 'hay', 'venden',
  'agrega', 'agregar', 'agregame', 'agregalo', 'agregala', 'anadi', 'anade', 'anadir', 'anadilo',
  'anadila', 'sumale', 'suma', 'sumame', 'sumalo', 'sumala', 'llevalo', 'llevala', 'dale', 'okey', 'dame',
  'llevo', 'llevar', 'muestrame', 'mostrame', 'muestra', 'mostrar', 'catalogo', 'opciones',
  'precio', 'precios', 'cuanto', 'cuesta', 'sale', 'vale', 'para', 'regalo', 'regalar',
  'hombre', 'mujer', 'algo', 'alguno', 'alguna', 'este', 'esta', 'estos', 'estas', 'ese', 'esa',
  'uno', 'una', 'unos', 'unas', 'los', 'las', 'del', 'con', 'por', 'que', 'mas', 'llamado', 'llamada',
  // F4: cortesía/relleno — "Sí, agrégalo porfa" es una confirmación, no el nombre de un producto.
  'porfa', 'porfavor', 'porfis', 'porfi', 'pls', 'plis', 'favor', 'gracias',
  // F4: reclamo/pedido en pasado — "yo quería el Supremacy" identifica al producto, no a 'queria'.
  'queria', 'pedi',
]);

/** Tokens con poder identificatorio: normalizados, largo ≥3 y fuera de la stoplist. */
export function queryTokens(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Lo mínimo que el matcher necesita de un producto (Product cumple esta forma). */
export interface NameMatchable {
  name: string;
  perfume?: { brand?: string | null } | null;
}

/** Umbral por defecto (aprox: un token exacto = 2; prefijo+frase puede alcanzarlo — ver score). */
export const MIN_NAME_MATCH_SCORE = 2;

/** Tokens identificatorios SOLO del nombre (sin marca). Nota: un producto cuyo nombre sea 100%
 * stopwords/tokens cortos ("Regalo", "CH") no es matcheable por nombre — trade-off aceptado,
 * lo rescata la marca en el score de la tool. */
function nameTokens(p: NameMatchable): string[] {
  return normalizeText(p.name ?? '')
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Score de coincidencia del texto del cliente contra nombre+marca del producto.
 * token exacto = 2 · prefijo (≥4 chars) = 1 · frase completa dentro del nombre/marca = +3 ·
 * + cobertura del NOMBRE (0..3): nombrar el producto EXACTO ("good girl") le gana a la
 * variante más larga ("Good Girl Suprême") — el desempate deja de depender del largo.
 */
export function productMatchScore(query: string, p: NameMatchable): number {
  const qTokens = queryTokens(query);
  if (qTokens.length === 0) return 0;
  const name = normalizeText(p.name ?? '');
  const brand = normalizeText(p.perfume?.brand ?? '');
  const nTokens = nameTokens(p);
  const pTokens = new Set([
    ...nTokens,
    ...brand.split(' ').filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  ]);
  let score = 0;
  for (const qt of qTokens) {
    if (pTokens.has(qt)) { score += 2; continue; }
    if (qt.length >= 4) {
      for (const pt of pTokens) {
        if (pt.startsWith(qt)) { score += 1; break; }
      }
    }
  }
  if (score > 0) {
    const phrase = qTokens.join(' ');
    if (name.includes(phrase) || brand.includes(phrase)) score += 3;
    if (nTokens.length > 0) {
      const qSet = new Set(qTokens);
      const covered = nTokens.filter((t) => qSet.has(t)).length;
      score += 3 * (covered / nTokens.length);
    }
  }
  return score;
}

/**
 * F7: vocabulario de ESTILO/OCASIÓN que puede colisionar con nombres de producto ("Dulce
 * Tentación"). Gatea SOLO la fidelidad estricta (nunca el pinning/orden): una consulta cuyo
 * único vínculo con el producto es una palabra de estilo es una búsqueda por TIPO, no por
 * entidad. Espeja el vocabulario de detectarEstilo (engine) y las ocasiones (fichaRank).
 */
const STYLE_OCCASION_WORDS = new Set([
  'dulce', 'dulces', 'azucar', 'vainilla', 'gourmand', 'floral', 'florales', 'flor', 'rosas',
  'jazmin', 'fresco', 'fresca', 'frescos', 'ligero', 'limpio', 'intenso', 'intensa', 'fuerte',
  'seductor', 'potente', 'arabe', 'oud', 'citrico', 'citrica', 'limon', 'frutal', 'fruta',
  'amaderado', 'amaderada', 'madera', 'noche', 'nocturno', 'dia', 'oficina', 'verano',
  'invierno', 'otono', 'primavera', 'elegante', 'suave', 'moderado', 'moderada', 'diario', 'fiesta', 'fiestas',
]);

/** F7: tokens de la consulta con poder de IDENTIDAD (ni genéricos ni de estilo/ocasión). */
export function tokensIdentitarios(text: string): string[] {
  return queryTokens(text).filter((t) => !STYLE_OCCASION_WORDS.has(t));
}

/**
 * F7: ¿la consulta identifica una ENTIDAD (nombre/marca) dentro de los matches? Verdadero si
 * algún token identitario de la consulta aparece en el nombre/marca de algún match. Gatea la
 * fidelidad estricta: "algo dulce" que matchea "Dulce Tentación" es búsqueda por estilo (no
 * recorta el listado); "¿tenés supremacy?" es búsqueda por entidad (recorta a las coincidencias).
 */
export function hayConsultaDeEntidad(query: string, matches: NameMatchable[]): boolean {
  const ids = new Set(tokensIdentitarios(query));
  if (ids.size === 0) return false;
  return matches.some((p) =>
    normalizeText(`${p.name ?? ''} ${p.perfume?.brand ?? ''}`)
      .split(' ')
      .some((t) => ids.has(t)),
  );
}

/** Frases de similitud, sobre texto YA normalizado (sin acentos/signos). Jerga real de es-PY. */
const SIMILAR_PATTERNS: RegExp[] = [
  /\b(parecid[oa]s?|similar(es)?|alternativas?|equivalentes?|sustitutos?|reemplazos?)\b/,
  /\bclon(es)?\b/, // "un clon del invictus" (jerga perfumera)
  /\bversion(es)? (de|del)\b/,
  /\btipo [a-z0-9]/, // "un perfume tipo invictus"
  /\bhuel[ae]n? (a|como|igual|parecido)\b/, // "que huela como el..."
  /\bmismo (olor|aroma|perfume) que\b/,
  /\bigual(it[oa])? al? \S/, // "igual al invictus"
  /\b(algo|alguno|alguna|uno|una) como \S/,
  /\b(del|un|el|mismo) estilo (de|del|que|a)\b/,
  /\bse parezcan?\b/,
];

/**
 * F7: ¿el cliente pide SIMILARES/alternativas ("parecido a X", "tipo X", "un clon del X")?
 * Determinística y genérica (sin marcas ni productos). Decide si la búsqueda por nombre/marca
 * puede acompañarse con no-coincidentes (searchCatalog `allowSimilar`). La NEGACIÓN de
 * similitud ("no quiero nada parecido, quiero el original") es consulta directa.
 */
export function esBusquedaSimilar(text: string): boolean {
  const t = normalizeText(text);
  if (/\b(no (quiero|busco|me interesa)( nada| algo)?|nada) (parecid|similar|tipo|igual)/.test(t)) return false;
  return SIMILAR_PATTERNS.some((re) => re.test(t));
}

export interface NameMatchOptions {
  minScore?: number;
  /**
   * Exige ≥1 token exacto del NOMBRE (no solo de la marca). Para el camino CARRITO
   * (findProductByName): "sumale algo de armaf" (marca sola) NO debe agregar un producto
   * arbitrario; "agregá la belle" (token del nombre) sí.
   */
  requireNameToken?: boolean;
}

/**
 * Mejor producto para un texto libre ("agregá la belle"), o null si nada supera el umbral.
 * Empate de score → gana el nombre más CORTO (la variante exacta, no la extendida).
 */
export function bestNameMatch<T extends NameMatchable>(
  text: string,
  products: T[],
  opts: NameMatchOptions = {},
): T | null {
  const minScore = opts.minScore ?? MIN_NAME_MATCH_SCORE;
  const qSet = new Set(queryTokens(text));
  let best: T | null = null;
  let bestScore = 0;
  for (const p of products) {
    if (opts.requireNameToken && !nameTokens(p).some((t) => qSet.has(t))) continue;
    const s = productMatchScore(text, p);
    if (s > bestScore || (s === bestScore && s > 0 && best !== null && (p.name ?? '').length < (best.name ?? '').length)) {
      best = p;
      bestScore = s;
    }
  }
  return bestScore >= minScore ? best : null;
}

/**
 * Separa los productos que matchean la consulta (pinned, orden por score desc, empate → nombre
 * más corto) del resto. El pinning decide el ORDEN de los resultados, no salta filtros: el caller
 * (searchCatalog) aplica los filtros explícitos (género/precio) ANTES — el contrato de la tool
 * (precioMax, género) se respeta siempre.
 */
export function splitByQueryMatch<T extends NameMatchable>(
  query: string | undefined,
  products: T[],
  minScore = MIN_NAME_MATCH_SCORE,
): { pinned: T[]; rest: T[] } {
  const q = query?.trim();
  if (!q) return { pinned: [], rest: products };
  const scored = products
    .map((p) => ({ p, s: productMatchScore(q, p) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s || (a.p.name ?? '').length - (b.p.name ?? '').length);
  const pinned = scored.map((x) => x.p);
  const pinnedSet = new Set<T>(pinned);
  return { pinned, rest: products.filter((p) => !pinnedSet.has(p)) };
}
