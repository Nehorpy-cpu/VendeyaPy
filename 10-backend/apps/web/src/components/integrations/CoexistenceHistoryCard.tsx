'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmModal, StatusBadge } from '@/components/ui';
import {
  coexistenceSyncStatus,
  coexistenceDecideHistorySharing,
  coexistenceRequestHistorySync,
  type CoexistenceSyncStatus,
  type HistorySharingDecision,
} from '@/lib/integrations';

/**
 * El flujo HUMANO del historial de Coexistence (ADR-0017 §5), operable desde el panel.
 *
 * Tres actos, en orden y con el dueño entendiendo cada uno:
 *  1. DECIDIR — compartir o no compartir los chats previos del número. Es sensible (180 días de
 *     conversaciones privadas) y en este ciclo no se cambia con un botón: revertir un «no» exige
 *     reconectar el número.
 *  2. DISPARAR — pedirle a Meta la sincronización. Se puede UNA sola vez y dentro de una ventana
 *     de 24 h desde la conexión; por eso el botón exige confirmación aparte y desaparece apenas
 *     se usa. No existe el reintento ciego: si algo sale mal, el estado lo dice.
 *  3. MIRAR — el progreso y el desenlace, saneados (nunca una conversación, nunca un teléfono).
 *
 * El `phoneNumberId` viene SIEMPRE de los assets del tenant que la página ya listó — nunca de un
 * input — y el backend lo re-verifica contra la conexión propia.
 */
const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';

const BADGE_POR_ESTADO: Record<string, { tone: 'ink' | 'mint' | 'amber' | 'coral'; label: string }> = {
  pending_request: { tone: 'amber', label: 'Listo para traer' },
  requested: { tone: 'ink', label: 'Pedido a Meta' },
  receiving: { tone: 'ink', label: 'Recibiendo' },
  completed: { tone: 'mint', label: 'Completado' },
  declined: { tone: 'ink', label: 'No compartido' },
  expired: { tone: 'coral', label: 'Ventana vencida' },
  failed: { tone: 'coral', label: 'Falló' },
};

/** El desenlace, en el idioma del dueño. Sin jerga, sin códigos crudos, sin datos de clientes. */
function textoTerminal(s: CoexistenceSyncStatus): string | null {
  switch (s.status) {
    case 'completed':
      return 'El historial terminó de sincronizarse. Los chats previos quedaron guardados como archivo: no disparan al asistente ni se mezclan con las conversaciones nuevas.';
    case 'declined':
      return s.declineCode === 2593109
        ? 'El negocio no compartió el historial desde su teléfono. Está todo bien: las conversaciones nuevas llegan igual; solo no se trajeron los chats previos.'
        : 'Se decidió no compartir el historial. Las conversaciones nuevas llegan igual; los chats previos quedan solo en el teléfono.';
    case 'expired':
      return 'La ventana de 24 h se venció sin traer el historial. Ya no se puede pedir para esta conexión: si lo necesitás, hay que desconectar el número desde la app y volver a conectarlo.';
    case 'failed':
      return 'La sincronización no se pudo completar. Los chats previos quedan solo en el teléfono; las conversaciones nuevas no se ven afectadas.';
    default:
      return null;
  }
}

export function CoexistenceHistoryCard({
  tenantId,
  phoneNumberId,
  canOperate,
}: {
  tenantId: string;
  /** SIEMPRE un asset del tenant ya listado por la página — jamás un valor tipeado. */
  phoneNumberId: string;
  canOperate: boolean;
}) {
  const qc = useQueryClient();
  const [confirmando, setConfirmando] = useState<HistorySharingDecision | 'disparo' | null>(null);

  const q = useQuery({
    queryKey: ['coexistenceSyncStatus', tenantId, phoneNumberId],
    queryFn: () => coexistenceSyncStatus(tenantId, phoneNumberId),
    // Mientras está recibiendo, el estado se mueve solo: refrescar es la única forma de verlo.
    refetchInterval: (query) => (query.state.data?.status === 'receiving' || query.state.data?.status === 'requested' ? 15_000 : false),
  });

  const invalidar = () => qc.invalidateQueries({ queryKey: ['coexistenceSyncStatus', tenantId, phoneNumberId] });
  const decidirMut = useMutation({
    mutationFn: (decision: HistorySharingDecision) => coexistenceDecideHistorySharing(tenantId, phoneNumberId, decision),
    onSettled: invalidar,
  });
  const dispararMut = useMutation({
    mutationFn: () => coexistenceRequestHistorySync(tenantId, phoneNumberId),
    onSettled: invalidar,
  });

  const s = q.data;
  // Un número agregado a mano también vive en una conexión wa_*, pero NO tiene historial de la app
  // que pedir: mostrarle esta tarjeta invitaba a quemar el único disparo contra un número que
  // jamás lo tuvo (correctivo, MEDIO 12). El backend además lo rechaza en decide/request.
  if (s && s.coexistence === false) return null;
  const sinDecision = !!s && (!s.exists || s.sharingDecision === null || s.sharingDecision === undefined);
  const puedeDisparar = !!s && s.exists && s.sharingDecision === 'share' && s.status === 'pending_request';
  const badge = s?.exists && s.status ? BADGE_POR_ESTADO[s.status] : null;
  const terminal = s?.exists ? textoTerminal(s) : null;
  const horasRestantes = s?.deadlineAtMs ? Math.max(0, Math.round((s.deadlineAtMs - Date.now()) / 3_600_000)) : null;
  const errorAccionable = (decidirMut.error ?? dispararMut.error) as Error | null;

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold text-ink-900">Historial del número conectado</span>
          {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
        </div>
      </div>

      <p className="mt-3 text-sm text-ink-600">
        Podés traer al panel los chats previos de este número (hasta 180 días) o dejarlos solo en el teléfono.
        Es una decisión sensible: son conversaciones privadas de tus clientes. Se puede pedir{' '}
        <strong>una sola vez</strong> y dentro de una ventana de <strong>24 h</strong> desde la conexión.
      </p>

      {/* El estado del ciclo, para lectores de pantalla también: cambia solo mientras recibe. */}
      <div aria-live="polite" className="mt-4">
        {q.isLoading ? (
          <p className="text-sm text-ink-400" aria-busy="true">Consultando el estado del historial…</p>
        ) : q.isError ? (
          <div className="rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-700">
            No se pudo consultar el estado. Es seguro reintentar la consulta.
            <button onClick={() => q.refetch()} className="ml-2 font-semibold underline">Reintentar</button>
          </div>
        ) : sinDecision ? (
          <p className="rounded-xl bg-ink-50 px-4 py-2.5 text-sm text-ink-700">
            Todavía no decidiste. Si no estás seguro, la opción segura es <strong>no compartir</strong>: las
            conversaciones nuevas llegan igual.
          </p>
        ) : puedeDisparar ? (
          <p className="rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            Decidiste compartir. Falta el último paso: pedirle el historial a Meta.
            {horasRestantes !== null && <> Quedan aproximadamente <strong>{horasRestantes} h</strong> de ventana.</>}
          </p>
        ) : s?.status === 'requested' || s?.status === 'receiving' ? (
          <div className="rounded-xl bg-ink-50 px-4 py-2.5 text-sm text-ink-700">
            <p>
              Meta está mandando el historial{typeof s.progress === 'number' ? <>: <strong>{s.progress}%</strong></> : '…'}
              {typeof s.chunks === 'number' && s.chunks > 0 && <> ({s.chunks} tandas recibidas)</>}
            </p>
            <p className="mt-1 text-xs text-ink-500">Esto sigue solo; no hay que hacer nada. Puede tardar un rato.</p>
          </div>
        ) : terminal ? (
          <p className="rounded-xl bg-ink-50 px-4 py-2.5 text-sm text-ink-700">{terminal}</p>
        ) : null}

        {errorAccionable && (
          <p className="mt-2 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-700">
            {errorAccionable.message || 'La operación no se pudo completar.'}
          </p>
        )}
      </div>

      {canOperate && sinDecision && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={() => setConfirmando('share')}
            disabled={decidirMut.isPending}
            className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
          >
            Compartir historial
          </button>
          <button
            onClick={() => setConfirmando('skip')}
            disabled={decidirMut.isPending}
            className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60"
          >
            No compartir
          </button>
        </div>
      )}

      {canOperate && puedeDisparar && (
        <div className="mt-4">
          <button
            onClick={() => setConfirmando('disparo')}
            disabled={dispararMut.isPending}
            className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
          >
            {dispararMut.isPending ? 'Pidiendo…' : 'Traer el historial ahora'}
          </button>
        </div>
      )}

      {!canOperate && <p className="mt-3 text-xs text-ink-400">Solo el dueño o un administrador pueden decidir sobre el historial.</p>}

      {confirmando === 'share' && (
        <ConfirmModal
          title="Compartir el historial de este número"
          confirmLabel="Confirmar"
          onConfirm={() => { setConfirmando(null); decidirMut.mutate('share'); }}
          onCancel={() => setConfirmando(null)}
        >
          Se van a traer al panel hasta 180 días de conversaciones de este número. Quedan guardadas como
          archivo: el asistente no las usa ni las responde. Después de decidir, vas a tener que tocar
          «Traer el historial ahora» dentro de la ventana de 24 h.
        </ConfirmModal>
      )}
      {confirmando === 'skip' && (
        <ConfirmModal
          title="No compartir el historial"
          confirmLabel="Confirmar"
          onConfirm={() => { setConfirmando(null); decidirMut.mutate('skip'); }}
          onCancel={() => setConfirmando(null)}
        >
          Los chats previos quedan solo en el teléfono. Las conversaciones nuevas llegan al panel igual.
          Esta decisión no se cambia con un botón: para revertirla hay que desconectar el número desde la
          app y volver a conectarlo.
        </ConfirmModal>
      )}
      {confirmando === 'disparo' && (
        <ConfirmModal
          title="Pedir el historial a Meta"
          confirmLabel="Confirmar"
          onConfirm={() => { setConfirmando(null); dispararMut.mutate(); }}
          onCancel={() => setConfirmando(null)}
        >
          Este pedido se puede hacer <strong>una sola vez</strong>. Si algo falla después de pedirlo, no se
          puede repetir: habría que desconectar el número y volver a conectarlo. ¿Lo pedimos ahora?
        </ConfirmModal>
      )}
    </div>
  );
}
