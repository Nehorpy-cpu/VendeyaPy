'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Product } from '@vpw/shared';
import { aiFichaQuality } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import {
  listProducts,
  listCategories,
  listProductFinancials,
  fetchCatalogOwnershipStatus,
  upsertProduct,
  deleteProduct,
  productMargin,
  syncCatalogToMeta,
  setProductSyncEnabled,
  type CatalogSyncRun,
  type ProductInput,
  type SetSyncEnabledResult,
  type UpsertQualityResult,
} from '@/lib/catalog';
import {
  esElegibleParaSync,
  razonNoElegible,
  agruparNoElegibles,
  observacionesAbiertas,
  RAZON_NO_ELEGIBLE_LABEL,
  type RazonNoElegible,
} from '@/lib/catalogQuality';
import { ProductForm } from '@/components/ProductForm';
import { MetaReconciliation } from '@/components/MetaReconciliation';
import { OutboxIncidents } from '@/components/OutboxIncidents';
import { CatalogQualityCenter } from '@/components/CatalogQualityCenter';
import { CatalogOwnershipCard } from '@/components/CatalogOwnershipCard';
import { MetaCatalogImport } from '@/components/MetaCatalogImport';
import { ProductMetaCell, motivoSinCamposPropios } from '@/components/ProductMetaCell';
import { ConfirmModal } from '@/components/ui';

const gs = (n: number | null | undefined) =>
  n == null ? '—' : '₲ ' + n.toLocaleString('es-PY');

/** Habilitar la sincronización con Meta es una acción de dueño (el backend la restringe igual). */
const ROLES_RECONCILIACION = new Set(['TENANT_OWNER', 'PLATFORM_ADMIN']);

const SYNC_BLOCKER_LABEL: Record<string, string> = {
  not_active: 'el producto no está activo',
  name_missing: 'falta el nombre',
  price_invalid: 'el precio no es válido',
  currency_not_pyg: 'la moneda no es PYG',
  image_not_https: 'falta una imagen segura (https)',
  category_missing: 'falta la categoría',
  stock_pending_review: 'falta revisar el stock (editá el producto y guardá su inventario)',
  not_sellable_now: 'hoy no es vendible (sin stock)',
  unconfirmed_remote_match: 'su código ya existe en Meta: vinculalo desde la reconciliación antes de sincronizar',
  no_identity: 'falta el SKU o el vínculo con Meta',
  identity_too_long: 'el código supera los 100 caracteres que admite Meta',
  // Solo aparecen cuando el artículo todavía NO existe en Meta: crearlo exige estos datos.
  description_missing: 'falta la descripción (Meta la exige para crear el artículo)',
  brand_missing: 'falta la marca (Meta la exige para crear el artículo)',
  product_url_missing: 'falta el enlace al producto (editá el producto y cargá su URL)',
  product_url_not_https: 'el enlace al producto debe empezar con https://',
};

/** Tope de la tanda de habilitación masiva (una llamada por producto, en serie). */
const TANDA_MAX = 50;

/** Desenlace por producto de la habilitación masiva (para informar TODO, no un total mudo). */
interface ResultadoMasivo {
  productId: string;
  name: string;
  ok: boolean;
  blockers?: string[];
  error?: string;
}

export default function CatalogPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { claims } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  // Búsqueda con debounce: filtrar y re-renderizar la tabla entera por tecla no escala
  // con catálogos importados grandes (hallazgo de auditoría de la lista).
  const [busqueda, setBusqueda] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(search), 200);
    return () => clearTimeout(t);
  }, [search]);
  const [editing, setEditing] = useState<Product | null | undefined>(undefined); // undefined = cerrado
  const [confirmDelete, setConfirmDelete] = useState<Product | null>(null);
  // Resultado de calidad del último guardado (contrato nuevo de productUpsert).
  const [saveQuality, setSaveQuality] = useState<{ nombre: string; quality: UpsertQualityResult } | null>(null);
  // Detalle expandido del badge de calidad por fila (accesible: no solo tooltip).
  const [detalleCalidad, setDetalleCalidad] = useState<Set<string>>(new Set());
  // --- Selección masiva de elegibles para habilitar sincronización ---
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [confirmarMasivo, setConfirmarMasivo] = useState(false);
  const [masivo, setMasivo] = useState<{
    fase: 'idle' | 'corriendo' | 'hecho';
    actual: number;
    total: number;
    resultados: ResultadoMasivo[];
  }>({ fase: 'idle', actual: 0, total: 0, resultados: [] });
  const masivoRef = useRef(false);

  const productsQ = useQuery({
    queryKey: ['products', tenantId],
    queryFn: () => listProducts(tenantId!),
    enabled: !!tenantId,
  });
  const categoriesQ = useQuery({
    queryKey: ['categories', tenantId],
    queryFn: () => listCategories(tenantId!),
    enabled: !!tenantId,
  });
  // Costos privados (productFinancials): solo Owner/Manager pueden leerlos.
  const financialsQ = useQuery({
    queryKey: ['productFinancials', tenantId],
    queryFn: () => listProductFinancials(tenantId!),
    enabled: !!tenantId,
  });
  const finMap = financialsQ.data ?? {};
  /**
   * ADR-0015: propiedad por campos. La MISMA queryKey que usa la tarjeta (react-query
   * deduplica: una sola llamada). Con cero campos propios no existe patch posible, así que el
   * panel bloquea el opt-in, la tanda masiva y el envío, y muestra el motivo.
   *
   * FAIL-CLOSED: mientras no se sabe (cargando o error) TAMBIÉN se bloquea. El gate real vive
   * en el backend, pero un panel que ofrece "sincronizar" y "enviar" cuando no pudo leer la
   * propiedad promete algo que no puede cumplir — y con el catálogo gobernado por un feed
   * externo, esa promesa es justamente la que abre el loop diario de escrituras.
   */
  const ownershipQ = useQuery({
    queryKey: ['catalogOwnership', tenantId],
    queryFn: () => fetchCatalogOwnershipStatus(tenantId!),
    enabled: !!tenantId,
    retry: false,
  });
  const ownership = ownershipQ.data ?? null;
  const ownershipCargando = ownershipQ.isLoading;
  const motivoBloqueoEnvio = motivoSinCamposPropios(ownership, { cargando: ownershipCargando });

  const saveMut = useMutation({
    mutationFn: (input: ProductInput) => upsertProduct(tenantId!, input),
    onSuccess: (res, input) => {
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
      qc.invalidateQueries({ queryKey: ['productFinancials', tenantId] });
      qc.invalidateQueries({ queryKey: ['catalogQuality', tenantId] });
      setEditing(undefined);
      // El backend recomputa la calidad al guardar y cuenta qué se resolvió y qué falta.
      setSaveQuality(res.quality ? { nombre: input.name, quality: res.quality } : null);
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteProduct(tenantId!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
      qc.invalidateQueries({ queryKey: ['productFinancials', tenantId] });
      qc.invalidateQueries({ queryKey: ['catalogQuality', tenantId] });
      setConfirmDelete(null);
    },
  });
  // META-CATALOG-LIVE-1: el botón corre SIEMPRE un dry-run (plan sin escrituras en Meta).
  // "Aplicar" solo aparece si el backend confirma config en modo live, y con confirmación.
  const [syncRun, setSyncRun] = useState<CatalogSyncRun | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  // META-CATALOG-RECONCILIATION-1: opt-in de sincronización por producto (fail-closed).
  const puedeReconciliar = !!claims.role && ROLES_RECONCILIACION.has(claims.role);
  // Sin campos propios —o sin poder leer quién los gobierna— no hay envío posible: tildar
  // productos para "habilitar sincronización" sería ofrecer una acción que no puede terminar en
  // nada. Se oculta la selección; el porqué lo explica la tarjeta de propiedad y cada fila.
  const puedeSeleccionar = puedeReconciliar && !motivoBloqueoEnvio;
  const [confirmSync, setConfirmSync] = useState<Product | null>(null);
  const [syncPreview, setSyncPreview] = useState<SetSyncEnabledResult | null>(null);
  const syncFlagMut = useMutation({
    mutationFn: (v: { productId: string; enabled: boolean; confirmDiff?: boolean }) =>
      setProductSyncEnabled(tenantId!, v.productId, v.enabled, { confirmDiff: v.confirmDiff }),
    onSuccess: (res, v) => {
      if (res.ok) {
        setConfirmSync(null);
        setSyncPreview(null);
        qc.invalidateQueries({ queryKey: ['products', tenantId] });
        qc.invalidateQueries({ queryKey: ['catalogQuality', tenantId] });
      } else if (v.enabled) {
        // El backend devuelve el diff a confirmar o la lista de requisitos que faltan.
        setSyncPreview(res);
      }
    },
  });
  const syncMut = useMutation({
    // META-CATALOG-PREVIEW-BINDING-1: el envío real viaja ATADO a la previsualización
    // aprobada (runId + planHash). Si algo cambió desde entonces, el backend responde
    // failed-precondition y NO encola nada: hay que previsualizar de nuevo.
    mutationFn: (apply: boolean) =>
      syncCatalogToMeta(tenantId!, {
        apply,
        ...(apply && syncRun?.planHash ? { preview: { runId: syncRun.runId, planHash: syncRun.planHash } } : {}),
      }),
    onSuccess: (run) => {
      setSyncRun(run);
      setConfirmApply(false);
      if (run.requestedMode === 'apply') qc.invalidateQueries({ queryKey: ['products', tenantId] });
    },
    onError: (_e, apply) => {
      setConfirmApply(false);
      // La evidencia quedó inválida (vencida/consumida/desactualizada): el plan mostrado ya
      // no es aplicable — se limpia para forzar una previsualización fresca.
      if (apply) setSyncRun(null);
    },
  });

  // Ocultamos los productos dados de baja (status ARCHIVED, por el soft-delete del callable).
  // Product ya trae `brand` y `quality` (server-set) desde @vpw/shared.
  const activeProducts = useMemo(
    () => (productsQ.data ?? []).filter((p) => p.status !== 'ARCHIVED'),
    [productsQ.data],
  );
  const archivedCount = (productsQ.data ?? []).length - activeProducts.length;
  const filtered = useMemo(() => {
    const s = busqueda.trim().toLowerCase();
    if (!s) return activeProducts;
    return activeProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(s) ||
        (p.brand ?? p.perfume?.brand ?? '').toLowerCase().includes(s),
    );
  }, [activeProducts, busqueda]);

  // Precalculado UNA vez por carga de productos (no por fila y por render): con catálogos
  // importados grandes, evaluar la ficha en cada tecla del buscador congelaba la tabla.
  const infoFilas = useMemo(() => {
    const m = new Map<string, { fichaIncompleta: boolean; faltantes: string[]; abiertas: ReturnType<typeof observacionesAbiertas> }>();
    for (const p of activeProducts) {
      const ficha = aiFichaQuality(p);
      m.set(p.id, {
        fichaIncompleta: ficha.level === 'incompleto' || ficha.level === 'basico',
        faltantes: ficha.faltantes,
        abiertas: observacionesAbiertas(p),
      });
    }
    return m;
  }, [activeProducts]);

  // --- Selección masiva: solo elegibles (la elegibilidad la evalúa el backend vía quality) ---
  const elegiblesVisibles = useMemo(() => filtered.filter(esElegibleParaSync), [filtered]);
  const noElegiblesVisibles = useMemo(() => agruparNoElegibles(filtered), [filtered]);
  const noElegiblesTotal = useMemo(
    () => Object.values(noElegiblesVisibles).reduce((a, b) => a + (b ?? 0), 0),
    [noElegiblesVisibles],
  );
  const todosElegiblesSeleccionados =
    elegiblesVisibles.length > 0 && elegiblesVisibles.every((p) => seleccion.has(p.id));
  const toggleSeleccion = (id: string) =>
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < TANDA_MAX) next.add(id);
      return next;
    });
  const toggleTodos = () =>
    setSeleccion((prev) => {
      if (todosElegiblesSeleccionados) {
        const next = new Set(prev);
        for (const p of elegiblesVisibles) next.delete(p.id);
        return next;
      }
      const next = new Set(prev);
      for (const p of elegiblesVisibles) {
        if (next.size >= TANDA_MAX) break;
        next.add(p.id);
      }
      return next;
    });

  /**
   * Habilita la sincronización de los seleccionados EN SERIE (una llamada por producto,
   * tope 50 por tanda). El backend re-valida cada uno: acá solo se informa el desenlace.
   * NO envía nada a Meta — el envío sigue siendo Previsualizar → Enviar (preview binding).
   */
  const correrMasivo = async () => {
    if (masivoRef.current || !tenantId) return;
    masivoRef.current = true;
    const ids = [...seleccion].slice(0, TANDA_MAX);
    const porId = new Map(activeProducts.map((p) => [p.id, p]));
    setMasivo({ fase: 'corriendo', actual: 0, total: ids.length, resultados: [] });
    const resultados: ResultadoMasivo[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const nombre = porId.get(id)?.name ?? id;
      try {
        const res = await setProductSyncEnabled(tenantId, id, true, { confirmDiff: true });
        resultados.push(res.ok ? { productId: id, name: nombre, ok: true } : { productId: id, name: nombre, ok: false, blockers: res.blockers });
      } catch (e) {
        resultados.push({ productId: id, name: nombre, ok: false, error: errMsg(e) });
      }
      setMasivo({ fase: 'corriendo', actual: i + 1, total: ids.length, resultados: [...resultados] });
    }
    setMasivo({ fase: 'hecho', actual: ids.length, total: ids.length, resultados });
    setSeleccion(new Set());
    qc.invalidateQueries({ queryKey: ['products', tenantId] });
    qc.invalidateQueries({ queryKey: ['catalogQuality', tenantId] });
    masivoRef.current = false;
  };

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
        Seleccioná una empresa en la barra superior para ver su catálogo.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Catálogo</h1>
          <p className="mt-1 text-sm text-ink-500">Tus productos, precios y stock. El bot ofrece lo que esté activo acá.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => syncMut.mutate(false)} disabled={syncMut.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50">
            {syncMut.isPending ? 'Previsualizando…' : 'Previsualizar cambios'}
          </button>
          <button onClick={() => setEditing(null)} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700">
            + Nuevo producto
          </button>
        </div>
      </div>

      {/* Solo el dueño puede resolver un envío trabado (el backend lo restringe igual). */}
      {puedeReconciliar && <OutboxIncidents tenantId={tenantId} />}

      {/* Resultado de calidad del último guardado (contrato nuevo de productUpsert):
          alert si quedaron bloqueantes, status si fue informativo. */}
      {saveQuality && (
        <div
          role={saveQuality.quality.pendientes.some((p) => p.severity === 'BLOCKING') ? 'alert' : 'status'}
          className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 text-sm">
              <p className="font-semibold text-ink-900">
                Guardado: {saveQuality.nombre}
                {saveQuality.quality.resueltas.length > 0 && (
                  <span className="ml-2 font-normal text-mint-700">
                    Se resolvieron {saveQuality.quality.resueltas.length} pendiente{saveQuality.quality.resueltas.length === 1 ? '' : 's'}.
                  </span>
                )}
              </p>
              {saveQuality.quality.pendientes.length === 0 ? (
                <p className="mt-1 text-mint-700">No quedan datos pendientes en este producto.</p>
              ) : (
                <>
                  <p className="mt-1 text-ink-700">
                    Quedan {saveQuality.quality.pendientes.length} por resolver:
                  </p>
                  <ul className="mt-1 space-y-1">
                    {saveQuality.quality.pendientes.map((p) => (
                      <li key={`${p.code}:${p.field}`} className="flex flex-wrap items-baseline gap-2 text-xs">
                        <span
                          className={
                            'inline-flex rounded-full px-2 py-0.5 font-semibold ' +
                            (p.severity === 'BLOCKING' ? 'bg-coral-50 text-coral-700' : 'bg-amber-50 text-amber-700')
                          }
                        >
                          {p.severity === 'BLOCKING' ? 'Impide vender/publicar' : 'Advertencia'}
                        </span>
                        <span className="text-ink-700">{p.message}</span>
                        {p.action && <span className="text-ink-500">→ {p.action}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <button
              onClick={() => setSaveQuality(null)}
              className="text-xs font-medium text-ink-500 transition-colors hover:text-ink-700"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Quién publica cada dato del catálogo (ADR-0015): va primero porque condiciona todo
          lo demás — con el catálogo gobernado afuera, "enviar a Meta" no es una opción. */}
      <CatalogOwnershipCard tenantId={tenantId} products={activeProducts} />

      {/* Centro de calidad: agregado server-side + detalle de observaciones por producto. */}
      <CatalogQualityCenter
        tenantId={tenantId}
        products={activeProducts}
        onEditar={(productId) => {
          const p = activeProducts.find((x) => x.id === productId);
          if (p) setEditing(p);
        }}
      />

      {/* Importación paginada del catálogo de Meta (solo dueño; el componente se auto-oculta). */}
      <MetaCatalogImport tenantId={tenantId} categories={categoriesQ.data ?? []} />

      <MetaReconciliation tenantId={tenantId} categories={categoriesQ.data ?? []} />

      {(syncMut.isError || syncRun) && (
        <div role="status" aria-live="polite" className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
          {syncMut.isError ? (
            <p className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
              No se pudo correr la sincronización: {errMsg(syncMut.error)}
            </p>
          ) : syncRun ? (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-ink-900">{syncTitle(syncRun)}</h2>
                <button
                  onClick={() => { setSyncRun(null); setConfirmApply(false); }}
                  className="text-xs font-medium text-ink-400 transition-colors hover:text-ink-600"
                >
                  Cerrar
                </button>
              </div>

              {syncRun.status === 'disabled' && (
                <p className="text-ink-600">
                  Esta empresa no tiene habilitada la sincronización de catálogo con Meta. Se habilita por configuración de la plataforma.
                </p>
              )}
              {syncRun.status === 'apply_blocked' && (
                <p className="text-ink-600">
                  La configuración está en modo <span className="font-semibold">{syncRun.configMode}</span>: aplicar cambios reales en Meta requiere el modo <span className="font-semibold">live</span>.
                </p>
              )}
              {syncRun.status === 'error' && (
                <p className="rounded-lg bg-coral-50 px-3 py-2 text-coral-700">{syncErrorText(syncRun)}</p>
              )}

              {syncRun.summary && (
                <>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <SyncChip label="Crear" n={syncRun.summary.create} tone="mint" />
                    <SyncChip label="Actualizar" n={syncRun.summary.update} tone="mint" />
                    <SyncChip label="Deshabilitar" n={syncRun.summary.disable} tone="amber" />
                    <SyncChip label="Sin cambios" n={syncRun.summary.unchanged} tone="ink" />
                    <SyncChip label="Bloqueados" n={syncRun.summary.blocked} tone="coral" />
                    <SyncChip label="Solo en Meta" n={syncRun.summary.remoteOnly} tone="ink" />
                  </div>
                  {(syncRun.excludedNotManaged ?? 0) > 0 && (
                    <p className="text-xs text-ink-500">
                      {syncRun.excludedNotManaged} producto{syncRun.excludedNotManaged === 1 ? '' : 's'} sin sincronización habilitada:
                      quedan fuera de esta corrida (no se crean, no se actualizan ni se dan de baja en Meta).
                    </p>
                  )}
                </>
              )}

              {(syncRun.entries ?? []).some((e) => e.action === 'blocked') && (
                <ul className="space-y-1 rounded-lg bg-coral-50/60 px-3 py-2 text-xs text-coral-800">
                  {(syncRun.entries ?? [])
                    .filter((e) => e.action === 'blocked')
                    .map((e) => (
                      <li key={e.productId}>
                        <span className="font-medium">{e.productName}</span>
                        {e.sku ? ` (SKU ${e.sku})` : ''}: {(e.blockedReasons ?? []).map(blockReasonLabel).join(', ')}
                        {e.suggestion && (
                          <> — en Meta existe “{e.suggestion.remoteName}” con SKU {e.suggestion.remoteRetailerId}; verificá el SKU antes de sincronizar.</>
                        )}
                      </li>
                    ))}
                </ul>
              )}

              {(syncRun.status === 'queued' || syncRun.status === 'partial_failure') && (
                <div className={syncRun.status === 'queued' ? 'text-mint-700' : 'text-coral-700'} role="status">
                  <p>
                    En cola: {syncRun.queuedCount ?? 0}
                    {(syncRun.deduplicatedCount ?? 0) > 0 ? ` · Ya estaban en cola: ${syncRun.deduplicatedCount}` : ''}
                    {(syncRun.awaitingReviewCount ?? 0) > 0 ? ` · Esperando tu revisión: ${syncRun.awaitingReviewCount}` : ''}
                    {(syncRun.blockedCount ?? 0) > 0 ? ` · Con problemas: ${syncRun.blockedCount}` : ''}
                    {syncRun.errorDetail ? ` — ${syncRun.errorDetail}` : ''}
                  </p>
                  {/* Honestidad explícita: encolar NO es haber cambiado nada en Meta. */}
                  <p className="mt-1 text-xs text-ink-500">
                    Los cambios salen hacia Meta en los próximos minutos. Cada producto muestra su estado en la lista y
                    solo dice <strong>Confirmado</strong> cuando Meta confirma que quedó igual que acá.
                  </p>
                </div>
              )}

              {syncRun.status === 'planned' && (
                <div className="flex flex-wrap items-center gap-3 border-t border-ink-100 pt-3">
                  {/* Bloqueo por propiedad: sin campos propios no existe patch posible, así que
                      el envío ni se ofrece. El backend lo rechaza igual; acá se explica por qué. */}
                  {motivoBloqueoEnvio ? (
                    <p className="text-xs text-ink-700">
                      <span className="font-semibold">No se puede enviar nada a Meta:</span> {motivoBloqueoEnvio} Esta
                      previsualización es solo para que veas las diferencias.
                    </p>
                  ) : syncRun.configMode === 'live' ? (
                    // El envío real solo se ofrece con evidencia (planHash) y con algo para
                    // enviar: va atado a ESTA previsualización, con cantidad y producto a la vista.
                    !syncRun.planHash || applySummary(syncRun).count === 0 ? (
                      <p className="text-xs text-ink-500">
                        {applySummary(syncRun).count === 0
                          ? 'No hay cambios para enviar: todo está igual que en Meta o excluido del plan.'
                          : 'Esta previsualización no es utilizable para enviar. Previsualizá de nuevo.'}
                      </p>
                    ) : confirmApply ? (
                      <>
                        <span className="text-xs text-ink-600">{applySummary(syncRun).confirm}</span>
                        <button
                          onClick={() => syncMut.mutate(true)}
                          disabled={syncMut.isPending}
                          className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                        >
                          {syncMut.isPending ? 'Encolando…' : 'Sí, enviar'}
                        </button>
                        <button
                          onClick={() => setConfirmApply(false)}
                          className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
                        >
                          Cancelar
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmApply(true)}
                        className="rounded-lg border border-mint-600 px-3 py-1.5 text-xs font-semibold text-mint-700 transition-colors hover:bg-mint-50"
                      >
                        {applySummary(syncRun).label}
                      </button>
                    )
                  ) : (
                    <p className="text-xs text-ink-500">
                      Modo dry-run: esta previsualización no escribió nada en Meta. Para aplicar cambios reales, la plataforma debe activar el modo live.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar productos por nombre o marca"
          placeholder="Buscar por nombre o marca…"
          className="w-full max-w-sm rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
        />
        {archivedCount > 0 && (
          <p className="text-xs text-ink-500">
            {archivedCount} producto{archivedCount === 1 ? '' : 's'} dado{archivedCount === 1 ? '' : 's'} de baja (ocultos).
          </p>
        )}
      </div>

      {/* Barra de habilitación masiva: aparece con la selección o mientras corre la tanda. */}
      {puedeSeleccionar && (seleccion.size > 0 || masivo.fase !== 'idle') && (
        <section
          aria-label="Habilitación masiva de sincronización"
          className="space-y-2 rounded-2xl border border-mint-200 bg-mint-50/40 p-4"
        >
          {masivo.fase !== 'corriendo' && seleccion.size > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-ink-800">
                {seleccion.size} producto{seleccion.size === 1 ? '' : 's'} seleccionado{seleccion.size === 1 ? '' : 's'}
              </span>
              <button
                onClick={() => setConfirmarMasivo(true)}
                className="rounded-lg bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700"
              >
                Habilitar sincronización ({seleccion.size})
              </button>
              <button
                onClick={() => setSeleccion(new Set())}
                className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
              >
                Quitar selección
              </button>
              {seleccion.size >= TANDA_MAX && (
                <span className="text-xs text-ink-600">Tope de {TANDA_MAX} por tanda: habilitá estos y repetí con los demás.</span>
              )}
              <span className="text-xs text-ink-600">
                No envía nada a Meta: el envío se hace después con “Previsualizar cambios”.
              </span>
            </div>
          )}

          {/* Progreso y resultados con aria-live: el lector anuncia sin robar el foco. */}
          <div role="status" aria-live="polite" className="space-y-2">
            {masivo.fase === 'corriendo' && (
              <p className="text-sm text-ink-700">
                Habilitando {masivo.actual} de {masivo.total}… no cierres esta pestaña.
              </p>
            )}
            {masivo.fase === 'hecho' && (
              <div className="space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-ink-800">
                    <span className="font-semibold text-mint-700">
                      {masivo.resultados.filter((r) => r.ok).length} habilitado{masivo.resultados.filter((r) => r.ok).length === 1 ? '' : 's'}
                    </span>
                    {masivo.resultados.some((r) => !r.ok) && (
                      <>
                        {' '}· <span className="font-semibold text-coral-700">{masivo.resultados.filter((r) => !r.ok).length} quedaron fuera</span>
                      </>
                    )}
                  </p>
                  <button
                    onClick={() => setMasivo({ fase: 'idle', actual: 0, total: 0, resultados: [] })}
                    className="rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
                  >
                    Entendido
                  </button>
                </div>
                {masivo.resultados.some((r) => !r.ok) && (
                  <ul className="space-y-0.5 text-xs text-ink-700">
                    {agruparFallasMasivo(masivo.resultados).map((g) => (
                      <li key={g.motivo}>
                        <span className="font-medium">{g.nombres.length} por “{g.motivo}”</span>: {g.nombres.slice(0, 5).join(', ')}
                        {g.nombres.length > 5 ? ` y ${g.nombres.length - 5} más` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {noElegiblesTotal > 0 && masivo.fase !== 'corriendo' && (
            <p className="text-xs text-ink-600">
              {noElegiblesTotal} de los productos visibles no se pueden seleccionar:{' '}
              {(Object.entries(noElegiblesVisibles) as Array<[RazonNoElegible, number]>)
                .map(([r, n]) => `${n} ${RAZON_NO_ELEGIBLE_LABEL[r]}`)
                .join(' · ')}
              . Los bloqueados se corrigen desde “Calidad del catálogo”.
            </p>
          )}
        </section>
      )}

      {productsQ.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl border border-ink-100 bg-ink-50/60" />)}
        </div>
      )}
      {productsQ.isError && (
        <div className="rounded-2xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-700">
          No se pudo cargar el catálogo. Revisá tu sesión y permisos.
        </div>
      )}

      {productsQ.isSuccess && filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center">
          <h3 className="text-sm font-semibold text-ink-800">{search ? 'Sin coincidencias' : 'Todavía no hay productos'}</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">
            {search ? 'No hay productos que coincidan con la búsqueda.' : 'Creá el primero con “+ Nuevo producto” para que el bot pueda ofrecerlo.'}
          </p>
        </div>
      )}

      {productsQ.isSuccess && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-ink-100 bg-white shadow-soft">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                {puedeSeleccionar && (
                  <th scope="col" className="w-10 px-4 py-3">
                    {/* Selecciona SOLO los elegibles visibles (sin bloqueos y sin sync activa). */}
                    <input
                      type="checkbox"
                      ref={(el) => {
                        if (el) el.indeterminate = !todosElegiblesSeleccionados && elegiblesVisibles.some((p) => seleccion.has(p.id));
                      }}
                      checked={todosElegiblesSeleccionados}
                      onChange={toggleTodos}
                      disabled={elegiblesVisibles.length === 0 || masivo.fase === 'corriendo'}
                      aria-label={`Seleccionar los ${Math.min(elegiblesVisibles.length, TANDA_MAX)} productos elegibles para habilitar sincronización`}
                      title={
                        elegiblesVisibles.length === 0
                          ? 'No hay productos elegibles en la vista'
                          : `Seleccionar elegibles (hasta ${TANDA_MAX} por tanda)`
                      }
                      className="h-4 w-4 rounded border-ink-300 text-mint-600 focus:ring-mint-500 disabled:opacity-40"
                    />
                  </th>
                )}
                <th scope="col" className="px-4 py-3">Producto</th>
                <th scope="col" className="px-4 py-3">Precio</th>
                <th scope="col" className="px-4 py-3">Costo</th>
                <th scope="col" className="px-4 py-3">Margen</th>
                <th scope="col" className="px-4 py-3">Stock</th>
                <th scope="col" className="px-4 py-3">Estado</th>
                <th scope="col" className="px-4 py-3">Meta</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {filtered.map((p) => {
                const cost = finMap[p.id]?.costPrice ?? null;
                const margin = productMargin(p.price, cost);
                const stock = p.inventory?.stock ?? 0;
                // Precalculado por carga (no por render): ficha CAT-1 + observaciones de calidad.
                const info = infoFilas.get(p.id);
                const fichaIncompleta = info?.fichaIncompleta === true;
                const abiertas = info?.abiertas ?? [];
                const blocking = p.quality?.blocking ?? 0;
                const razon = razonNoElegible(p);
                const detalleAbierto = detalleCalidad.has(p.id);
                const marca = p.brand ?? p.perfume?.brand ?? '';
                return (
                  <tr key={p.id} className="hover:bg-ink-50/50">
                    {puedeSeleccionar && (
                      <td className="px-4 py-3 align-top">
                        <input
                          type="checkbox"
                          checked={seleccion.has(p.id)}
                          disabled={razon != null || masivo.fase === 'corriendo' || (!seleccion.has(p.id) && seleccion.size >= TANDA_MAX)}
                          onChange={() => toggleSeleccion(p.id)}
                          aria-label={
                            razon != null
                              ? `${p.name}: no seleccionable (${RAZON_NO_ELEGIBLE_LABEL[razon]})`
                              : `Seleccionar ${p.name} para habilitar sincronización`
                          }
                          title={
                            razon != null
                              ? RAZON_NO_ELEGIBLE_LABEL[razon]
                              : !seleccion.has(p.id) && seleccion.size >= TANDA_MAX
                                ? `Máximo ${TANDA_MAX} por tanda`
                                : undefined
                          }
                          className="h-4 w-4 rounded border-ink-300 text-mint-600 focus:ring-mint-500 disabled:opacity-40"
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink-900">
                        {p.emoji} {p.name} {p.featured && <span title="Destacado">🌟</span>}
                      </div>
                      {marca && <div className="text-xs text-ink-500">{marca}</div>}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {/* Badge de calidad: botón (no solo tooltip) que despliega el detalle. */}
                        {abiertas.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setDetalleCalidad((prev) => {
                                const next = new Set(prev);
                                if (next.has(p.id)) next.delete(p.id);
                                else next.add(p.id);
                                return next;
                              })
                            }
                            aria-expanded={detalleAbierto}
                            className={
                              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-mint-500/40 ' +
                              (blocking > 0
                                ? 'border-coral-200 bg-coral-50 text-coral-700 hover:bg-coral-100'
                                : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100')
                            }
                          >
                            {blocking > 0 ? `Faltan datos (${blocking})` : `Revisar (${abiertas.length})`}
                            <span aria-hidden="true">{detalleAbierto ? '▴' : '▾'}</span>
                          </button>
                        )}
                        {fichaIncompleta && (
                          <span
                            className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
                            title={'La IA recomienda mejor con la ficha completa. Falta: ' + (info?.faltantes ?? []).slice(0, 4).join(', ')}
                          >
                            Ficha IA incompleta
                          </span>
                        )}
                      </div>
                      {detalleAbierto && abiertas.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-xs text-ink-600">
                          {abiertas.slice(0, 4).map((o) => (
                            <li key={`${o.code}:${o.field}`}>• {o.message}</li>
                          ))}
                          {abiertas.length > 4 && (
                            <li>… y {abiertas.length - 4} más en “Calidad del catálogo”.</li>
                          )}
                        </ul>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-700">{gs(p.price)}</td>
                    <td className="px-4 py-3 text-ink-600">{gs(cost)}</td>
                    <td className="px-4 py-3">
                      {margin == null ? (
                        <span className="text-amber-700" title="Sin precio de costo → ganancia incompleta">⚠️ sin costo</span>
                      ) : (
                        <span className={margin < 15 ? 'font-medium text-coral-600' : 'text-ink-700'}>{Math.round(margin)}%</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={stock <= 3 ? 'inline-flex rounded-full bg-coral-50 px-2 py-0.5 text-xs font-semibold text-coral-600' : 'text-ink-700'}>
                        {stock} u.
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ' + (p.status === 'ACTIVE' ? 'bg-mint-50 text-mint-700' : 'bg-ink-50 text-ink-500')}>
                        {p.status === 'ACTIVE' ? 'Activo' : p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {/* Estado ACTUAL contra lo publicado + propiedad + opt-in (ADR-0015). */}
                      <ProductMetaCell
                        product={p}
                        ownership={ownership}
                        ownershipCargando={ownershipCargando}
                        puedeReconciliar={puedeReconciliar}
                        ocupado={syncFlagMut.isPending}
                        onHabilitar={(prod) => setConfirmSync(prod)}
                        onDeshabilitar={(prod) => syncFlagMut.mutate({ productId: prod.id, enabled: false })}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setEditing(p)} className="mr-3 font-medium text-mint-700 hover:text-mint-600">Editar</button>
                      <button onClick={() => setConfirmDelete(p)} className="font-medium text-coral-600 hover:text-coral-700">Borrar</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirmación de la tanda masiva: UNA confirmación explícita para las N habilitaciones. */}
      {confirmarMasivo && (
        <ConfirmModal
          title={`¿Habilitar la sincronización de ${seleccion.size} producto${seleccion.size === 1 ? '' : 's'}?`}
          confirmLabel="Sí, habilitar"
          onCancel={() => setConfirmarMasivo(false)}
          onConfirm={() => {
            setConfirmarMasivo(false);
            void correrMasivo();
          }}
        >
          <ul className="space-y-1">
            <li>• Cada producto se verifica de nuevo en el servidor: el que no cumpla queda fuera y te avisamos por qué.</li>
            <li>• Los que ya existen en Meta se van a ACTUALIZAR con los datos de acá; los nuevos se van a CREAR.</li>
            <li>• <strong>No se envía nada a Meta ahora</strong>: los cambios salen recién cuando confirmás una previsualización.</li>
          </ul>
        </ConfirmModal>
      )}

      {editing !== undefined && (
        <ProductForm
          initial={editing}
          initialCost={editing ? (finMap[editing.id]?.costPrice ?? null) : null}
          initialPriority={editing ? (finMap[editing.id]?.priorityScore ?? null) : null}
          categories={categoriesQ.data ?? []}
          onCancel={() => setEditing(undefined)}
          onSubmit={(input) => saveMut.mutate(input)}
          saving={saveMut.isPending}
          error={saveMut.isError ? errMsg(saveMut.error) : null}
        />
      )}

      {confirmSync && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => { setConfirmSync(null); setSyncPreview(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="sync-title" className="w-full max-w-md rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <h3 id="sync-title" className="text-base font-semibold text-ink-900">Sincronizar este producto con Meta</h3>
            <p className="mt-2 text-sm text-ink-600">
              <span className="font-medium text-ink-800">{confirmSync.name}</span>
            </p>

            {!syncPreview && (
              <p className="mt-3 text-sm text-ink-600">
                Vamos a revisar si cumple los requisitos y a mostrarte exactamente qué se enviaría a Meta.
              </p>
            )}

            {syncPreview && syncPreview.blockers.length > 0 && (
              <div className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
                <p className="font-medium">Todavía no se puede sincronizar:</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {syncPreview.blockers.map((b) => <li key={b}>• {SYNC_BLOCKER_LABEL[b] ?? b}</li>)}
                </ul>
              </div>
            )}

            {syncPreview?.requiresConfirmation && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <p className="font-medium">{syncPreview.intent === 'update' ? 'Se va a ACTUALIZAR un artículo existente' : 'Se va a CREAR un artículo nuevo'}</p>
                <p className="mt-1 text-xs">{syncPreview.message}</p>
                <p className="mt-1 text-xs">Código en Meta: <strong>{syncPreview.retailerId}</strong></p>
              </div>
            )}

            {syncFlagMut.isError && <p role="alert" className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{errMsg(syncFlagMut.error)}</p>}

            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => { setConfirmSync(null); setSyncPreview(null); }} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
                {syncPreview && syncPreview.blockers.length > 0 ? 'Entendido' : 'Cancelar'}
              </button>
              {(!syncPreview || syncPreview.requiresConfirmation) && (
                <button
                  onClick={() => syncFlagMut.mutate({ productId: confirmSync.id, enabled: true, confirmDiff: !!syncPreview?.requiresConfirmation })}
                  disabled={syncFlagMut.isPending}
                  className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                >
                  {syncFlagMut.isPending ? 'Verificando…' : syncPreview?.requiresConfirmation ? 'Sí, sincronizar' : 'Revisar requisitos'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => setConfirmDelete(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="confirm-delete-title" className="w-full max-w-sm rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-delete-title" className="text-base font-semibold text-ink-900">¿Dar de baja el producto?</h3>
            <p className="mt-2 text-sm text-ink-600">
              <span className="font-medium text-ink-800">{confirmDelete.name}</span> se va a archivar: deja de mostrarse en el catálogo y al bot, pero se conservan sus pedidos y su costo. Podés reactivarlo editándolo y poniéndolo en ACTIVE.
            </p>
            {deleteMut.isError && (
              <p className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{errMsg(deleteMut.error)}</p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
                Cancelar
              </button>
              <button
                onClick={() => deleteMut.mutate(confirmDelete.id)}
                disabled={deleteMut.isPending}
                className="rounded-lg bg-coral-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-coral-700 disabled:opacity-60"
              >
                {deleteMut.isPending ? 'Archivando…' : 'Dar de baja'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Mensaje legible de un error de callable (HttpsError trae `message` claro). */
function errMsg(e: unknown): string {
  const m = (e as { message?: string } | null)?.message;
  return m && m.trim() ? m : 'No se pudo completar la operación. Revisá tus permisos o tu plan.';
}

/**
 * Agrupa las fallas de la tanda masiva por motivo legible (los blockers que devolvió el
 * backend, traducidos). El dueño ve CUÁNTOS quedaron fuera y POR QUÉ, no un total mudo.
 */
function agruparFallasMasivo(resultados: ResultadoMasivo[]): Array<{ motivo: string; nombres: string[] }> {
  const grupos = new Map<string, string[]>();
  for (const r of resultados) {
    if (r.ok) continue;
    const motivo =
      r.blockers && r.blockers.length > 0
        ? r.blockers.map((b) => SYNC_BLOCKER_LABEL[b] ?? b).join(' y ')
        : r.error ?? 'error inesperado';
    const lista = grupos.get(motivo) ?? [];
    lista.push(r.name);
    grupos.set(motivo, lista);
  }
  return [...grupos.entries()]
    .map(([motivo, nombres]) => ({ motivo, nombres }))
    .sort((a, b) => b.nombres.length - a.nombres.length);
}

// --- Presentación del resultado de la sync de catálogo (META-CATALOG-LIVE-1) ---

function syncTitle(run: CatalogSyncRun): string {
  switch (run.status) {
    case 'disabled': return 'Sincronización con Meta desactivada';
    case 'apply_blocked': return 'Aplicación bloqueada';
    case 'error': return 'Error al consultar Meta';
    case 'planned': return 'Previsualización del catálogo (sin escrituras en Meta)';
    case 'queued': return 'Cambios encolados hacia Meta';
    case 'partial_failure': return 'Encolado parcial (con problemas)';
  }
}

function syncErrorText(run: CatalogSyncRun): string {
  if (run.reason === 'missing_token') return 'No hay conexión con Meta configurada para esta empresa (falta el token).';
  if (run.reason === 'catalog_unreachable') return `No se pudo acceder al catálogo en Meta. ${run.errorDetail ?? ''}`.trim();
  return run.errorDetail ?? 'Error desconocido.';
}

/**
 * META-CATALOG-PREVIEW-BINDING-1: la acción real dice EXACTAMENTE qué manda — cantidad y,
 * si es un solo cambio, el producto. "Enviar 1 cambio a Meta (Armaf Odyssey Mega)" en vez
 * de un genérico "Enviar a Meta".
 */
function applySummary(run: CatalogSyncRun): { count: number; label: string; confirm: string } {
  const s = run.summary;
  const count = (s?.create ?? 0) + (s?.update ?? 0) + (s?.disable ?? 0);
  if (count === 1) {
    const entry = (run.entries ?? []).find((e) => e.action === 'create' || e.action === 'update' || e.action === 'disable');
    const quien = entry ? ` (${entry.productName})` : '';
    return { count, label: `Enviar 1 cambio a Meta${quien}…`, confirm: `¿Enviar 1 cambio al catálogo real de Meta${quien}?` };
  }
  return { count, label: `Enviar ${count} cambios a Meta…`, confirm: `¿Enviar ${count} cambios al catálogo real de Meta?` };
}

// El estado por producto (badge operativo + deriva contra lo publicado + opt-in) vive en
// components/ProductMetaCell.tsx desde ADR-0015: la columna dejó de ser un badge suelto.

function blockReasonLabel(r: string): string {
  switch (r) {
    case 'sku_missing': return 'sin SKU';
    case 'sku_duplicated': return 'SKU duplicado';
    case 'name_missing': return 'sin nombre';
    case 'currency_not_pyg': return 'la moneda no es PYG';
    case 'price_invalid': return 'precio inválido';
    case 'image_not_https': return 'sin imagen HTTPS';
    case 'name_conflict_requires_confirmation': return 'coincide por nombre con un item de Meta (requiere confirmación)';
    case 'retailer_id_duplicated': return 'dos productos reclaman el mismo artículo de Meta';
    case 'identity_too_long': return 'el identificador supera los 100 caracteres que admite Meta';
    case 'description_missing': return 'sin descripción';
    case 'brand_missing': return 'sin marca';
    case 'product_url_missing': return 'sin enlace al producto';
    case 'product_url_not_https': return 'el enlace al producto no es HTTPS';
    case 'no_writable_change': return 'no hay cambios publicables';
    // (ADR-0015) No es un defecto del producto: esos campos los publica otro sistema, así que
    // corregirlos acá no cambiaría nada en Meta. Se corrigen en el origen.
    case 'externally_owned': return 'estos campos los administra otra fuente (no los escribimos)';
    case 'serialization_failed': return 'los datos del producto no entran en el formato de Meta';
    default: return r;
  }
}

function SyncChip({ label, n, tone }: { label: string; n: number; tone: 'mint' | 'amber' | 'coral' | 'ink' }) {
  const tones: Record<string, string> = {
    mint: 'bg-mint-50 text-mint-700',
    amber: 'bg-amber-50 text-amber-700',
    coral: 'bg-coral-50 text-coral-600',
    ink: 'bg-ink-50 text-ink-500',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${n > 0 ? tones[tone] : 'bg-ink-50 text-ink-500'}`}>
      {label}: {n}
    </span>
  );
}
