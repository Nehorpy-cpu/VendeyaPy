/**
 * Composer.test.tsx — estados deshabilitados coherentes (canal IG, archivada/eliminada, rol sin
 * override), envío por Enter, y validación CLIENT de adjuntos espejo del server (ADR-0021 §5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, useRef, useState } from 'react';
import { Composer } from './Composer';

const sendConversationAttachment = vi.fn();
vi.mock('@/lib/conversations', () => ({
  sendConversationAttachment: (...a: unknown[]) => sendConversationAttachment(...a),
}));

type Props = Parameters<typeof Composer>[0];

function renderComposer(over: Partial<Props> = {}, value = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const props: Props = {
    tenantId: 't1',
    customerId: 'c1',
    value,
    onChange,
    textareaRef: createRef<HTMLTextAreaElement>(),
    channel: 'whatsapp',
    archived: false,
    softDeleted: false,
    isHuman: true,
    role: 'SELLER',
    gateActivo: false,
    gateHelp: null,
    isMock: false,
    sending: false,
    sendError: null,
    onSubmit,
    canRestore: true,
    onRestore: vi.fn(),
    restorePending: false,
    onAttachmentSent: vi.fn(),
    ...over,
  };
  const utils = render(
    <QueryClientProvider client={qc}>
      <Composer {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, props, onChange, onSubmit };
}

beforeEach(() => sendConversationAttachment.mockReset());

describe('Composer — deshabilitado coherente', () => {
  it('canal Instagram ⇒ solo lectura honesta, sin textarea ni botón de enviar', () => {
    renderComposer({ channel: 'instagram' });
    expect(screen.getByText(/solo lectura por ahora/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enviar/i })).not.toBeInTheDocument();
  });

  it('archivada ⇒ banner con «Restaurar» en lugar del compositor', () => {
    const onRestore = vi.fn();
    renderComposer({ archived: true, onRestore });
    expect(screen.getByText(/está archivada/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('eliminada ⇒ banner honesto; sin permiso de restaurar, se dice a quién pedírselo', () => {
    renderComposer({ softDeleted: true, canRestore: false });
    expect(screen.getByText(/está eliminada/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restaurar' })).not.toBeInTheDocument();
    expect(screen.getByText(/responsable del negocio/i)).toBeInTheDocument();
  });

  it('SELLER sin takeover ⇒ invita a tomar la conversación (sin composer)', () => {
    renderComposer({ isHuman: false, role: 'SELLER' });
    expect(screen.getByText(/tomá la conversación/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('MANAGER sin takeover ⇒ compositor habilitado con aviso de override honesto', () => {
    renderComposer({ isHuman: false, role: 'TENANT_MANAGER' });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByText(/el bot sigue activo/i)).toBeInTheDocument();
  });

  it('aviso de modo prueba se conserva', () => {
    renderComposer({ isMock: true });
    expect(screen.getByText(/modo prueba/i)).toBeInTheDocument();
  });
});

describe('Composer — envío de texto', () => {
  it('Enter envía; Shift+Enter NO', () => {
    const { onSubmit } = renderComposer({}, 'hola');
    const area = screen.getByRole('textbox');
    fireEvent.keyDown(area, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('con el gate de cotización activo el botón queda deshabilitado y se muestra la ayuda', () => {
    renderComposer({ gateActivo: true, gateHelp: 'Confirmá la cotización antes de enviar.' }, 'texto');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(screen.getByText('Confirmá la cotización antes de enviar.')).toBeInTheDocument();
  });

  it('el error de envío se muestra como alerta', () => {
    renderComposer({ sendError: 'No se pudo enviar el mensaje.' });
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo enviar el mensaje.');
  });
});

describe('Composer — adjuntos (validación client espejo del server)', () => {
  const input = () => screen.getByLabelText(/adjuntar imagen/i) as HTMLInputElement;

  it('tipo no permitido ⇒ error claro y NO se llama al callable', () => {
    renderComposer();
    const file = new File(['x'], 'malicia.svg', { type: 'image/svg+xml' });
    fireEvent.change(input(), { target: { files: [file] } });
    expect(screen.getByRole('alert')).toHaveTextContent(/formato no permitido/i);
    expect(sendConversationAttachment).not.toHaveBeenCalled();
  });

  it('imagen que excede 5 MB ⇒ rechazo con el límite en el mensaje', () => {
    renderComposer();
    const file = new File(['x'], 'grande.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(input(), { target: { files: [file] } });
    expect(screen.getByRole('alert')).toHaveTextContent(/5 MB/);
  });

  it('PDF válido ⇒ preview con nombre, caption opcional y cancelar (sin enviar todavía)', () => {
    renderComposer();
    const file = new File(['%PDF-'], 'catalogo.pdf', { type: 'application/pdf' });
    fireEvent.change(input(), { target: { files: [file] } });
    expect(screen.getByText('catalogo.pdf')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/comentario opcional/i)).toBeInTheDocument();
    expect(sendConversationAttachment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByText('catalogo.pdf')).not.toBeInTheDocument();
  });

  it('«Enviar archivo» manda el contrato con operationId y caption', async () => {
    sendConversationAttachment.mockResolvedValueOnce({ ok: true, attachmentId: 'a', messageId: 'm', viaMock: true });
    const { props } = renderComposer();
    const file = new File(['%PDF-contenido'], 'catalogo.pdf', { type: 'application/pdf' });
    fireEvent.change(input(), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText(/comentario opcional/i), { target: { value: 'precios' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar archivo' }));

    await vi.waitFor(() => expect(sendConversationAttachment).toHaveBeenCalledTimes(1));
    const payload = sendConversationAttachment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      tenantId: 't1',
      customerId: 'c1',
      kind: 'document',
      filename: 'catalogo.pdf',
      mimeType: 'application/pdf',
      caption: 'precios',
    });
    expect(typeof payload.operationId).toBe('string');
    expect((payload.operationId as string).length).toBeGreaterThan(8);
    expect(typeof payload.dataBase64).toBe('string');
    await vi.waitFor(() => expect(props.onAttachmentSent).toHaveBeenCalledWith(true));
  });

  it('error del server ⇒ mensaje honesto + Reintentar CONSERVANDO el archivo', async () => {
    sendConversationAttachment.mockRejectedValueOnce({ code: 'functions/resource-exhausted', message: 'too big' });
    renderComposer();
    const file = new File(['%PDF-'], 'catalogo.pdf', { type: 'application/pdf' });
    fireEvent.change(input(), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar archivo' }));

    await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/tamaño/i));
    // El archivo sigue en pantalla y hay reintento con el MISMO operationId.
    expect(screen.getByText('catalogo.pdf')).toBeInTheDocument();
    const primerOp = (sendConversationAttachment.mock.calls[0]![0] as { operationId: string }).operationId;
    sendConversationAttachment.mockResolvedValueOnce({ ok: true, attachmentId: 'a', messageId: 'm' });
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await vi.waitFor(() => expect(sendConversationAttachment).toHaveBeenCalledTimes(2));
    expect((sendConversationAttachment.mock.calls[1]![0] as { operationId: string }).operationId).toBe(primerOp);
  });
});

/** Harness con estado real para probar la inserción de emojis en el flujo controlado. */
function EmojiHarness() {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <Composer
      tenantId="t1"
      customerId="c1"
      value={value}
      onChange={setValue}
      textareaRef={ref}
      channel="whatsapp"
      archived={false}
      softDeleted={false}
      isHuman
      role="SELLER"
      gateActivo={false}
      gateHelp={null}
      isMock={false}
      sending={false}
      sendError={null}
      onSubmit={vi.fn()}
      canRestore
      onRestore={vi.fn()}
      restorePending={false}
      onAttachmentSent={vi.fn()}
    />
  );
}

describe('Composer — picker de emojis propio', () => {
  it('abre con el botón, inserta el emoji en el texto y cierra', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <EmojiHarness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Insertar emoji' }));
    expect(screen.getByRole('dialog', { name: 'Elegir emoji' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '😀' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('😀');
    expect(screen.queryByRole('dialog', { name: 'Elegir emoji' })).not.toBeInTheDocument();
  });
});
