'use client';

/**
 * CatalogAuthoritySelector — «Quién administra tu catálogo» (ADR-0022).
 *
 * El owner elige entre las combinaciones válidas en criollo: «Lo administro en VendeYaPy»
 * (solo para el bot, o también publicando en Meta), «Lo administro en Meta» y «Lo publica
 * otro sistema». Todo cambio pasa por PREVIEW → confirmación → APPLY atado a la evidencia
 * (runId + planHash con TTL): jamás un switch directo.
 *
 * HONESTIDAD:
 *  - la opción vigente se marca y se dice si fue ELEGIDA o DERIVADA de la config legacy;
 *  - los bloqueos del preview se traducen (ids cerrados) y los requisitos de conexión
 *    llevan a Integración Meta — sin botones falsos;
 *  - «Lo publica otro sistema» muestra la fuente reconocida si existe; si no, dice que el
 *    conector directo llega en el próximo programa (sin campo de URL de mentira);
 *  - frescura (§5): con relación espejo se muestra la última lectura real y su antigüedad
 *    (advertencia si pasaron más de 48 h) — nunca «verificado» sin timestamp.
 *
 * ROLES (§6): OWNER/PLATFORM_ADMIN configuran; MANAGER ve todo en solo lectura;
 * SELLER/VIEWER no ven esta sección. El backend restringe igual (fail-closed).
 */

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth-context';
import { fetchCatalogOwnershipStatus, type CatalogOwnershipStatus } from '@/lib/catalog';
import { etiquetaMotivo, etiquetaTipoFuente } from '@/lib/catalogOwnership';
import {
  applyCatalogAuthority,
  antiguedadLegible,
  bloqueoLlevaAIntegraciones,
  consecuenciasDe,
  esPreviewInvalidado,
  esSalidaDeManaged,
  etiquetaBloqueo,
  etiquetaCombo,
  etiquetaKindApply,
  fetchCatalogAuthorityPreview,
  frescuraEspejo,
  kindDeError,
  tiempoRestanteTexto,
  type AuthorityPreviewView,
  type AuthorityTarget,
} from '@/lib/catalogAuthority';
import { ConfirmModal } from '@/components/ui';

/** Cambiar el modo es una acción de dueño (el backend lo restringe igual). */
const ROLES_CONFIGURAN = new Set(['TENANT_OWNER', 'PLATFORM_ADMIN']);
/** MANAGER ve el estado en solo lectura (ADR-0022 §6). SELLER/VIEWER no ven la sección. */
const ROLES_VEN = new Set(['TENANT_OWNER', 'PLATFORM_ADMIN', 'TENANT_MANAGER']);

/** Palabra exigida para abandonar la publicación activa (patrón MetaDisconnectModal). */
const PALABRA_CONFIRMACION = 'CAMBIAR';

interface Opcion {
  id: string;
  target: AuthorityTarget;
  titulo: string;
  detalle: string;
  /** Agrupa los dos sub-modos de VendeYaPy bajo un mismo encabezado. */
  grupo: 'vendeyapy' | 'meta' | 'external';
}

const OPCIONES: Opcion[] = [
  {
    id: 'vyp-bot',
    target: { authority: 'vendeyapy', relationship: 'none' },
    grupo: 'vendeyapy',
    titulo: 'Solo usarlo para el bot',
    detalle: 'Tus productos viven acá y el bot vende con ellos. No se lee ni se escribe nada en Meta.',
  },
  {
    id: 'vyp-meta',
    target: { authority: 'vendeyapy', relationship: 'managed' },
    grupo: 'vendeyapy',
    titulo: 'También publicar en Meta',
    detalle: 'Lo que cargás acá se puede enviar al catálogo de Meta, siempre con previsualización y confirmación.',
  },
  {
    id: 'meta',
    target: { authority: 'meta', relationship: 'mirror' },
    grupo: 'meta',
    titulo: 'Lo administro en Meta',
    // Honesto (hallazgo B5): la importación es MANUAL del dueño — no hay traída automática.
    detalle:
      'Cargás el catálogo en Meta y lo importás acá cuando quieras, para que el bot venda con él. Acá no se escribe nada hacia Meta.',
  },
  {
    id: 'externo',
    target: { authority: 'external', relationship: 'mirror' },
    grupo: 'external',
    titulo: 'Lo publica otro sistema',
    detalle:
      'Tu sitio o tu sistema de gestión publica el catálogo en Meta. VendeYaPy lo lee y te avisa; no escribe nada allá.',
  },
];

const mismoTarget = (a: AuthorityTarget | null, b: AuthorityTarget | null): boolean =>
  !!a && !!b && a.authority === b.authority && a.relationship === b.relationship;

export function CatalogAuthoritySelector({ tenantId }: { tenantId: string }) {
  const uid = useId();
  const qc = useQueryClient();
  const { claims } = useAuth();
  const rol = claims.role;
  const puedeVer = !!rol && ROLES_VEN.has(rol);
  const puedeConfigurar = !!rol && ROLES_CONFIGURAN.has(rol);

  const [seleccion, setSeleccion] = useState<AuthorityTarget | null>(null);
  const [preview, setPreview] = useState<AuthorityPreviewView | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [palabra, setPalabra] = useState('');
  const [resultado, setResultado] = useState<string | null>(null);
  const [errorApply, setErrorApply] = useState<string | null>(null);
  const [ahora, setAhora] = useState(() => Date.now());

  // Misma queryKey que la tarjeta de propiedad: react-query deduplica en UNA llamada.
  const ownQ = useQuery({
    queryKey: ['catalogOwnership', tenantId],
    queryFn: () => fetchCatalogOwnershipStatus(tenantId),
    enabled: !!tenantId && puedeVer,
    retry: false,
  });

  const previewMut = useMutation({
    mutationFn: (target: AuthorityTarget) => fetchCatalogAuthorityPreview(tenantId, target),
    onSuccess: (p) => {
      setPreview(p);
      setResultado(null);
      setErrorApply(null);
      setAhora(Date.now());
    },
  });

  const applyMut = useMutation({
    mutationFn: (v: { runId: string; planHash: string }) => applyCatalogAuthority(tenantId, v.runId, v.planHash),
    onSuccess: (r) => {
      const quedo = r.despues ?? seleccion;
      setConfirmando(false);
      setPalabra('');
      setSeleccion(null);
      setPreview(null);
      setErrorApply(null);
      setResultado(quedo ? `Listo. Ahora: ${etiquetaCombo(quedo.authority, quedo.relationship)}.` : 'Listo. El modo quedó actualizado.');
      // El estado vigente se relee del servidor: nada se pinta de memoria.
      qc.invalidateQueries({ queryKey: ['catalogOwnership', tenantId] });
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
    },
    onError: (e) => {
      const kind = kindDeError(e);
      setConfirmando(false);
      setPalabra('');
      setErrorApply(etiquetaKindApply(kind));
      // Evidencia inválida (vencida/consumida/desactualizada): el plan mostrado ya no es
      // aplicable — se limpia para forzar una previsualización fresca.
      if (esPreviewInvalidado(kind)) setPreview(null);
    },
  });

  // Countdown del vencimiento del preview: el botón de confirmar no puede prometer un
  // apply que el backend va a rechazar por TTL.
  const venceEn = preview?.venceEn?.getTime() ?? null;
  useEffect(() => {
    if (venceEn == null) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [venceEn]);

  if (!puedeVer) return null;

  const titulo = (
    <h2 id={`${uid}-titulo`} className="text-sm font-semibold text-ink-900">
      Quién administra tu catálogo
    </h2>
  );

  if (ownQ.isLoading) {
    return (
      <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
        {titulo}
        <div role="status" aria-live="polite" className="mt-2">
          <span className="sr-only">Leyendo quién administra tu catálogo…</span>
          <div className="h-6 w-2/3 animate-pulse rounded-lg bg-ink-50" />
        </div>
      </section>
    );
  }

  // El error de esta consulta ya lo anuncia la tarjeta de propiedad con role="alert" (misma
  // query). Acá se repite como status con reintento para no duplicar alertas en la página.
  if (ownQ.isError || !ownQ.data) {
    return (
      <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
        {titulo}
        <div role="status" className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-ink-50/60 px-3 py-2 text-sm text-ink-700">
          <span>No pudimos leer quién administra tu catálogo. Hasta poder leerlo, el modo no se puede cambiar.</span>
          <button
            onClick={() => ownQ.refetch()}
            className="rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs font-semibold text-ink-700 transition-colors hover:bg-ink-50"
          >
            Reintentar
          </button>
        </div>
      </section>
    );
  }

  const own: CatalogOwnershipStatus = ownQ.data;
  const actual = own.autoridad;

  // Contrato viejo sin el eje de autoridad: se dice y NO se ofrece cambiar nada (fail-closed).
  if (!actual) {
    return (
      <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
        {titulo}
        <p className="mt-2 text-sm text-ink-600">
          Tu configuración todavía no informa quién administra el catálogo (la plataforma está actualizando este dato).
          Hasta entonces, el modo no se puede cambiar desde acá y todo sigue funcionando como hasta ahora.
        </p>
      </section>
    );
  }

  const actualTarget: AuthorityTarget = { authority: actual.autoridad, relationship: actual.relacion };
  const elegido = seleccion ?? actualTarget;
  const hayCambio = !!seleccion && !mismoTarget(seleccion, actualTarget);
  const fuenteReconocida = own.fuentes.find((f) => f.reconocida) ?? null;
  const frescura = frescuraEspejo(actual, ahora);
  const msRestantes = preview?.venceEn ? preview.venceEn.getTime() - ahora : null;
  const previewVencido = msRestantes != null && msRestantes <= 0;
  const salidaFuerte = !!seleccion && esSalidaDeManaged(actual, seleccion);

  const elegirOpcion = (target: AuthorityTarget) => {
    setSeleccion(target);
    setPreview(null);
    setResultado(null);
    setErrorApply(null);
    previewMut.reset();
  };

  const opcion = (o: Opcion) => {
    const esActual = mismoTarget(o.target, actualTarget);
    const marcada = mismoTarget(o.target, elegido);
    return (
      <label
        key={o.id}
        className={
          'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ' +
          (marcada ? 'border-mint-300 bg-mint-50/40' : 'border-ink-100 hover:bg-ink-50/40')
        }
      >
        <input
          type="radio"
          name={`${uid}-autoridad`}
          checked={marcada}
          onChange={() => elegirOpcion(o.target)}
          disabled={previewMut.isPending || applyMut.isPending}
          className="mt-0.5 h-4 w-4 border-ink-300 text-mint-600 focus:ring-mint-500"
          aria-label={o.titulo}
        />
        <span className="min-w-0 text-sm">
          <span className="flex flex-wrap items-center gap-2 font-medium text-ink-900">
            {o.titulo}
            {esActual && (
              <span className="inline-flex rounded-full bg-mint-50 px-2 py-0.5 text-[11px] font-semibold text-mint-700">
                Modo actual
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-ink-600">{o.detalle}</span>
          {/* Honestidad del conector externo: fuente reconocida si la hay; si no, la verdad
              sobre el conector futuro — sin botón falso ni campo de URL. */}
          {o.grupo === 'external' &&
            (fuenteReconocida ? (
              <span className="mt-1 block text-xs text-ink-700">
                Fuente reconocida: <span className="font-medium">{fuenteReconocida.nombre || etiquetaTipoFuente(fuenteReconocida.kind)}</span>
                {' '}({etiquetaTipoFuente(fuenteReconocida.kind)}).
              </span>
            ) : (
              <span className="mt-1 block text-xs text-ink-500">
                Todavía no hay una fuente externa reconocida. La conexión directa con tu página se habilita con el
                conector correspondiente (próximo programa).
              </span>
            ))}
        </span>
      </label>
    );
  };

  return (
    <section aria-labelledby={`${uid}-titulo`} className="space-y-3 rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
      {titulo}

      {/* Estado ACTUAL, con su origen (elegido o derivado) dicho sin vueltas. */}
      <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-3 text-sm">
        <p className="text-ink-900">
          Hoy: <span className="font-semibold">{etiquetaCombo(actual.autoridad, actual.relacion)}</span>.
        </p>
        <p className="mt-0.5 text-xs text-ink-600">
          {actual.declarada
            ? 'Este modo lo eligió tu empresa.'
            : 'Este modo está derivado de tu configuración actual: todavía nadie lo eligió acá.'}
        </p>
        {actual.motivos.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
            {actual.motivos.map((m) => (
              <li key={m}>• {etiquetaMotivo(m)}</li>
            ))}
          </ul>
        )}

        {/* Frescura (§5): SOLO para relación espejo, y jamás «verificado» sin fecha real. */}
        {actual.relacion === 'mirror' && (
          <div className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-600">
            {frescura.ultima == null ? (
              <p className="text-amber-800">
                Todavía no leímos la fuente que publica tu catálogo: no podemos afirmar que el espejo esté al día.
              </p>
            ) : (
              <>
                <ul className="space-y-0.5">
                  {actual.frescura.fuenteLeidaEn && (
                    <li>Última lectura de la fuente: {antiguedadLegible(actual.frescura.fuenteLeidaEn, ahora)}.</li>
                  )}
                  {actual.frescura.verificadoEn && (
                    <li>Última verificación contra lo publicado: {antiguedadLegible(actual.frescura.verificadoEn, ahora)}.</li>
                  )}
                  {actual.frescura.importadoEn && (
                    <li>Última importación terminada: {antiguedadLegible(actual.frescura.importadoEn, ahora)}.</li>
                  )}
                </ul>
                {frescura.vieja && (
                  <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 font-medium text-amber-800">
                    El espejo local está viejo: la última lectura fue {antiguedadLegible(frescura.ultima, ahora)}. Los
                    precios y el stock que ve el bot pueden no coincidir con lo publicado.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Resultado del apply (aria-live: el lector lo anuncia sin robar el foco). */}
      <div role="status" aria-live="polite">
        {resultado && (
          <p className="rounded-lg border border-mint-200 bg-mint-50 px-3 py-2 text-sm text-mint-700">{resultado}</p>
        )}
      </div>
      {errorApply && (
        <p role="alert" className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
          {errorApply}
        </p>
      )}

      {!puedeConfigurar ? (
        <p className="text-xs text-ink-500">
          Solo el dueño de la empresa (o un administrador de la plataforma) puede cambiar este modo.
        </p>
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">
              Elegí quién lo administra
            </legend>
            <p className="text-xs font-semibold text-ink-700">Lo administro en VendeYaPy</p>
            <div className="space-y-2 sm:ml-3">
              {OPCIONES.filter((o) => o.grupo === 'vendeyapy').map(opcion)}
            </div>
            {OPCIONES.filter((o) => o.grupo !== 'vendeyapy').map(opcion)}
          </fieldset>

          {hayCambio && !preview && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => seleccion && previewMut.mutate(seleccion)}
                disabled={previewMut.isPending}
                className="rounded-lg bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
              >
                {previewMut.isPending ? 'Revisando…' : 'Revisar el cambio'}
              </button>
              <button
                onClick={() => elegirOpcion(actualTarget)}
                disabled={previewMut.isPending}
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
              >
                Dejar como está
              </button>
              <span className="text-xs text-ink-500">Nada cambia hasta que revises y confirmes.</span>
            </div>
          )}

          {previewMut.isError && (
            <p role="alert" className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
              No se pudo revisar el cambio: {mensajeDeError(previewMut.error)}
            </p>
          )}

          {preview && seleccion && hayCambio && (
            <div className="space-y-2 rounded-xl border border-ink-100 p-3 text-sm">
              <h3 className="font-semibold text-ink-900">
                De «{etiquetaCombo(actualTarget.authority, actualTarget.relationship)}» a «
                {etiquetaCombo(seleccion.authority, seleccion.relationship)}»
              </h3>
              {preview.resumen && <p className="text-ink-700">{preview.resumen}</p>}
              <ul className="space-y-0.5 text-xs text-ink-700">
                {consecuenciasDe(actual, seleccion).map((c) => (
                  <li key={c}>• {c}</li>
                ))}
              </ul>

              {preview.advertencias.length > 0 && (
                <ul className="space-y-0.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800">
                  {preview.advertencias.map((a) => (
                    <li key={a}>• {a}</li>
                  ))}
                </ul>
              )}

              {preview.bloqueos.length > 0 ? (
                <div className="rounded-lg border border-coral-200 bg-coral-50/60 px-3 py-2 text-coral-800">
                  <p className="text-sm font-semibold">Todavía no se puede aplicar este cambio:</p>
                  <ul className="mt-1 space-y-1 text-xs">
                    {preview.bloqueos.map((b) => (
                      <li key={b.id}>
                        • {etiquetaBloqueo(b.id)}
                        {b.detalle ? ` (${b.detalle})` : ''}
                        {bloqueoLlevaAIntegraciones(b.id) && (
                          <>
                            {' '}
                            <Link href="/integrations" className="font-semibold underline underline-offset-2">
                              Ir a Integración Meta
                            </Link>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : preview.planHash && preview.runId ? (
                previewVencido ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs text-amber-800">El preview venció, generá uno nuevo.</p>
                    <button
                      onClick={() => previewMut.mutate(seleccion)}
                      disabled={previewMut.isPending}
                      className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60"
                    >
                      Revisar de nuevo
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3 border-t border-ink-100 pt-2">
                    {(preview.estadoEsperado || preview.estadoEsperadoTexto) && (
                      <span className="text-xs text-ink-600">
                        Va a quedar:{' '}
                        <span className="font-medium">
                          {preview.estadoEsperado
                            ? etiquetaCombo(preview.estadoEsperado.authority, preview.estadoEsperado.relationship)
                            : preview.estadoEsperadoTexto}
                        </span>
                        .
                      </span>
                    )}
                    <button
                      onClick={() => setConfirmando(true)}
                      disabled={applyMut.isPending}
                      className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                    >
                      Confirmar el cambio…
                    </button>
                    {msRestantes != null && (
                      <span className="text-xs text-ink-500">
                        Podés confirmarlo durante {tiempoRestanteTexto(msRestantes)}; después hay que revisar de nuevo.
                      </span>
                    )}
                  </div>
                )
              ) : (
                <p className="text-xs text-ink-500">
                  Esta revisión no es utilizable para confirmar. Generá una nueva con «Revisar el cambio».
                </p>
              )}
            </div>
          )}
        </>
      )}

      {confirmando && seleccion && preview?.planHash && preview.runId && (
        <ConfirmModal
          title="¿Cambiar quién administra el catálogo?"
          confirmLabel="Sí, cambiar"
          cancelLabel="Cancelar"
          danger={salidaFuerte}
          pending={applyMut.isPending}
          confirmDisabled={salidaFuerte && palabra !== PALABRA_CONFIRMACION}
          onConfirm={() => {
            if (applyMut.isPending) return;
            if (salidaFuerte && palabra !== PALABRA_CONFIRMACION) return;
            applyMut.mutate({ runId: preview.runId!, planHash: preview.planHash! });
          }}
          onCancel={() => {
            if (applyMut.isPending) return;
            setConfirmando(false);
            setPalabra('');
          }}
        >
          <p>
            De «{etiquetaCombo(actualTarget.authority, actualTarget.relationship)}» a «
            {etiquetaCombo(seleccion.authority, seleccion.relationship)}».
          </p>
          {salidaFuerte && (
            <>
              <p className="mt-2">
                <strong>VendeYaPy va a dejar de publicar en Meta.</strong> Tus productos, los vínculos y la conexión no
                se tocan; podés volver a este modo con otra revisión.
              </p>
              <label htmlFor={`${uid}-palabra`} className="mt-4 block text-xs font-semibold text-ink-700">
                Escribí {PALABRA_CONFIRMACION} para confirmar
              </label>
              <input
                id={`${uid}-palabra`}
                type="text"
                value={palabra}
                onChange={(e) => setPalabra(e.target.value)}
                disabled={applyMut.isPending}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder={PALABRA_CONFIRMACION}
                className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm tracking-wide text-ink-900 focus:border-coral-500 focus:outline-none focus:ring-2 focus:ring-coral-500/30 disabled:opacity-60"
              />
            </>
          )}
        </ConfirmModal>
      )}
    </section>
  );
}

/** Mensaje legible de un error de callable (HttpsError trae `message` claro). */
function mensajeDeError(e: unknown): string {
  const m = (e as { message?: string } | null)?.message;
  return m && m.trim() ? m : 'No se pudo completar la operación. Revisá tus permisos o tu conexión.';
}
