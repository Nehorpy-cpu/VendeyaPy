'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetaConnectionStatus } from '@vpw/shared';
import { StatusBadge } from '@/components/ui';
import { getMyWhatsappRequest, requestWhatsappActivation, cancelWhatsappActivation, friendlyWhatsappError, deriveAssistedState } from '@/lib/whatsapp-activation';

/**
 * Activación ASISTIDA de WhatsApp para el owner (WM-2). Se muestra cuando el Embedded Signup de Meta
 * no está configurado para la plataforma: el owner pide ayuda y el equipo configura su WhatsApp Business.
 * NO promete "conectar en un clic" ni muestra campos técnicos/tokens: solo solicita y muestra el estado.
 * La activación REAL (respuestas live) sigue siendo exclusiva de channelConfigUpdate (no se toca acá).
 */
const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';
const field = 'w-full rounded-xl border border-ink-200 px-3 py-2 text-sm focus:border-mint-400 focus:outline-none';

type Feedback = { kind: 'ok' | 'info' | 'error'; msg: string };
const FEEDBACK_CLS: Record<Feedback['kind'], string> = {
  ok: 'bg-mint-50 text-mint-700 ring-mint-100',
  info: 'bg-ink-50 text-ink-600 ring-ink-100',
  error: 'bg-coral-50 text-coral-700 ring-coral-100',
};

export function WhatsappAssistedActivation({
  tenantId,
  canOperate,
  connStatus,
}: {
  tenantId: string;
  canOperate: boolean;
  connStatus: MetaConnectionStatus | null;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const reqQ = useQuery({
    queryKey: ['whatsappActivationRequest', tenantId],
    queryFn: () => getMyWhatsappRequest(tenantId),
    enabled: !!tenantId,
  });
  const request = reqQ.data ?? null;
  const state = deriveAssistedState(connStatus, request?.status);
  const isPending = state === 'pending';

  const requestMut = useMutation({
    mutationFn: () => requestWhatsappActivation({ note: note.trim() || undefined, contactPhone: contactPhone.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whatsappActivationRequest', tenantId] });
      setNote('');
      setContactPhone('');
      setFeedback({ kind: 'ok', msg: 'Solicitud enviada. Un especialista configura tu WhatsApp Business y te avisamos cuando esté listo.' });
    },
    onError: (e) => setFeedback({ kind: 'error', msg: friendlyWhatsappError(e) }),
  });

  const cancelMut = useMutation({
    mutationFn: () => cancelWhatsappActivation({ requestId: request!.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whatsappActivationRequest', tenantId] });
      setFeedback({ kind: 'info', msg: 'Solicitud cancelada.' });
    },
    onError: (e) => setFeedback({ kind: 'error', msg: friendlyWhatsappError(e) }),
  });

  const connected = state === 'connected';
  const needsReview = state === 'needs_review';
  const busy = requestMut.isPending || cancelMut.isPending;

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold text-ink-900">Activación asistida de WhatsApp</span>
          {connected ? (
            <StatusBadge tone="mint">Conectado</StatusBadge>
          ) : needsReview ? (
            <StatusBadge tone="amber">En revisión</StatusBadge>
          ) : isPending ? (
            <StatusBadge tone="ink">Solicitud enviada</StatusBadge>
          ) : (
            <StatusBadge tone="ink">Sin solicitud</StatusBadge>
          )}
        </div>
      </div>

      {feedback && (
        <div className={'mt-3 rounded-xl px-4 py-2.5 text-sm ring-1 ring-inset ' + FEEDBACK_CLS[feedback.kind]}>{feedback.msg}</div>
      )}

      {/* Conectado: nada que solicitar. */}
      {connected ? (
        <p className="mt-3 text-sm text-ink-600">Tu WhatsApp Business ya está conectado. Podés activar las respuestas reales más abajo.</p>
      ) : needsReview ? (
        <p className="mt-3 text-sm text-ink-600">
          Nuestro equipo está terminando de configurar tu WhatsApp. Si hace falta algún dato, te contactamos. No necesitás hacer nada más por ahora.
        </p>
      ) : isPending ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-ink-600">
            Recibimos tu solicitud. Un especialista está configurando tu conexión de WhatsApp Business y te vamos a avisar cuando quede lista.
          </p>
          {request?.note && <p className="text-xs text-ink-500">Tu nota: {request.note}</p>}
          {canOperate && (
            <button onClick={() => { setFeedback(null); cancelMut.mutate(); }} disabled={busy} className="text-xs font-semibold text-coral-700 hover:underline disabled:opacity-60">
              {cancelMut.isPending ? 'Cancelando…' : 'Cancelar solicitud'}
            </button>
          )}
        </div>
      ) : (
        // Sin solicitud: CTA para pedir la activación asistida.
        <div className="mt-3 space-y-3">
          <p className="text-sm text-ink-600">
            La conexión automática de Meta todavía no está disponible para tu empresa. Pedí una <strong>activación asistida</strong>:
            nuestro equipo configura tu WhatsApp Business por vos y te avisa cuando esté listo.
          </p>
          {canOperate ? (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="Teléfono de contacto (opcional)"
                  inputMode="tel"
                  className={field}
                />
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Nota para el equipo (opcional)"
                  className={field}
                />
              </div>
              <button
                onClick={() => { setFeedback(null); requestMut.mutate(); }}
                disabled={busy}
                className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
              >
                {requestMut.isPending ? 'Enviando…' : 'Solicitar activación asistida de WhatsApp'}
              </button>
            </>
          ) : (
            <p className="text-xs text-ink-400">Solo el dueño o un administrador pueden solicitar la activación.</p>
          )}
        </div>
      )}
    </div>
  );
}
