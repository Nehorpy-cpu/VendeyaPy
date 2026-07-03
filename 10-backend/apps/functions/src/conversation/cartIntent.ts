/**
 * conversation/cartIntent.ts — Confirmación de carrito CONTEXTUAL y determinística (F3)
 * =====================================================================================
 * Bug real que motiva esto (live smoke 2026-07-03): la IA presentó SOLO "Supremacy" como "1.",
 * pero `lastShownSkus` guardaba el orden crudo del buscador ([Odyssey, Supremacy]) → "sí" y
 * "el primero" agregaron Odyssey. La fuente de verdad tiene que ser LO QUE EL CLIENTE LEYÓ.
 *
 * Este módulo es PURO (sin E/S): helpers de intención (negativa/selección) + alineación del
 * texto de la respuesta con los productos de la tool + armado de PendingCartConfirmation.
 * El motor (engine.ts) decide; la IA solo conversa. El cliente NUNCA aprende comandos.
 */
import type { PendingCartCandidate, PendingCartConfirmation } from '@vpw/shared';
import { normalizeText, queryTokens } from '../catalog/match.js';

/** Vigencia de una oferta: pasado esto, "sí" ya no agrega nada (se repregunta). */
export const PENDING_CART_TTL_MS = 10 * 60 * 1000; // 10 min: ventana conversacional corta

/** ¿La oferta pendiente sigue vigente? (existe, tiene candidatos y no venció). */
export function pendingVigente(
  pending: PendingCartConfirmation | null | undefined,
  nowMs: number,
): pending is PendingCartConfirmation {
  return !!pending && pending.products.length > 0 && pending.expiresAtMs > nowMs;
}

/** Arma la oferta pendiente a partir de los productos EN EL ORDEN PRESENTADO al cliente. */
export function buildPendingConfirmation(
  products: PendingCartCandidate[],
  source: PendingCartConfirmation['source'],
  nowMs: number,
): PendingCartConfirmation | null {
  const list = products.filter((p) => p.id && p.name).slice(0, 3); // tope = alcance de "el tercero"
  if (list.length === 0) return null;
  return {
    products: list,
    primaryProductId: list.length === 1 ? list[0]!.id : null,
    source,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + PENDING_CART_TTL_MS,
    needsDisambiguation: list.length > 1,
  };
}

/**
 * Negativa del cliente ante una oferta:
 *  - 'rechazo'      → "no", "no gracias", "ese no": no agregar, limpiar la oferta, cierre amable.
 *  - 'alternativa'  → "mejor otro", "tenés otro": no agregar, limpiar la oferta y dejar que el
 *                     flujo normal (IA/catálogo) ofrezca otras opciones.
 *  - null           → no es negativa ("no sé si me alcanza" NO es un rechazo puro).
 */
export function tipoNegativa(text: string): 'rechazo' | 'alternativa' | null {
  const t = normalizeText(text);
  if (!t) return null;
  if (/^(no+|nop|nel|no gracias|ese no|esa no|este no|esta no|mejor no|por ahora no|no por ahora|todavia no|aun no|no quiero|no lo quiero|no la quiero|no lo llevo|no la llevo|no me lo llevo|no me la llevo|asi no)$/.test(t)) {
    return 'rechazo';
  }
  if (/\b(mejor otro|mejor otra|tenes otro|tenes otra|tienes otro|tienes otra|tienen otro|tienen otra|hay otro|hay otra|otra opcion|otras opciones|algo distinto|otro distinto)\b/.test(t)) {
    return 'alternativa';
  }
  return null;
}

/**
 * Guarda DURA de negación (review adversarial F3): si el mensaje contiene una negación, NINGÚN
 * camino de agregado puede ejecutarse — "no lo quiero" contiene "(lo) quiero" y engañaba a
 * quiereAgregar. Prefiere un falso "no agrego" (un cliente re-pide) a un falso agregado.
 */
export function contieneNegacion(text: string): boolean {
  return /\b(no|nunca|jamas|tampoco)\b/.test(normalizeText(text));
}

/**
 * F4 (anti-mentiras): RECLAMO del cliente sobre el carrito/acciones del bot. En prod la IA
 * respondió a un reclamo inventando estado ("Ya lo agregué" con el carrito vacío) — estos
 * turnos deben responderse desde el MOTOR con el estado real, jamás desde el modelo.
 *  - 'fuerte': reclamo inequívoco sobre acciones del bot → interceptar SIEMPRE.
 *  - 'debil': "yo quería X"/"te pedí X" — solo cuenta como reclamo si nombra un producto real
 *    (lo decide el caller con el catálogo); "yo quería saber si hacen envíos" va a la IA.
 */
export function tipoReclamoCarrito(text: string): 'fuerte' | 'debil' | null {
  const t = normalizeText(text);
  if (!t) return null;
  // Reclamos INEQUÍVOCOS sobre el carrito/acciones del bot → interceptar siempre.
  if (
    /\b(no (me )?(lo |la )?agregaste|no (lo |la )?pusiste|no esta en (el |mi )?carrito|no aparece en (el |mi )?carrito|(me )?agregaste otr[oa]|eso no (era|es) lo que (queria|pedi)|no es lo que pedi)\b/.test(t)
  ) {
    return 'fuerte';
  }
  // "te equivocaste"/"no entendiste" a secas pueden ser sobre CUALQUIER cosa (envíos, precios).
  // Solo cuentan como reclamo de carrito si el mensaje es corto y no es una pregunta; con más
  // contenido degradan a 'debil' (interceptan solo si nombran un producto real; si no → IA).
  if (/\b(te equivocaste|no entendiste)\b/.test(t)) {
    return t.length <= 30 && !esPreguntaConsulta(text) ? 'fuerte' : 'debil';
  }
  if (/\b(yo (queria|pedi)|te pedi|no era ese|ese no era)\b/.test(t)) return 'debil';
  return null;
}

/**
 * ¿El mensaje ES una elección por nombre de un candidato de la oferta? (review adversarial F3)
 * Mucho más estricto que "menciona un candidato": una OPINIÓN que lo nombra ("me encanta el
 * supremacy pero está caro") NO es una elección — eso va a la IA. Es elección solo si, quitando
 * los tokens del nombre elegido, el mensaje no dice nada más (queda solo relleno/stopwords).
 * Devuelve los candidatos elegidos (1 = elección clara; >1 = desambiguar; 0 = no es elección).
 */
export function eleccionPorNombre(
  text: string,
  candidates: PendingCartCandidate[],
): PendingCartCandidate[] {
  if (esPreguntaConsulta(text) || contieneNegacion(text)) return [];
  const matched = candidatosNombrados(text, candidates);
  if (matched.length === 0) return [];
  const nameTokens = new Set(matched.flatMap((c) => queryTokens(c.name)));
  const residual = queryTokens(text).filter((tk) => !nameTokens.has(tk));
  return residual.length === 0 ? matched : [];
}

/**
 * ¿El mensaje es una PREGUNTA/consulta y no una elección? Guarda de seguridad del camino
 * "selección por nombre sin verbo": "¿el supremacy es dulce?" pregunta, NO pide agregar.
 */
export function esPreguntaConsulta(text: string): boolean {
  if (text.includes('?') || text.includes('¿')) return true;
  const t = normalizeText(text);
  return /\b(que|cual|cuales|cuanto|cuanta|como|cuando|donde|por que|porque|precio|cuesta|sale|vale|es|son|tiene|tienen|hay|dura|huele|sirve|diferencia)\b/.test(t);
}

/**
 * Candidatos de la oferta que el cliente nombró en el mensaje actual (tokens identificatorios
 * del nombre presentes en el texto). Devuelve TODOS los que matchean: 1 ⇒ elección clara,
 * >1 ⇒ hay que desambiguar, 0 ⇒ el mensaje no nombra candidatos.
 */
export function candidatosNombrados(
  text: string,
  candidates: PendingCartCandidate[],
): PendingCartCandidate[] {
  const qSet = new Set(queryTokens(text));
  if (qSet.size === 0) return [];
  const matched = candidates
    .map((c) => {
      const nTokens = queryTokens(c.name);
      const hits = nTokens.filter((tk) => qSet.has(tk)).length;
      return { c, hits, coverage: nTokens.length ? hits / nTokens.length : 0 };
    })
    .filter((x) => x.hits > 0);
  if (matched.length <= 1) return matched.map((x) => x.c);
  // Varios matchean (comparten tokens, ej. dos "Supremacy"): si uno cubre estrictamente más
  // tokens de su nombre, es la elección clara; si empatan, que desambigüe el cliente.
  matched.sort((a, b) => b.hits - a.hits || b.coverage - a.coverage);
  const [first, second] = [matched[0]!, matched[1]!];
  if (first.hits > second.hits || first.coverage > second.coverage) return [first.c];
  return matched.map((x) => x.c);
}

/**
 * Alinea los productos que la tool devolvió con LO QUE LA RESPUESTA REALMENTE PRESENTA, en el
 * orden del texto. Endurecida por el review adversarial F3:
 *  - Un token solo "presenta" al producto si es DISTINTIVO dentro del set (la marca compartida
 *    "Lattafa" en la prosa sobre Yara no puede meter a "Lattafa Asad" en la oferta).
 *  - Nombres 100% stopwords ("Perfume para hombre") se alinean por FRASE completa en el texto.
 *  - Si la respuesta trae una lista numerada y la alineación no encontró la misma cantidad de
 *    productos, se devuelve [] (el caller usa el orden de la tool, que es el que la IA tiene
 *    instruido respetar) — la numeración que el cliente lee jamás puede quedar corrida.
 * Devuelve [] cuando no puede alinear con confianza; el caller decide el fallback.
 */
export function alignPresentedWithReply(
  replyText: string,
  products: PendingCartCandidate[],
): PendingCartCandidate[] {
  const reply = normalizeText(replyText);
  if (!reply) return [];

  // Tokens que aparecen en el nombre de MÁS de un candidato (marca compartida, "eau", etc.).
  const tokenCount = new Map<string, number>();
  for (const c of products) {
    for (const tk of new Set(queryTokens(c.name))) tokenCount.set(tk, (tokenCount.get(tk) ?? 0) + 1);
  }

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const presented: Array<{ c: PendingCartCandidate; pos: number }> = [];
  for (const c of products) {
    const nTokens = queryTokens(c.name);
    if (nTokens.length === 0) {
      // Nombre sin tokens identificatorios: solo la FRASE completa lo presenta.
      const phrase = normalizeText(c.name);
      if (phrase.length >= 4) {
        const pos = reply.indexOf(phrase);
        if (pos >= 0) presented.push({ c, pos });
      }
      continue;
    }
    let hits = 0;
    let uniqueHits = 0;
    let firstPos = Number.POSITIVE_INFINITY;
    for (const tk of nTokens) {
      const m = new RegExp(`(?:^| )${escape(tk)}`).exec(reply);
      if (m) {
        hits++;
        if ((tokenCount.get(tk) ?? 0) === 1) uniqueHits++;
        firstPos = Math.min(firstPos, m.index);
      }
    }
    const coverage = hits / nTokens.length;
    if ((uniqueHits >= 1 && (hits >= 2 || coverage >= 0.5)) || coverage >= 1) {
      presented.push({ c, pos: firstPos });
    }
  }
  presented.sort((a, b) => a.pos - b.pos);

  // Lista numerada en el texto: si la alineación no cuadra con la cantidad de ítems, no adivinar.
  const numberedItems = (replyText.match(/^\s*\W{0,3}\d+[.)]/gm) ?? []).length;
  if (numberedItems >= 2 && presented.length !== numberedItems) return [];

  return presented.map((x) => x.c);
}

/** Pregunta de desambiguación DEL MOTOR: lista numerada garantizada alineada con la oferta. */
export function preguntaDesambiguacion(products: PendingCartCandidate[]): string {
  const lineas = products.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  return `¿Cuál querés que agregue? 🙂\n${lineas}\n\nDecime el número o el nombre.`;
}
