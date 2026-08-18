'use client';

/**
 * Compositor del chat (ADR-0021 §5 + UX normativa).
 *
 * - Texto multilínea con auto-crecimiento; Enter envía, Shift+Enter hace salto.
 * - Emojis Unicode con picker propio (sin dependencias nuevas).
 * - Adjuntar imagen (jpeg/png/webp ≤5 MB) o PDF (≤7 MB): validación client ESPEJO del server,
 *   preview con caption opcional, envío base64 idempotente por `operationId`, error honesto con
 *   reintento que CONSERVA el archivo y el texto.
 * - Deshabilitado coherente: canal sin envío (IG/Messenger), archivada/eliminada (ofrece
 *   restaurar), sin takeover si el rol no tiene override, gate de cotización.
 *
 * El envío de TEXTO vive en la página (conserva los guards HARDEN-1 de envíos en vuelo al
 * cambiar de chat); este componente se monta con `key={customerId}`, así el estado del adjunto
 * jamás se filtra entre conversaciones.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { MessageChannel } from '@vpw/shared';
import type { Role } from '@/lib/auth-context';
import { sendConversationAttachment } from '@/lib/conversations';
import {
  CHANNEL_LABEL,
  canalPermiteEnvio,
  friendlySendAttachmentError,
  puedeEnviarSinTakeover,
  puedeEscribir,
  validateComposerFile,
} from '@/lib/conversationsUi';
import { cn } from '@/lib/cn';
import { EmojiPicker } from './EmojiPicker';

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

interface AttachDraft {
  file: File;
  kind: 'image' | 'document';
  previewUrl: string | null;
  /** Idempotencia: se genera al ELEGIR el archivo y se conserva en los reintentos. */
  operationId: string;
}

function nuevoOperationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'op_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.onload = () => {
      const res = String(reader.result ?? '');
      const coma = res.indexOf(',');
      resolve(coma >= 0 ? res.slice(coma + 1) : res);
    };
    reader.readAsDataURL(file);
  });
}

export function Composer({
  tenantId,
  customerId,
  value,
  onChange,
  textareaRef,
  channel,
  archived,
  softDeleted,
  isHuman,
  role,
  gateActivo,
  gateHelp,
  isMock,
  sending,
  sendError,
  onSubmit,
  canRestore,
  onRestore,
  restorePending,
  onAttachmentSent,
}: {
  tenantId: string;
  customerId: string;
  value: string;
  onChange: (text: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  channel: MessageChannel | undefined;
  archived: boolean;
  softDeleted: boolean;
  isHuman: boolean;
  role: Role | null;
  gateActivo: boolean;
  gateHelp: string | null;
  isMock: boolean;
  sending: boolean;
  sendError: string | null;
  onSubmit: () => void;
  /** ¿El rol puede restaurar ESTE estado? (archivada: staff; eliminada: manager+). */
  canRestore: boolean;
  onRestore: () => void;
  restorePending: boolean;
  onAttachmentSent: (viaMock: boolean) => void;
}) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attach, setAttach] = useState<AttachDraft | null>(null);
  const [caption, setCaption] = useState('');
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // El objectURL del preview se libera al reemplazar el archivo o al desmontar.
  useEffect(() => {
    const url = attach?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [attach?.previewUrl]);

  const attachMut = useMutation({
    mutationFn: async (a: { draft: AttachDraft; caption: string }) => {
      const dataBase64 = await fileToBase64(a.draft.file);
      return sendConversationAttachment({
        tenantId,
        customerId,
        operationId: a.draft.operationId,
        kind: a.draft.kind,
        filename: a.draft.file.name || (a.draft.kind === 'image' ? 'imagen' : 'documento.pdf'),
        mimeType: a.draft.file.type,
        dataBase64,
        ...(a.caption.trim() ? { caption: a.caption.trim() } : {}),
      });
    },
    onSuccess: (r) => {
      setAttach(null);
      setCaption('');
      setAttachError(null);
      onAttachmentSent(!!r.viaMock);
    },
    onError: (e) => {
      // Error honesto CON reintento: el archivo y el caption se conservan tal cual.
      setAttachError(friendlySendAttachmentError(e));
    },
  });

  const elegirArchivo = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const check = validateComposerFile(file);
    if (!check.ok) {
      setAttachError(check.error);
      setAttach(null);
      return;
    }
    setAttachError(null);
    setAttach({
      file,
      kind: check.kind,
      previewUrl: check.kind === 'image' ? URL.createObjectURL(file) : null,
      operationId: nuevoOperationId(),
    });
  };

  const cancelarAdjunto = () => {
    setAttach(null);
    setCaption('');
    setAttachError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const insertarEmoji = (emoji: string) => {
    const el = textareaRef.current;
    if (el && typeof el.selectionStart === 'number') {
      const inicio = el.selectionStart;
      const fin = el.selectionEnd ?? inicio;
      const nuevo = value.slice(0, inicio) + emoji + value.slice(fin);
      onChange(nuevo.slice(0, 4096));
      requestAnimationFrame(() => {
        el.focus();
        const pos = inicio + emoji.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      onChange((value + emoji).slice(0, 4096));
    }
    setEmojiOpen(false);
  };

  const autogrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  // ── Estados que REEMPLAZAN al compositor (en orden de prioridad) ──────────

  if (softDeleted || archived) {
    const rotulo = softDeleted ? 'Esta conversación está eliminada.' : 'Esta conversación está archivada.';
    const aclaracion = softDeleted
      ? 'La eliminación es reversible: los mensajes no se borraron.'
      : 'Un mensaje nuevo del cliente la desarchiva automáticamente.';
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 px-4 py-3 text-xs text-ink-600">
        <span>
          <span className="font-semibold">{rotulo}</span> {aclaracion}
        </span>
        {canRestore ? (
          <button
            type="button"
            onClick={onRestore}
            disabled={restorePending}
            className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
          >
            {restorePending ? 'Restaurando…' : 'Restaurar'}
          </button>
        ) : (
          <span className="text-ink-400">Pedile a un responsable del negocio que la restaure.</span>
        )}
      </div>
    );
  }

  if (!canalPermiteEnvio(channel)) {
    return (
      <div className="border-t border-ink-100 px-4 py-3 text-center text-xs text-ink-500">
        Conversación de {CHANNEL_LABEL[channel ?? ''] ?? channel} — solo lectura por ahora: la
        respuesta desde el panel para este canal todavía no está disponible.
      </div>
    );
  }

  if (!puedeEscribir(role, isHuman)) {
    return (
      <div className="border-t border-ink-100 px-4 py-2 text-center text-xs text-ink-400">
        El bot responde automáticamente. Tomá la conversación para atender vos.
      </div>
    );
  }

  const override = !isHuman && puedeEnviarSinTakeover(role);
  const enviandoAdjunto = attachMut.isPending;

  return (
    <form
      className="space-y-1.5 border-t border-ink-100 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
        {isHuman ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">
            🧑‍💼 Bot pausado — respondés vos
          </span>
        ) : (
          override && (
            <span className="rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-700">
              El bot sigue activo — escribís sin tomar el chat
            </span>
          )
        )}
        {isMock && (
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-ink-600" title="whatsappSendMode=mock">
            Modo prueba: se guarda en el historial pero NO sale a WhatsApp
          </span>
        )}
      </div>

      {/* Preview del adjunto elegido, con caption y cancelar (antes de enviar nada). */}
      {attach && (
        <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-2">
          <div className="flex items-start gap-2">
            {attach.kind === 'image' && attach.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- objectURL local, next/image no aplica
              <img
                src={attach.previewUrl}
                alt={'Vista previa de ' + (attach.file.name || 'la imagen a enviar')}
                className="h-16 w-16 shrink-0 rounded-lg border border-ink-100 bg-white object-cover"
              />
            ) : (
              <span aria-hidden="true" className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-ink-100 bg-white text-2xl">
                📄
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-ink-800">{attach.file.name || 'Archivo'}</p>
              <p className="text-[11px] text-ink-500">
                {attach.kind === 'image' ? 'Imagen' : 'PDF'} · {(attach.file.size / (1024 * 1024)).toFixed(1)} MB
              </p>
              <label className="mt-1 block">
                <span className="sr-only">Comentario del archivo (opcional)</span>
                <input
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  maxLength={1024}
                  placeholder="Comentario opcional…"
                  disabled={enviandoAdjunto}
                  className="w-full rounded-lg border border-ink-200 px-2 py-1 text-xs text-ink-800 focus:border-mint-500 focus:outline-none"
                />
              </label>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={cancelarAdjunto}
              disabled={enviandoAdjunto}
              className="rounded-lg border border-ink-200 px-3 py-1 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => attachMut.mutate({ draft: attach, caption })}
              disabled={enviandoAdjunto || gateActivo}
              className="rounded-lg bg-mint-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
            >
              {enviandoAdjunto ? 'Enviando archivo…' : 'Enviar archivo'}
            </button>
          </div>
          {enviandoAdjunto && (
            <p role="status" className="mt-1 text-right text-[11px] text-ink-500">
              Subiendo… no cierres esta pantalla.
            </p>
          )}
        </div>
      )}
      {attachError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-coral-50 px-3 py-1.5 text-xs text-coral-700">
          <span>{attachError}</span>
          {attach && !enviandoAdjunto && (
            <button
              type="button"
              onClick={() => attachMut.mutate({ draft: attach, caption })}
              className="rounded-lg border border-coral-200 bg-white px-2 py-0.5 font-semibold text-coral-700 transition-colors hover:bg-coral-50"
            >
              Reintentar
            </button>
          )}
        </div>
      )}

      <div className="flex items-end gap-1.5">
        <div className="relative">
          {emojiOpen && <EmojiPicker onPick={insertarEmoji} onClose={() => setEmojiOpen(false)} />}
          <button
            type="button"
            aria-label="Insertar emoji"
            aria-expanded={emojiOpen}
            aria-haspopup="dialog"
            onClick={() => setEmojiOpen((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-xl text-lg text-ink-500 transition-colors hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
          >
            🙂
          </button>
        </div>
        <label
          className={cn(
            'grid h-9 w-9 cursor-pointer place-items-center rounded-xl text-lg text-ink-500 transition-colors hover:bg-ink-50',
            'focus-within:ring-2 focus-within:ring-mint-500/60',
            enviandoAdjunto && 'pointer-events-none opacity-50',
          )}
          title="Adjuntar imagen o PDF"
        >
          <span aria-hidden="true">📎</span>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            disabled={enviandoAdjunto}
            onChange={(e) => {
              elegirArchivo(e.target.files);
              e.target.value = '';
            }}
            className="sr-only"
            aria-label="Adjuntar imagen (JPG, PNG o WEBP hasta 5 MB) o documento PDF (hasta 7 MB)"
          />
        </label>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            autogrow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          maxLength={4096}
          placeholder="Escribile al cliente… (Enter envía, Shift+Enter hace salto de línea)"
          className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-ink-200 px-3 py-2 text-sm text-ink-900 outline-none focus:border-mint-500"
        />
        <button
          type="submit"
          disabled={!value.trim() || sending || gateActivo}
          className="shrink-0 rounded-xl bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-50"
        >
          {sending ? 'Enviando…' : 'Enviar'}
        </button>
      </div>

      {/* SHIPPING-CHAT-4B: ayuda NO destructiva del gate (el draft se conserva). */}
      {gateActivo && gateHelp && (
        <div className="text-xs font-medium text-sky-700" role="status">
          {gateHelp}
        </div>
      )}
      {sendError && (
        <div className="text-xs font-medium text-coral-600" role="alert">
          {sendError}
        </div>
      )}
    </form>
  );
}
