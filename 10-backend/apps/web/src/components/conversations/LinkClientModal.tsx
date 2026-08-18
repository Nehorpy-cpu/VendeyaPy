'use client';

/**
 * Modal de vínculo conversación↔cliente (ADR-0021 §4).
 * Búsqueda SERVER-SIDE (callable `customerSearch`, debounce + paginación por cursor, límite) y
 * alta de ficha nueva desde datos confirmados (`conversationCreateClient`, que crea Y vincula).
 * El server valida todo (auto-vínculo, cadenas, soft-deleted, cross-tenant); acá solo se elige.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  createAndLinkClient,
  linkConversationClient,
  searchCustomers,
  type CustomerSearchItem,
} from '@/lib/conversations';
import { maskPhone } from '@/lib/conversationsUi';
import { ModalShell } from '@/components/ui/ModalShell';
import { InitialsAvatar } from './InitialsAvatar';
import { cn } from '@/lib/cn';

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 10;

export function LinkClientModal({
  tenantId,
  customerId,
  onClose,
  onLinked,
}: {
  tenantId: string;
  customerId: string;
  onClose: () => void;
  /** Se llama con un mensaje de éxito ya redactado (para el aria-live de la página). */
  onLinked: (mensaje: string) => void;
}) {
  const [tab, setTab] = useState<'buscar' | 'crear'>('buscar');

  // ── Búsqueda server-side con debounce ──
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CustomerSearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [buscado, setBuscado] = useState(false);
  const reqSeq = useRef(0);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) {
      setItems([]);
      setNextCursor(undefined);
      setBuscado(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const seq = ++reqSeq.current;
    const t = setTimeout(async () => {
      try {
        const r = await searchCustomers(tenantId, needle, PAGE_SIZE);
        if (seq !== reqSeq.current) return; // llegó tarde: ya hay otra búsqueda en curso
        setItems(r.items);
        setNextCursor(r.nextCursor);
        setBuscado(true);
      } catch {
        if (seq !== reqSeq.current) return;
        setSearchError('No se pudo buscar. Revisá tu conexión y probá de nuevo.');
      } finally {
        if (seq === reqSeq.current) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, tenantId]);

  const cargarMas = async () => {
    if (!nextCursor) return;
    setSearching(true);
    try {
      const r = await searchCustomers(tenantId, q.trim(), PAGE_SIZE, nextCursor);
      setItems((prev) => [...prev, ...r.items.filter((n) => !prev.some((p) => p.id === n.id))]);
      setNextCursor(r.nextCursor);
    } catch {
      setSearchError('No se pudo cargar más resultados.');
    } finally {
      setSearching(false);
    }
  };

  const linkMut = useMutation({
    mutationFn: (clientId: string) => linkConversationClient(tenantId, customerId, clientId),
    onSuccess: (_r, clientId) => {
      const elegido = items.find((i) => i.id === clientId);
      onLinked(`Conversación vinculada a ${elegido?.name || 'la ficha elegida'}.`);
      onClose();
    },
  });

  // ── Crear ficha nueva ──
  const [nombre, setNombre] = useState('');
  const [notas, setNotas] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const createMut = useMutation({
    mutationFn: () => createAndLinkClient(tenantId, customerId, nombre.trim(), notas.trim() || undefined),
    onSuccess: () => {
      onLinked(`Cliente «${nombre.trim()}» creado y vinculado.`);
      onClose();
    },
  });
  const crear = () => {
    if (nombre.trim().length < 2) {
      setFormError('Poné el nombre del cliente (mínimo 2 caracteres).');
      return;
    }
    setFormError(null);
    createMut.mutate();
  };

  const mutError =
    (linkMut.isError && (linkMut.error instanceof Error ? linkMut.error.message : 'No se pudo vincular.')) ||
    (createMut.isError && (createMut.error instanceof Error ? createMut.error.message : 'No se pudo crear el cliente.')) ||
    null;

  return (
    <ModalShell title="Vincular cliente" onClose={onClose} wide>
      <div className="flex gap-1.5" role="tablist" aria-label="Modo de vínculo">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'buscar'}
          onClick={() => setTab('buscar')}
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
            tab === 'buscar' ? 'bg-ink-900 text-white' : 'bg-ink-50 text-ink-600 hover:bg-ink-100',
          )}
        >
          Buscar existente
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'crear'}
          onClick={() => setTab('crear')}
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
            tab === 'crear' ? 'bg-ink-900 text-white' : 'bg-ink-50 text-ink-600 hover:bg-ink-100',
          )}
        >
          Crear cliente nuevo
        </button>
      </div>

      {tab === 'buscar' && (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="sr-only">Buscar cliente por nombre o teléfono</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Nombre o teléfono (mínimo 2 caracteres)…"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
            />
          </label>
          {searching && <p role="status" className="text-xs text-ink-400">Buscando…</p>}
          {searchError && <p role="alert" className="text-xs text-coral-600">{searchError}</p>}
          {!searching && buscado && items.length === 0 && !searchError && (
            <p className="text-xs text-ink-500">
              Sin resultados para «{q.trim()}». Podés crear el cliente en la otra pestaña.
            </p>
          )}
          <ul className="divide-y divide-ink-50">
            {items
              .filter((i) => i.id !== customerId) // el server igual bloquea el auto-vínculo
              .map((i) => (
                <li key={i.id} className="flex items-center gap-2.5 py-2">
                  <InitialsAvatar id={i.id} label={i.name || i.profileName || i.whatsappPhone} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-900">
                      {i.name || i.profileName || 'Sin nombre'}
                    </span>
                    <span className="block text-xs text-ink-500">{maskPhone(i.whatsappPhone)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => linkMut.mutate(i.id)}
                    disabled={linkMut.isPending}
                    className="shrink-0 rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                  >
                    {linkMut.isPending && linkMut.variables === i.id ? 'Vinculando…' : 'Vincular'}
                  </button>
                </li>
              ))}
          </ul>
          {nextCursor && !searching && (
            <button
              type="button"
              onClick={cargarMas}
              className="w-full rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-600 transition-colors hover:bg-ink-50"
            >
              Cargar más resultados
            </button>
          )}
        </div>
      )}

      {tab === 'crear' && (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-ink-700">
            Nombre del cliente <span className="text-coral-600">*</span>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              maxLength={120}
              placeholder="Ej: María González"
              className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
            />
          </label>
          <label className="block text-xs font-medium text-ink-700">
            Notas (opcional)
            <textarea
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Datos confirmados por el cliente…"
              className="mt-1 w-full resize-y rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
            />
          </label>
          {formError && <p role="alert" className="text-xs text-coral-600">{formError}</p>}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={crear}
              disabled={createMut.isPending}
              className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
            >
              {createMut.isPending ? 'Creando…' : 'Crear y vincular'}
            </button>
          </div>
        </div>
      )}

      {mutError && (
        <p role="alert" className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-xs text-coral-700">
          {mutError}
        </p>
      )}
    </ModalShell>
  );
}
