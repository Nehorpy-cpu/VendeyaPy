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

  // Score por coincidencia de estilo + destacado/nuevo (aprox. de relevancia)
  const scored = productos.map((p) => {
    let score = 0;
    if (filters.styleTag && p.perfume?.styleTags?.includes(filters.styleTag)) score += 5;
    if (p.featured) score += 1;
    if (p.perfume?.isNew) score += 0.5;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score || Number(b.p.featured) - Number(a.p.featured));

  return scored.slice(0, filters.limit ?? 3).map((s) => s.p);
}
