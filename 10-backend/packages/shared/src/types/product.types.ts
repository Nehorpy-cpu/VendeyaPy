/**
 * Productos y categorías del catálogo del tenant.
 * Ver ARCHITECTURE.md §4.3.
 */

import type {
  ProductStatus,
  Currency,
  PerfumeGender,
  PriceRange,
  MetaSyncStatus,
  MetaSyncState,
  MetaDriftOwner,
  MetaDriftSeverity,
} from '../enums.js';
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

// ---------------------------------------------------------------------------
// Calidad del catálogo (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1)
// ---------------------------------------------------------------------------

export type QualitySeverity = 'BLOCKING' | 'WARNING';

/** Quién originó el recompute que vio la observación por primera vez. */
export type QualityObservationOrigin = 'import' | 'editor' | 'sync_gate' | 'system';

/**
 * Observación de calidad de UN producto. El fingerprint (`${code}:${field}`) es la clave del
 * mapa `ProductQuality.fingerprints`: estable por definición, así la historia
 * (firstSeenAt/lastSeenAt/resolvedAt) sobrevive a los recomputes.
 */
export interface QualityObservation {
  code: string;
  severity: QualitySeverity;
  /** Campo del producto al que apunta la corrección (p.ej. 'name', 'price', 'images'). */
  field: string;
  /** Explicación en español, no técnica. */
  message: string;
  /** Qué hacer para resolverla, en español. */
  action: string;
  firstSeenAt: Timestamp;
  lastSeenAt: Timestamp;
  /** null = activa. Al resolverse se SELLA (histórico corto), no se borra. */
  resolvedAt: Timestamp | null;
  origin: QualityObservationOrigin;
}

/**
 * Resumen de calidad persistido en el product doc. SOLO lo escribe el servidor
 * (productUpsert / import run, Admin SDK): `validateProductPatch` no lo acepta y las rules
 * de products están cerradas al cliente.
 */
export interface ProductQuality {
  /** Observaciones BLOCKING activas (resolvedAt == null). */
  blocking: number;
  /** Observaciones WARNING activas. */
  warning: number;
  fingerprints: Record<string, QualityObservation>;
  evaluatedAt: Timestamp;
}

/**
 * Perfil de calidad por tenant (`tenants/{t}/config/catalog`, campo `profile`). TODO opcional:
 * sin perfil, el evaluador usa defaults conservadores que reproducen el comportamiento actual
 * de arfagi (stopwords de perfumería, chequeo de genericidad activo, vertical perfumería).
 */
export interface CatalogQualityProfile {
  /** Exigir marca como calidad de ficha aunque el gate de Meta no la pida (default true). */
  requireBrand?: boolean;
  /** Reservado: la imagen https ya la exige SIEMPRE el contrato de Meta (default true). */
  requireImage?: boolean;
  /** Detectar nombres genéricos (nombre ≈ marca). Default true. */
  genericNameCheck?: boolean;
  /** Ruido comercial del vertical para comparar nombres. Default: stopwords de perfumería. */
  stopwords?: string[];
  /** Vertical del tenant: 'perfumeria' arma la ficha perfume al importar; 'generic' no. */
  vertical?: 'perfumeria' | 'generic';
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

// ---------------------------------------------------------------------------
// Deriva contra el catálogo remoto (ADR-0015 §5)
// ---------------------------------------------------------------------------

/**
 * UN campo divergente con los valores observados. Los valores van SANEADOS y RECORTADOS: son
 * para que una persona entienda la diferencia, no una copia del remoto. De las URLs se guarda
 * host + path — jamás la query string (un feed puede firmar sus imágenes) ni credenciales.
 */
export interface MetaDriftObservation {
  /** Campo público del contrato de propiedad ('price', 'availability', 'title'…). */
  field: string;
  /** Valor local saneado (lo que VendeYaPy cree). */
  local: string;
  /** Valor remoto saneado (lo que Meta muestra HOY). */
  remote: string;
  owner: MetaDriftOwner;
  severity: MetaDriftSeverity;
}

/**
 * Deriva vigente del producto contra Meta. `detectedAt` es la PRIMERA detección de ESTA
 * deriva (misma firma de campos + dueño): una corrida diaria que vuelve a ver la misma
 * divergencia no la re-fecha ni genera un aviso nuevo — es el mismo incidente.
 */
export interface MetaDrift {
  /** Campos divergentes, ordenados (firma estable de la deriva). */
  fields: string[];
  /** Dueño AGREGADO: `vendeyapy` si alguno de los campos divergentes es nuestro. */
  owner: MetaDriftOwner;
  /** `commercial` si alguno de los campos divergentes lo es (manda el más grave). */
  severity: MetaDriftSeverity;
  detectedAt: Timestamp;
  /** Última corrida que volvió a ver esta misma deriva. */
  lastSeenAt: Timestamp;
  observed: MetaDriftObservation[];
  /**
   * Id NO SECRETO de la fuente externa reconocida relacionada (feed/data source), si la hay.
   * Jamás la URL del feed, su query string ni su token.
   */
  externalSourceId?: string | null;
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
  /**
   * Marca NEUTRAL del producto (cualquier rubro). Meta la exige para crear un artículo:
   * antes vivía SOLO en `perfume.brand`, lo que obligaba a fabricar atributos de perfumería
   * para cualquier vertical. `outboundBrand` la lee con fallback a `perfume.brand`, así los
   * productos existentes de arfagi no necesitan backfill.
   */
  brand?: string;
  /** Atributos de perfumería. null para productos que no son perfumes. */
  perfume: PerfumeAttributes | null;
  /**
   * URL pública del producto (`link` del contrato de escritura de Meta). OPCIONAL: los
   * productos existentes no la tienen. Es OBLIGATORIA para CREAR un artículo en Meta —
   * sin ella el create queda bloqueado con `product_url_missing`; jamás se inventa.
   * Un UPDATE parcial (p.ej. solo precio) NO la requiere.
   */
  productUrl?: string;
  /** Ficha para recomendaciones del agente (CATALOG-ENRICHMENT-1). Opcional. */
  aiFicha?: ProductAiFicha | null;
  // --- Sincronización con el Meta Catalog (D4). Lo escribe la sync (Admin SDK). ---
  /**
   * OPT-IN EXPLÍCITO de sincronización (META-CATALOG-RECONCILIATION-1). Fail-closed:
   * SOLO los productos con `syncToMeta === true` participan del plan de sync — ausente o
   * false ⇒ el producto queda COMPLETAMENTE fuera (ni create, ni update, ni disable).
   * Lo habilita una acción administrativa explícita, jamás una importación.
   */
  syncToMeta?: boolean;
  metaSyncStatus?: MetaSyncStatus;
  /**
   * Job del outbox que "manda" sobre el estado visible (META-CATALOG-OUTBOX-HARDEN-1). Los
   * jobs terminan en cualquier orden: sin esta generación, uno viejo que se reconcilia tarde
   * reemplazaba el estado, el error y la fecha de sync de un ciclo posterior ya confirmado.
   */
  metaSyncCurrentJobId?: string | null;
  metaCatalogId?: string | null;
  /**
   * `retailer_id` del artículo en Meta: la identidad remota que NOSOTROS controlamos.
   * Separado a propósito de `inventory.sku` (identidad interna, que jamás se toca para
   * adaptarla a Meta) y de `metaProductItemId` (el id opaco que asigna Meta).
   * Inmutable por las operaciones normales de catálogo: `validateProductPatch` no lo
   * acepta; solo lo escriben los callables administrativos de reconciliación.
   */
  metaRetailerId?: string | null;
  metaProductItemId?: string | null;
  /**
   * Última ESCRITURA NUESTRA confirmada contra Meta (ADR-0015 §5). Conserva exactamente su
   * significado histórico: "en este momento un job del outbox terminó `succeeded` y la
   * confirmación contra el catálogo dio bien". NO dice nada sobre lo que Meta muestra HOY —
   * eso lo dice `metaVerifiedAt`. Nunca lo escribe la verificación ni la reconciliación.
   */
  metaLastSyncAt?: Timestamp | null;
  metaSyncError?: string;
  /**
   * (ADR-0015 §5) Estado ACTUAL contra el catálogo remoto. Eje SEPARADO de `metaSyncStatus`
   * (histórico de nuestros jobs, inmutable). `verified` SOLO se escribe tras una lectura
   * remota real; `stale` jamás se persiste — se deriva en lectura comparando `metaVerifiedAt`
   * contra el TTL, así un job de verificación que falla envejece el estado en vez de dejarlo
   * mintiendo. SERVER-SET: lo escribe la reconciliación (Admin SDK); el cliente jamás.
   *
   * `null` es un valor LEGÍTIMO y significa "no hay proyección vigente": lo escribe la
   * reconciliación cuando el producto pierde su vínculo remoto. Sin esa salida un
   * `remote_missing` sobreviviría al desvínculo, caducaría a `stale` y apagaría la venta
   * automática de ese producto para siempre.
   */
  metaSyncState?: MetaSyncState | null;
  /**
   * Cuándo LEÍMOS Meta y comparamos este producto (≠ `metaLastSyncAt`, que es la última
   * escritura confirmada). Es la base de la caducidad derivada: sin este valor, o con uno más
   * viejo que el TTL, el estado efectivo es `stale`.
   */
  metaVerifiedAt?: Timestamp | null;
  /** Deriva vigente contra Meta. null ⇒ no hay divergencia conocida. SERVER-SET. */
  metaDrift?: MetaDrift | null;
  /**
   * Producto importado desde Meta cuyo STOCK todavía no fue validado por una persona.
   * No se inventa cantidad en la importación: este flag bloquea la habilitación de sync
   * hasta que alguien revise el inventario real.
   */
  stockPendingReview?: boolean;
  /**
   * Calidad del producto (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1). SERVER-SET: lo escribe
   * el recomputo de productUpsert y el import run; el cliente jamás (whitelist + rules).
   */
  quality?: ProductQuality;
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
