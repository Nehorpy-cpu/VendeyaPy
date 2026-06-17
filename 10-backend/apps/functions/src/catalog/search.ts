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

export interface CatalogFilters {
  gender?: string; // 'Femenino' | 'Masculino' | 'Unisex'
  styleTag?: string; // dulce, fresco, intenso, árabe, floral, cítrico, gourmand...
  priceRange?: string; // 'ACCESIBLE' | 'MID' | 'PREMIUM' | 'LUJO'
  maxPrice?: number; // tope en Guaraníes
  limit?: number; // por defecto 3
  /** Modo Ganancia (P15): prioriza por margen + prioridad (lee productFinancials). */
  profitMode?: boolean;
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

  let productos = snap.docs.map((d) => d.data() as Product).filter((p) => p.inventory?.stock > 0);

  // Filtros en memoria
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

  // Modo Ganancia: leer costo/prioridad (privado, server-side) para rankear por rentabilidad.
  const finMap = new Map<string, { cost: number | null; priority: number }>();
  if (filters.profitMode) {
    const fs = await db().collection(paths.productFinancials(tenantId)).get();
    fs.docs.forEach((d) => {
      const f = d.data() as { costPrice?: number | null; priorityScore?: number | null };
      finMap.set(d.id, { cost: f.costPrice ?? null, priority: f.priorityScore ?? 0 });
    });
  }

  // Score por coincidencia de estilo + destacado/nuevo (relevancia) + rentabilidad (Modo Ganancia).
  const scored = productos.map((p) => {
    let score = 0;
    if (filters.styleTag && p.perfume?.styleTags?.includes(filters.styleTag)) score += 5;
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

  return scored.slice(0, filters.limit ?? 3).map((s) => s.p);
}

/** Trae un producto por su id (SKU). null si no existe. */
export async function getProductById(tenantId: string, productId: string): Promise<Product | null> {
  const doc = await db().doc(paths.product(tenantId, productId)).get();
  return doc.exists ? (doc.data() as Product) : null;
}

/** Busca un producto activo cuyo nombre aparezca en el texto (ej: "quiero good girl"). */
export async function findProductByName(tenantId: string, text: string): Promise<Product | null> {
  const t = text.toLowerCase();
  const snap = await db()
    .collection(paths.products(tenantId))
    .where('status', '==', 'ACTIVE')
    .get();
  const productos = snap.docs.map((d) => d.data() as Product);
  // Match por nombre más largo primero (evita falsos positivos con nombres cortos)
  productos.sort((a, b) => b.name.length - a.name.length);
  return productos.find((p) => p.name && t.includes(p.name.toLowerCase())) ?? null;
}
