/**
 * AttachmentViewer — accesibilidad y estados (ADR-0016 · Área D).
 * Se prueba lo que un lector de pantalla y un teclado necesitan: rol de diálogo, foco al abrir,
 * trampa de foco, Escape, devolución del foco al disparador y texto alternativo.
 * Además: la URL firmada NUNCA aparece como texto ni como enlace, y la ruta de Storage NUNCA
 * llega al DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Attachment } from '@vpw/shared';
import { AttachmentViewer } from './AttachmentViewer';

const getAttachmentViewUrl = vi.fn();
vi.mock('@/lib/attachments', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/attachments')>();
  return { ...real, getAttachmentViewUrl: (...a: unknown[]) => getAttachmentViewUrl(...a) };
});

const URL_FIRMADA = 'https://storage.googleapis.example/firmada?token=SECRETO123';
const PATH_STORAGE = 'tenants/tnt_1/attachments/aa/att_secreto';
const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Attachment['createdAt'];

function att(over: Partial<Attachment> = {}): Attachment {
  return {
    attachmentId: 'att_' + 'a'.repeat(24),
    tenantId: 'tnt_1',
    customerId: '595981000000',
    conversationId: '595981000000',
    messageId: 'msg_1',
    providerMessageId: 'pmid_' + 'b'.repeat(24),
    channel: 'whatsapp',
    class: 'image',
    direction: 'in',
    author: 'customer',
    ingestState: 'stored',
    classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: ts(1) },
    caption: '',
    filename: null,
    mime: { declared: 'image/jpeg', verified: 'image/jpeg' },
    bytes: 2048,
    checksum: 'abc',
    storage: { path: PATH_STORAGE },
    orderCandidateId: null,
    retentionUntil: null,
    purgedAt: null,
    createdAt: ts(1),
    updatedAt: ts(1),
    lastError: null,
    ...over,
  } as Attachment;
}

/** Harness con disparador real: hace falta para verificar la devolución del foco. */
function Harness({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Abrir adjunto</button>
      {open && <AttachmentViewer tenantId="tnt_1" attachment={attachment} onClose={() => setOpen(false)} />}
    </>
  );
}

describe('AttachmentViewer', () => {
  beforeEach(() => {
    getAttachmentViewUrl.mockReset();
    getAttachmentViewUrl.mockResolvedValue({ url: URL_FIRMADA, expiresAt: Date.now() + 300000 });
  });

  it('muestra el esqueleto de carga y después la imagen con texto alternativo', async () => {
    render(<AttachmentViewer tenantId="tnt_1" attachment={att({ caption: 'ya te pagué' })} onClose={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(/generando enlace seguro/i);
    const img = await screen.findByAltText(/imagen enviada por el cliente: ya te pagué/i);
    expect((img as HTMLImageElement).src).toContain('firmada');
    expect(getAttachmentViewUrl).toHaveBeenCalledWith('tnt_1', 'att_' + 'a'.repeat(24));
  });

  it('es un diálogo modal con nombre accesible y foco adentro al abrir', async () => {
    render(<AttachmentViewer tenantId="tnt_1" attachment={att({ filename: 'transferencia.pdf', class: 'document', mime: { declared: 'application/pdf', verified: 'application/pdf' } })} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('transferencia.pdf');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('Escape cierra y el foco vuelve al botón que lo abrió', async () => {
    render(<Harness attachment={att()} />);
    const disparador = screen.getByRole('button', { name: 'Abrir adjunto' });
    disparador.focus();
    fireEvent.click(disparador);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(disparador);
  });

  it('la trampa de foco cicla con Tab y Shift+Tab dentro del diálogo', async () => {
    render(<AttachmentViewer tenantId="tnt_1" attachment={att()} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button'));
    expect(focusables.length).toBeGreaterThan(0);
    const primero = focusables[0]!;
    const ultimo = focusables[focusables.length - 1]!;

    ultimo.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(primero);

    primero.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ultimo);
  });

  it('error del callable → motivo accionable + reintento de SOLO LECTURA', async () => {
    getAttachmentViewUrl.mockReset();
    getAttachmentViewUrl.mockRejectedValueOnce({ code: 'functions/not-found', message: 'x' });
    getAttachmentViewUrl.mockResolvedValueOnce({ url: URL_FIRMADA, expiresAt: 1 });
    render(<AttachmentViewer tenantId="tnt_1" attachment={att()} onClose={() => {}} />);
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent(/reenv/i); // dice qué hacer, no solo que falló
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));
    expect(await screen.findByAltText(/imagen enviada por el cliente/i)).toBeInTheDocument();
    expect(getAttachmentViewUrl).toHaveBeenCalledTimes(2); // el reintento solo vuelve a LEER
  });

  it('enlace vencido mientras el visor está abierto → motivo claro, no un ícono roto', async () => {
    render(<AttachmentViewer tenantId="tnt_1" attachment={att()} onClose={() => {}} />);
    const img = await screen.findByAltText(/imagen enviada por el cliente/i);
    fireEvent.error(img); // el navegador no pudo traer los bytes: el callable nunca falló
    expect(await screen.findByRole('alert')).toHaveTextContent(/expirar/i);
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  });

  it('documento: no se renderiza como imagen y se abre en pestaña nueva (la URL no queda en el DOM)', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const pdf = att({ class: 'document', filename: 'comprobante.pdf', bytes: 120000, mime: { declared: 'application/pdf', verified: 'application/pdf' } });
    render(<AttachmentViewer tenantId="tnt_1" attachment={pdf} onClose={() => {}} />);
    const boton = await screen.findByRole('button', { name: /abrir el documento/i });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/PDF · 117 KB/)).toBeInTheDocument();
    fireEvent.click(boton);
    expect(open).toHaveBeenCalledWith(URL_FIRMADA, '_blank', 'noopener,noreferrer');
    expect(document.body.innerHTML).not.toContain(URL_FIRMADA);
    vi.unstubAllGlobals();
  });

  it('jamás muestra la ruta de Storage ni la URL firmada como texto o enlace', async () => {
    render(<AttachmentViewer tenantId="tnt_1" attachment={att()} onClose={() => {}} />);
    await screen.findByAltText(/imagen enviada por el cliente/i);
    // La ruta de Storage no entra al DOM de ninguna forma.
    expect(document.body.innerHTML).not.toContain(PATH_STORAGE);
    expect(document.body.innerHTML).not.toContain('tenants/');
    // La URL firmada solo vive en el src de la imagen: nunca como texto ni como href copiable.
    expect(document.body.textContent ?? '').not.toContain(URL_FIRMADA);
    for (const a of Array.from(document.querySelectorAll('a'))) {
      expect(a.getAttribute('href') ?? '').not.toContain('firmada');
    }
  });
});
