'use client';

/**
 * MetaCatalogImport — Importación paginada y reanudable del catálogo de Meta
 * (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1).
 *
 * El panel invoca `metaCatalogImportRun` en bucle mientras el backend devuelva `more: true`,
 * mostrando el avance real (páginas, contadores). Si una invocación se corta o falla, el run
 * queda persistido en el servidor y acá aparece "Reanudar" (resume: true) — nunca se pierde
 * el progreso ni se duplican productos (idempotencia por artículo, server-side).
 *
 * NO escribe nada en Meta: solo crea productos locales INACTIVOS para revisar y completar.
 * Solo dueño (el backend lo restringe igual con resolveOwnerAuth).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Category } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import {
  fetchMetaCatalogImportStatus,
  runMetaCatalogImport,
  type MetaCatalogImportRunState,
} from '@/lib/catalog';
import { correrImportacionPaginada, errTextImport } from '@/lib/metaImportLoop';
import { ConfirmModal, StatusBadge, type BadgeTone } from '@/components/ui';

/** Importar TODO el catálogo es una acción de dueño (mismo gate que la reconciliación). */
const ROLES_IMPORTACION = new Set(['TENANT_OWNER', 'PLATFORM_ADMIN']);

type Fase = 'idle' | 'corriendo' | 'completado' | 'fallado' | 'cortado' | 'ocupado' | 'tomado';

const CONTADORES: Array<{ key: keyof MetaCatalogImportRunState['contadores']; label: string; tone: BadgeTone }> = [
  { key: 'imported', label: 'Importados', tone: 'mint' },
  { key: 'alreadyLinked', label: 'Ya vinculados', tone: 'ink' },
  { key: 'alreadyImported', label: 'Ya importados antes', tone: 'ink' },
  { key: 'ambiguous', label: 'Para decidir vos', tone: 'amber' },
  { key: 'conflicted', label: 'Con conflicto', tone: 'coral' },
  { key: 'skipped', label: 'Omitidos', tone: 'amber' },
  { key: 'unclassified', label: 'Sin clasificar', tone: 'amber' },
];

export function MetaCatalogImport({ tenantId, categories }: { tenantId: string; categories: Category[] }) {
  const uid = useId();
  const qc = useQueryClient();
  const { claims } = useAuth();
  const puedeImportar = !!claims.role && ROLES_IMPORTACION.has(claims.role);

  const [fase, setFase] = useState<Fase>('idle');
  const [ultimo, setUltimo] = useState<MetaCatalogImportRunState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [categoria, setCategoria] = useState(''); // '' = importar sin clasificar
  const [confirmar, setConfirmar] = useState(false);
  const [consultandoEstado, setConsultandoEstado] = useState(false);
  // Guardas del bucle: no arrancar dos veces y no seguir tras desmontar.
  const corriendoRef = useRef(false);
  const montadoRef = useRef(true);
  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
    };
  }, []);

  // Al entrar: si quedó un run sin terminar (corte anterior), ofrecer reanudarlo.
  const statusQ = useQuery({
    queryKey: ['metaImportStatus', tenantId],
    queryFn: () => fetchMetaCatalogImportStatus(tenantId),
    enabled: puedeImportar && !!tenantId,
    retry: false,
  });
  const runPendiente =
    fase === 'idle' && (statusQ.data?.run?.status === 'running' || statusQ.data?.run?.status === 'failed')
      ? statusQ.data.run
      : null;

  const refrescarDatos = () => {
    qc.invalidateQueries({ queryKey: ['products', tenantId] });
    qc.invalidateQueries({ queryKey: ['catalogQuality', tenantId] });
    qc.invalidateQueries({ queryKey: ['metaReconcile', tenantId] });
    qc.invalidateQueries({ queryKey: ['metaImportStatus', tenantId] });
  };

  /**
   * Bucle de importación: la POLÍTICA (cuándo re-invocar, cuándo cortar y con qué mensaje)
   * vive en `correrImportacionPaginada` (lib/metaImportLoop.ts, pura y testeada); acá solo
   * se traduce el desenlace a estado de UI.
   */
  const correr = async (reanudar: boolean) => {
    if (corriendoRef.current) return;
    corriendoRef.current = true;
    setFase('corriendo');
    setErrorMsg(null);
    const out = await correrImportacionPaginada(reanudar, {
      invocar: ({ resume }) =>
        runMetaCatalogImport(tenantId, {
          resume,
          ...(categoria ? { defaultCategoryId: categoria } : {}),
        }),
      onAvance: (r) => setUltimo(r),
      montado: () => montadoRef.current,
    });
    corriendoRef.current = false;
    if (out.fase === 'abortado') return; // desmontado a mitad: no tocar más estado
    setFase(out.fase);
    setErrorMsg(out.errorMsg);
    if (out.fase === 'completado') refrescarDatos();
  };

  /** Consulta el estado del run cuando otra sesión lo tiene tomado (already_running). */
  const actualizarEstado = async () => {
    setConsultandoEstado(true);
    try {
      const { run } = await fetchMetaCatalogImportStatus(tenantId);
      if (!montadoRef.current) return;
      if (run) setUltimo(run);
      if (run?.status === 'completed') {
        setFase('completado');
        refrescarDatos();
      } else if (run?.status === 'failed') {
        setFase('fallado');
      }
    } catch (e) {
      if (montadoRef.current) setErrorMsg(errTextImport(e));
    } finally {
      if (montadoRef.current) setConsultandoEstado(false);
    }
  };

  if (!puedeImportar) return null;

  const ocupado = fase === 'corriendo';

  return (
    <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={`${uid}-titulo`} className="text-sm font-semibold text-ink-900">Importar catálogo de Meta</h2>
          <p className="mt-0.5 text-sm text-ink-500">
            Trae TODOS los artículos de tu catálogo de Meta como productos <strong>inactivos</strong> para que los
            revises. No cambia nada en Meta y se puede retomar si se corta.
          </p>
        </div>
      </div>

      {/* Aviso de un run interrumpido en una sesión anterior */}
      {runPendiente && (
        <div role="status" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>
            {runPendiente.status === 'failed'
              ? 'La última importación quedó con un error a mitad de camino.'
              : 'Quedó una importación sin terminar.'}{' '}
            Va por la página {runPendiente.pagesDone} ({runPendiente.procesados} artículos revisados).
          </span>
          <button
            onClick={() => correr(true)}
            className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700"
          >
            Reanudar
          </button>
        </div>
      )}

      {/* Controles: categoría por defecto + arrancar */}
      {fase !== 'corriendo' && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={`${uid}-cat`} className="mb-1 block text-xs font-medium text-ink-600">
              Categoría para los importados
            </label>
            <select
              id={`${uid}-cat`}
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
            >
              <option value="">Importar sin clasificar (elegís después)</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => setConfirmar(true)}
            disabled={ocupado}
            className="rounded-lg bg-mint-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-50"
          >
            {fase === 'completado' ? 'Importar de nuevo' : 'Importar catálogo de Meta'}
          </button>
        </div>
      )}

      {/* Avance y resultado (aria-live: el lector anuncia el progreso sin robar el foco) */}
      {(ultimo || ocupado || errorMsg) && (
        <div role="status" aria-live="polite" className="mt-3 space-y-2">
          {ocupado && (
            <p className="text-sm text-ink-700">
              Importando… {ultimo ? `páginas procesadas: ${ultimo.pagesDone} · artículos revisados: ${ultimo.procesados}` : 'arrancando.'}
            </p>
          )}
          {fase === 'completado' && ultimo && (
            <p className="rounded-lg bg-mint-50 px-3 py-2 text-sm text-mint-700">
              Importación terminada: {ultimo.procesados} artículos revisados en {ultimo.pagesDone} páginas. Los
              importados quedaron <strong>inactivos</strong>: completá sus datos y activalos cuando estén listos.
            </p>
          )}
          {fase === 'tomado' && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <span>
                Otro proceso tomó el control de esta importación (quizás otra pestaña u otra persona). El run sigue su
                curso allá; estos números muestran lo último visto desde acá.
              </span>
              <button
                onClick={actualizarEstado}
                disabled={consultandoEstado}
                className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-50 disabled:opacity-50"
              >
                {consultandoEstado ? 'Consultando…' : 'Actualizar estado'}
              </button>
            </div>
          )}
          {fase === 'ocupado' && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <span>
                Ya hay una importación corriendo (quizás en otra pestaña u otra persona). Estos números muestran su avance.
              </span>
              <button
                onClick={actualizarEstado}
                disabled={consultandoEstado}
                className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-50 disabled:opacity-50"
              >
                {consultandoEstado ? 'Consultando…' : 'Actualizar estado'}
              </button>
              <button
                onClick={() => correr(true)}
                className="rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
              >
                Reanudar acá
              </button>
            </div>
          )}
          {(fase === 'fallado' || fase === 'cortado') && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
              <span>
                {fase === 'fallado'
                  ? `La importación se detuvo con un error${ultimo?.lastError ? `: ${ultimo.lastError}` : '.'}`
                  : errorMsg ?? 'La importación se cortó.'}{' '}
                Lo avanzado quedó guardado: al reanudar sigue desde donde quedó, sin duplicar.
              </span>
              <button
                onClick={() => correr(true)}
                className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700"
              >
                Reanudar
              </button>
            </div>
          )}
          {ultimo && (
            <div className="flex flex-wrap gap-2 text-xs">
              {CONTADORES.map(({ key, label, tone }) => {
                const n = ultimo.contadores?.[key] ?? 0;
                return (
                  <StatusBadge key={key} tone={n > 0 ? tone : 'ink'} className={n === 0 ? 'text-ink-500' : undefined}>
                    {label}: {n}
                  </StatusBadge>
                );
              })}
            </div>
          )}
          {ultimo && ultimo.cursorResets > 0 && (
            <p className="text-xs text-ink-500">
              La lectura del catálogo se reinició {ultimo.cursorResets} {ultimo.cursorResets === 1 ? 'vez' : 'veces'} (pasa
              con catálogos grandes). No genera duplicados: los artículos ya importados se saltean.
            </p>
          )}
        </div>
      )}

      {confirmar && (
        <ConfirmModal
          title="¿Importar todo el catálogo de Meta?"
          confirmLabel="Sí, importar"
          onCancel={() => setConfirmar(false)}
          onConfirm={() => {
            setConfirmar(false);
            void correr(false);
          }}
        >
          <ul className="space-y-1">
            <li>• Se crean como productos <strong>inactivos</strong>: el bot no los ofrece hasta que los actives.</li>
            <li>• Se importan nombre, precio, marca, descripción e imagen. El costo y el stock los cargás vos.</li>
            <li>
              • Categoría: <strong>{categoria ? categories.find((c) => c.id === categoria)?.name ?? categoria : 'sin clasificar (los ordenás después)'}</strong>.
            </li>
            <li>• Los repetidos, los ya vinculados y los que necesitan tu decisión se saltean y se informan.</li>
            <li>• <strong>No se modifica nada en Meta.</strong> Se puede retomar si se corta.</li>
          </ul>
        </ConfirmModal>
      )}
    </section>
  );
}
