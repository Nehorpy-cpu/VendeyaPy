/**
 * catalog/search.ts — Búsqueda en el catálogo real (Firestore)
 * ============================================================
 * Lee tenants/{tenantId}/products y filtra/ordena en memoria.
 * Filtrado en memoria (no en query) a propósito: evita exigir índices
 * compuestos para cada combinación y alcanza de sobra para el volumen de
 * una perfumería (cientos de productos). Si el catálogo creciera mucho,
 * se migra a query con índices (ya hay índices base en firestore.indexes.json).
 */

import type { Product } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { splitByQueryMatch, bestNameMatch, hayConsultaDeEntidad } from './match.js';
import { fichaScore } from './fichaRank.js';

export interface CatalogFilters {
  /** F1B: texto libre del cliente (nombre/marca). Los matches van PRIMERO y no se filtran por género/precio. */
  query?: string;
  gender?: string; // 'Femenino' | 'Masculino' | 'Unisex'
  styleTag?: string; // dulce, fresco, intenso, árabe, floral, cítrico, gourmand...
  priceRange?: string; // 'ACCESIBLE' | 'MID' | 'PREMIUM' | 'LUJO'
  maxPrice?: number; // tope en Guaraníes
  limit?: number; // por defecto 3
  /** Modo Ganancia (P15): prioriza por margen + prioridad (lee productFinancials). */
  profitMode?: boolean;
  /**
   * CAT-2: texto libre del cliente para rankear por FICHA (ocasión/clima/proyección/notas/cuándo-NO).
   * Solo afecta el ORDEN de los no-pinneados; no pinnea por nombre (eso es `query`) ni filtra.
   */
  texto?: string;
  /**
   * F7: el cliente pidió SIMILARES ("parecido a X", "alternativa a X") → los no-coincidentes
   * pueden acompañar a los matches de `query`. Sin este flag, una consulta que nombró un
   * producto/marca con coincidencias reales devuelve SOLO esas (fidelidad estricta).
   */
  allowSimilar?: boolean;
}

/** Costo/prioridad privados por producto (Modo Ganancia). */
type FinMap = Map<string, { cost: number | null; priority: number }>;

/**
 * F7: composición PURA de resultados (sin E/S) — filtros explícitos, pinning por nombre/marca
 * y ranking. Exportada para tests. Los `activos` ya vienen filtrados por status/stock.
 */
export function componerResultados(
  activos: Product[],
  filters: CatalogFilters,
  finMap: FinMap = new Map(),
): Product[] {
  // Filtros explícitos PRIMERO (F1B): el contrato de la tool (precioMax/género/estilo declarados
  // por el cliente) se respeta siempre. Con F1 el género ya no tiene default, así que acá solo
  // llega lo que el cliente dijo.
  let productos = activos;
  if (filters.gender) {
    productos = productos.filter(
      (p) => p.perfume?.gender === filters.gender || p.perfume?.gender === 'Unisex',
    );
  }
  if (filters.priceRange) {
    productos = productos.filter((p) => p.perfume?.priceRange === filters.priceRange);
  }
  if (filters.maxPrice) {
    productos = productos.filter((p) => p.price <= filters.maxPrice!);
  }

  // F1B: la consulta por nombre/marca decide el ORDEN — los matches van PRIMERO (pinned).
  const { pinned, rest } = splitByQueryMatch(filters.query, productos);

  // F7 (fidelidad estricta): si la consulta NOMBRÓ un producto/marca (token de ENTIDAD, no de
  // estilo — "algo dulce" que matchea "Dulce Tentación" no recorta) y hay coincidencias reales,
  // se devuelven SOLO esas — jamás rellenar con similares (el bug de prod: "¿tienen Supremacy?"
  // devolvía también Odyssey y la IA lo presentó como si fuera Supremacy). El relleno por
  // similitud queda reservado al pedido explícito de similares (`allowSimilar`).
  if (pinned.length > 0 && !filters.allowSimilar && hayConsultaDeEntidad(filters.query ?? '', pinned)) {
    return pinned.slice(0, filters.limit ?? 3);
  }
  productos = rest;

  // Score por coincidencia de estilo + ficha (CAT-2) + destacado/nuevo + rentabilidad (Modo Ganancia).
  const scored = productos.map((p) => {
    let score = 0;
    if (filters.styleTag && p.perfume?.styleTags?.includes(filters.styleTag)) score += 5;
    // CAT-2: ocasión/clima/proyección/notas/cuándo-NO de la ficha pesan en el orden.
    if (filters.texto) score += fichaScore(p, filters.texto);
    if (p.featured) score += 1;
    if (p.perfume?.isNew) score += 0.5;
    if (filters.profitMode) {
      const f = finMap.get(p.id);
      const margin = f?.cost != null && p.price > 0 ? (p.price - f.cost) / p.price : 0;
      score += margin * 4 + (f?.priority ?? 0); // margen 50% → +2; prioridad 0-10 directo
    }
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score || Number(b.p.featured) - Number(a.p.featured));

  return [...pinned, ...scored.map((s) => s.p)].slice(0, filters.limit ?? 3);
}

export async function searchCatalog(
  tenantId: string,
  filters: CatalogFilters = {},
): Promise<Product[]> {
  // Solo productos activos y con stock
  const snap = await db()
    .collection(paths.products(tenantId))
    .where('status', '==', 'ACTIVE')
    .get();

  const activos = snap.docs.map((d) => d.data() as Product).filter((p) => p.inventory?.stock > 0);

  // Modo Ganancia: leer costo/prioridad (privado, server-side) para rankear por rentabilidad.
  const finMap: FinMap = new Map();
  if (filters.profitMode) {
    const fs = await db().collection(paths.productFinancials(tenantId)).get();
    fs.docs.forEach((d) => {
      const f = d.data() as { costPrice?: number | null; priorityScore?: number | null };
      finMap.set(d.id, { cost: f.costPrice ?? null, priority: f.priorityScore ?? 0 });
    });
  }

  return componerResultados(activos, filters, finMap);
}

/** Trae un producto por su id (SKU). null si no existe. */
export async function getProductById(tenantId: string, productId: string): Promise<Product | null> {
  const doc = await db().doc(paths.product(tenantId, productId)).get();
  return doc.exists ? (doc.data() as Product) : null;
}

/**
 * Busca un producto activo por nombre PARCIAL/tokenizado en el texto (F1B):
 * "agregá la belle" → "La Vie Est Belle". Antes exigía el nombre completo dentro del texto.
 * Umbral del matcher (≥1 token exacto) evita agregados por palabras genéricas ("agregá el perfume").
 */
export async function findProductByName(tenantId: string, text: string): Promise<Product | null> {
  const snap = await db()
    .collection(paths.products(tenantId))
    .where('status', '==', 'ACTIVE')
    .get();
  const productos = snap.docs.map((d) => d.data() as Product);
  // requireNameToken: marca sola ("sumale algo de armaf") NO agrega un producto arbitrario
  // al carrito; hace falta al menos un token exacto del NOMBRE ("agregá la belle").
  return bestNameMatch(text, productos, { requireNameToken: true });
}
