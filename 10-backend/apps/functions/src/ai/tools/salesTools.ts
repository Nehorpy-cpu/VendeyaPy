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
import { esBusquedaSimilar, splitByQueryMatch, hayConsultaDeEntidad, tokensIdentitarios } from '../../catalog/match.js';
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
  description: 'Busca productos públicos activos y con stock del negocio. Si `consulta` nombra un producto o marca, devuelve SOLO los que realmente coinciden (marcados `coincidencia: "exacta"`); si esa consulta no tiene coincidencia real, o el cliente pidió algo "parecido/similar", las opciones vienen marcadas `coincidencia: "alternativa"` — NO pertenecen al nombre/marca consultado y solo pueden ofrecerse como alternativas explícitas. Un "exacta" con `fueraDeFiltros: true` existe pero no cumple el precio/género pedido: explicalo, no lo niegues. En consultas genéricas (estilo/ocasión) el campo `coincidencia` no viaja. Devuelve nombre, marca, precio, descripción, estilo, disponibilidad y una `ficha` con duración, proyección, ocasiones, clima, perfil, notas, cuándo recomendarlo y cuándo NO, objeciones y similares. NO devuelve costos ni márgenes.',
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
    const consulta = str(input.consulta);
    const filters: CatalogFilters = {
      query: consulta, // F1B: matches por nombre/marca van primero (searchCatalog)
      gender: str(input.genero),
      styleTag: str(input.estilo),
      maxPrice: num(input.precioMax),
      limit: MAX_RESULTS,
      profitMode: false, // NUNCA modo ganancia para el bot público.
      texto: consulta, // CAT-2: la ficha (ocasión/notas/cuándo-NO) pesa en el orden
      // F7: "parecido/alternativa a X" admite acompañar con similares; una consulta directa por
      // nombre/marca con coincidencias reales devuelve SOLO esas (fidelidad estricta).
      allowSimilar: consulta ? esBusquedaSimilar(consulta) : false,
    };
    const productos = await deps.searchCatalog(tenantId, filters);
    // F7: la PERTENENCIA es determinística (mismo matcher que el pinning) — la IA no decide qué
    // producto "es" el nombre/marca consultado: se lo marcamos por dato en cada resultado.
    // La marca solo viaja si la consulta tiene señal de ENTIDAD (review F7): en una consulta
    // genérica de estilo/ocasión ("para salir de noche") marcar todo 'alternativa' induciría
    // un falso "no tenemos eso".
    const pinnedIds = consulta ? new Set(splitByQueryMatch(consulta, productos).pinned.map((p) => p.id)) : new Set<string>();
    const esEntidad =
      !!consulta &&
      (pinnedIds.size > 0
        ? hayConsultaDeEntidad(consulta, productos.filter((p) => pinnedIds.has(p.id)))
        : tokensIdentitarios(consulta).length > 0);
    let out: PublicProduct[] = productos.map((p) => {
      const pub = sanitizeProduct(p);
      if (!esEntidad) return pub;
      return { ...pub, coincidencia: pinnedIds.has(p.id) ? ('exacta' as const) : ('alternativa' as const) };
    });

    // F7 (review): el filtro explícito (precio/género) puede excluir la coincidencia exacta y,
    // sin señal, la IA afirmaría "no lo tenemos" cuando SÍ existe. Se re-busca solo por nombre
    // y lo excluido viaja PRIMERO, marcado exacta + fueraDeFiltros — la IA lo explica ("existe
    // pero cuesta X / es masculino"), nunca lo niega.
    if (consulta && esEntidad && !out.some((p) => p.coincidencia === 'exacta') && (filters.gender || filters.maxPrice)) {
      const soloNombre = await deps.searchCatalog(tenantId, { query: consulta, limit: MAX_RESULTS, profitMode: false });
      const excluidos = splitByQueryMatch(consulta, soloNombre).pinned.slice(0, 2);
      if (excluidos.length && hayConsultaDeEntidad(consulta, excluidos)) {
        out = [
          ...excluidos.map((p) => ({ ...sanitizeProduct(p), coincidencia: 'exacta' as const, fueraDeFiltros: true })),
          ...out,
        ].slice(0, MAX_RESULTS);
      }
    }
    return out;
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
