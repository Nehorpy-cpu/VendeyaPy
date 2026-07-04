/**
 * ai/tools/salesTools.ts — Tools del whatsapp_sales_agent (AG-2)
 * =============================================================
 * READ-ONLY y tenant-scoped. `execute(tenantId, input)` usa el tenantId YA RESUELTO por el backend
 * y NUNCA lee `input.tenantId`. Salida sanitizada por whitelist (sin costo/margen/financials).
 * `profitMode` jamás se usa acá. Inyectable (deps) para tests sin Firestore.
 */
import type { Product, Promotion } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { searchCatalog, type CatalogFilters } from '../../catalog/search.js';
import type { AiTool, AiToolHandler } from '../types.js';
import { sanitizeProduct, sanitizePromotion, type PublicProduct, type PublicPromotion } from './sanitize.js';

const MAX_RESULTS = 5;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) && v > 0 ? v : undefined);

// ---- buscar_productos ----

export interface SalesSearchDeps {
  searchCatalog: (tenantId: string, filters: CatalogFilters) => Promise<Product[]>;
}
const defaultSearchDeps: SalesSearchDeps = { searchCatalog };

const buscarProductosDef: AiTool = {
  name: 'buscar_productos',
  description: 'Busca productos públicos activos y con stock del negocio. Si `consulta` menciona un nombre o marca, esos productos vienen PRIMERO; si menciona una ocasión (noche, oficina...) o una nota (piña...), el orden ya lo refleja. Devuelve nombre, marca, precio, descripción, estilo, disponibilidad y una `ficha` con duración, proyección, ocasiones, clima, perfil, notas, cuándo recomendarlo y cuándo NO, objeciones y similares. NO devuelve costos ni márgenes.',
  inputSchema: {
    type: 'object',
    properties: {
      consulta: { type: 'string', description: 'Lo que busca el cliente, tal como lo dijo (nombre, marca o tipo: "Supremacy", "algo de Armaf", "un dulce").' },
      genero: { type: 'string', enum: ['Femenino', 'Masculino', 'Unisex'], description: 'Género del producto, SOLO si el cliente lo indicó.' },
      estilo: { type: 'string', description: 'Estilo (dulce, fresco, intenso, floral, cítrico, árabe...).' },
      precioMax: { type: 'number', description: 'Precio máximo en la moneda del negocio.' },
    },
    required: [],
  },
};

export const buscarProductos: AiToolHandler = {
  definition: buscarProductosDef,
  async execute(tenantId: string, input: Record<string, unknown>, deps: SalesSearchDeps = defaultSearchDeps): Promise<PublicProduct[]> {
    // tenantId viene del contexto; cualquier tenantId en `input` se ignora.
    const filters: CatalogFilters = {
      query: str(input.consulta), // F1B: matches por nombre/marca van primero (searchCatalog)
      gender: str(input.genero),
      styleTag: str(input.estilo),
      maxPrice: num(input.precioMax),
      limit: MAX_RESULTS,
      profitMode: false, // NUNCA modo ganancia para el bot público.
      texto: str(input.consulta), // CAT-2: la ficha (ocasión/notas/cuándo-NO) pesa en el orden
    };
    const productos = await deps.searchCatalog(tenantId, filters);
    return productos.map(sanitizeProduct);
  },
};

// ---- listar_promociones_activas ----

export interface SalesPromoDeps {
  listPromotions: (tenantId: string) => Promise<Promotion[]>;
}
const defaultPromoDeps: SalesPromoDeps = {
  listPromotions: async (tenantId) => {
    const snap = await db().collection(paths.promotions(tenantId)).get();
    return snap.docs.map((d) => d.data() as Promotion);
  },
};

const listarPromocionesDef: AiTool = {
  name: 'listar_promociones_activas',
  description: 'Lista las promociones vigentes del negocio (nombre, descripción, tipo y descuento). Solo campos públicos.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

export const listarPromocionesActivas: AiToolHandler = {
  definition: listarPromocionesDef,
  async execute(tenantId: string, _input: Record<string, unknown>, deps: SalesPromoDeps = defaultPromoDeps): Promise<PublicPromotion[]> {
    const promos = await deps.listPromotions(tenantId);
    return promos.filter((p) => p.status !== 'FINISHED').map(sanitizePromotion);
  },
};

// ---- crear_borrador_pedido — CONTRATO DESHABILITADO en AG-2 ----
// Es un WRITE (createPendingOrder). NO está en ningún registry: el modelo no lo ve ni lo puede llamar.
// Se habilita con gating/auditoría en AG-3. Se exporta solo el contrato (definición) para referencia.
export const crearBorradorPedidoContract: AiTool = {
  name: 'crear_borrador_pedido',
  description: '(DESHABILITADO en AG-2) Crearía un borrador de pedido con el carrito actual.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};
