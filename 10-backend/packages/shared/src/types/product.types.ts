/**
 * Productos y categorías del catálogo del tenant.
 * Ver ARCHITECTURE.md §4.3.
 */

import type { ProductStatus, Currency, PerfumeGender, PriceRange, MetaSyncStatus } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface ProductInventory {
  trackStock: boolean;
  stock: number;
  lowStockThreshold: number;
  sku: string;
}

/**
 * Notas olfativas de un perfume (pirámide: salida → corazón → fondo).
 * El agente de IA las lee al recomendar y al responder "¿qué tiene este perfume?".
 */
export interface OlfactiveNotes {
  top: string[]; // notas de salida
  heart: string[]; // notas de corazón
  base: string[]; // notas de fondo
}

/**
 * Atributos específicos de perfumería.
 * Sub-objeto opcional de Product (null para productos no-perfume, ej. cremas).
 * Ver docs/data-model-perfumeria.md.
 */
export interface PerfumeAttributes {
  brand: string;
  gender: PerfumeGender;
  olfactiveFamily: string;
  styleTags: string[]; // dulce, fresco, intenso, árabe, cítrico... (para búsqueda del agente)
  notes: OlfactiveNotes;
  priceRange: PriceRange;
  sizeMl: number | null;
  isNew: boolean;
}

export interface ProductExternalIds {
  facebook: string | null;
  instagram: string | null;
  tiktok: string | null;
}

/**
 * Ficha para recomendaciones (CATALOG-ENRICHMENT-1): datos ESTRUCTURADOS que el vendedor carga
 * para que el agente recomiende bien sin inventar. Todo opcional (compatible con productos
 * existentes). Los campos de venta sirven para cualquier rubro; los de perfumería complementan
 * a PerfumeAttributes (familia/notas/tamaño ya viven ahí).
 */
export interface ProductAiFicha {
  // --- Venta (cualquier rubro) ---
  /** Cuándo conviene recomendarlo ("busca algo para regalar", "quiere duración"). */
  cuandoRecomendar?: string;
  /** Cuándo NO recomendarlo ("si busca algo suave para oficina"). */
  cuandoNoRecomendar?: string;
  /** Objeciones frecuentes y cómo responderlas. */
  objeciones?: string;
  /** Frases de venta sugeridas (el agente puede inspirarse en ellas). */
  frasesVenta?: string[];
  /** Nombres de productos similares/alternativas para ofrecer. */
  similares?: string[];
  // --- Perfumería ---
  /** Concentración: EDT, EDP, Extrait, Parfum, etc. */
  concentracion?: string;
  /** Duración estimada ("6-8 horas", "todo el día"). */
  duracion?: string;
  /** Proyección: suave / moderada / fuerte. */
  proyeccion?: string;
  /** Ocasiones de uso: oficina, cita, fiesta, diario… */
  ocasiones?: string[];
  /** Clima recomendado: verano, invierno, todo el año… */
  clima?: string[];
  /** Perfil recomendado: juvenil, elegante, maduro… */
  perfil?: string;
}

export interface Product {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  price: number;
  compareAtPrice: number | null;
  /**
   * El precio de COSTO ya NO vive acá (sería legible por el vendedor: Firestore no
   * oculta campos). Está en la subcolección privada `productFinancials/{id}`. Ver ADR-0008.
   */
  /** Info para el agente de IA: notas de venta, beneficios, público ideal, etc. (texto libre). */
  aiNotes: string;
  currency: Currency;
  categoryId: string;
  images: string[];
  emoji: string;
  inventory: ProductInventory;
  status: ProductStatus;
  featured: boolean;
  position: number;
  externalIds: ProductExternalIds;
  /** Atributos de perfumería. null para productos que no son perfumes. */
  perfume: PerfumeAttributes | null;
  /** Ficha para recomendaciones del agente (CATALOG-ENRICHMENT-1). Opcional. */
  aiFicha?: ProductAiFicha | null;
  // --- Sincronización con el Meta Catalog (D4). Lo escribe la sync (Admin SDK). ---
  syncToMeta?: boolean;
  metaSyncStatus?: MetaSyncStatus;
  metaCatalogId?: string | null;
  metaProductItemId?: string | null;
  metaLastSyncAt?: Timestamp | null;
  metaSyncError?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Category {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  emoji: string;
  position: number;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
