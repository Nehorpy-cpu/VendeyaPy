/**
 * ProductForm.governed.test.tsx — Edición honesta de campos gobernados (ADR-0022 §4).
 *
 * Caso Odyssey: con el catálogo publicado por una fuente externa, los campos públicos que
 * ella gobierna AVISAN quién los controla y editarlos exige confirmación explícita («tu
 * cambio queda local, no se publica») — JAMÁS se guarda en silencio. Los datos internos
 * (costo, notas) siguen editables sin fricción, y sin gobierno externo nada cambia.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Product, Category } from '@vpw/shared';
import { normalizarOwnershipStatus } from '@/lib/catalog';
import { ProductForm } from './ProductForm';

/** Fuente externa reconocida que gobierna Nombre y Precio (modelo arfagi). */
const OWN_EXTERNO = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'dry_run',
  ownership: {
    model: 'external_managed',
    writable: [],
    external: ['title', 'price'],
    externalSource: {
      kind: 'meta_feed',
      name: 'Catálogo del sitio',
      acknowledgedByUid: 'u1',
      acknowledgedSourceIds: ['1'],
      declaredFields: ['title', 'price'],
    },
    degraded: false,
    reasons: [],
  },
});

const CATEGORIAS = [{ id: 'general', name: 'General', position: 1 }] as unknown as Category[];

const PRODUCTO = {
  id: 'p1',
  name: 'Armaf Odyssey Mega',
  brand: 'Armaf',
  description: 'Perfume',
  price: 250000,
  compareAtPrice: null,
  categoryId: 'general',
  images: ['https://x/a.jpg'],
  emoji: '🌸',
  inventory: { trackStock: true, stock: 5, lowStockThreshold: 2, sku: 'p1' },
  status: 'ACTIVE',
  featured: false,
  productUrl: 'https://x/p',
  perfume: null,
  aiFicha: null,
} as unknown as Product;

const AVISO_CAMPO = 'Este dato lo publica Catálogo del sitio: se corrige allá. Lo que edites acá queda local y no se publica.';

function renderForm(over?: Partial<Parameters<typeof ProductForm>[0]>) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ProductForm
      initial={PRODUCTO}
      initialCost={100000}
      initialPriority={null}
      categories={CATEGORIAS}
      ownership={OWN_EXTERNO}
      onCancel={onCancel}
      onSubmit={onSubmit}
      saving={false}
      {...over}
    />,
  );
  const form = utils.container.querySelector('form')!;
  return { ...utils, onSubmit, onCancel, form };
}

const modalGobernado = () => screen.queryByRole('dialog', { name: 'Este dato lo controla otra fuente' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('avisos de quién controla cada dato', () => {
  it('los campos gobernados (Nombre y Precio) muestran el aviso; los demás no', () => {
    renderForm();
    // Un aviso por campo gobernado del form (title y price) + el resumen del fieldset.
    expect(screen.getAllByText(AVISO_CAMPO)).toHaveLength(2);
    expect(screen.getByText(/estos datos publicados los\s*controla Catálogo del sitio/)).toBeInTheDocument();
    expect(screen.getByText(/puede bloquear la venta automática/)).toBeInTheDocument();
  });

  it('sin gobierno externo no hay ningún aviso', () => {
    renderForm({ ownership: null });
    expect(screen.queryByText(AVISO_CAMPO)).not.toBeInTheDocument();
    expect(screen.queryByText(/puede bloquear la venta automática/)).not.toBeInTheDocument();
  });

  it('propiedad ilegible + producto con identidad remota: aviso genérico (mitigación fail-open)', () => {
    // ownership null = la consulta está cargando o falló: los avisos específicos no existen.
    // Con un producto que YA vive en Meta se avisa genérico; el guard del server protege igual.
    renderForm({
      ownership: null,
      initial: { ...PRODUCTO, metaRetailerId: 'ARF-ODY-1' } as unknown as Product,
    });
    expect(screen.getByText(/No pudimos verificar quién administra el catálogo publicado/)).toBeInTheDocument();
    expect(screen.queryByText(AVISO_CAMPO)).not.toBeInTheDocument();
  });

  it('propiedad ilegible SIN identidad remota: nada que avisar', () => {
    renderForm({ ownership: null });
    expect(screen.queryByText(/No pudimos verificar quién administra el catálogo publicado/)).not.toBeInTheDocument();
  });
});

describe('confirmación explícita al editar un campo gobernado', () => {
  it('cambiar el precio NO guarda en silencio: confirma, y «Volver» no guarda nada', async () => {
    const { onSubmit, form } = renderForm();
    fireEvent.change(screen.getByLabelText('Precio de venta (₲) *'), { target: { value: '300000' } });
    fireEvent.submit(form);

    const dialogo = await screen.findByRole('dialog', { name: 'Este dato lo controla otra fuente' });
    expect(dialogo).toHaveTextContent('Precio');
    expect(dialogo).toHaveTextContent(/tu cambio queda local/i);
    expect(dialogo).toHaveTextContent('no se publica');
    expect(dialogo).toHaveTextContent(/corregilo en Catálogo del sitio/);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Volver' }));
    await waitFor(() => expect(modalGobernado()).not.toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
    // El formulario sigue abierto con lo editado (no se perdió nada).
    expect(screen.getByRole('dialog', { name: 'Editar producto' })).toBeInTheDocument();
  });

  it('confirmar guarda EXACTAMENTE lo editado (queda local)', async () => {
    const { onSubmit, form } = renderForm();
    fireEvent.change(screen.getByLabelText('Precio de venta (₲) *'), { target: { value: '300000' } });
    fireEvent.submit(form);

    const dialogo = await screen.findByRole('dialog', { name: 'Este dato lo controla otra fuente' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Guardar igual (queda local)' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ id: 'p1', price: 300000 });
    await waitFor(() => expect(modalGobernado()).not.toBeInTheDocument());
  });

  it('editar SOLO datos internos (costo) no molesta con ninguna confirmación', async () => {
    const { onSubmit, form } = renderForm();
    fireEvent.change(screen.getByLabelText('Precio de costo (₲)'), { target: { value: '120000' } });
    fireEvent.submit(form);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ costPrice: 120000, price: 250000 });
    expect(modalGobernado()).not.toBeInTheDocument();
  });

  it('editar un campo público NO gobernado (descripción) tampoco confirma', async () => {
    const { onSubmit, form } = renderForm();
    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Nueva descripción' } });
    fireEvent.submit(form);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(modalGobernado()).not.toBeInTheDocument();
  });

  it('sin gobierno externo el guardado es directo aunque cambie el precio', async () => {
    const { onSubmit, form } = renderForm({ ownership: null });
    fireEvent.change(screen.getByLabelText('Precio de venta (₲) *'), { target: { value: '999000' } });
    fireEvent.submit(form);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(modalGobernado()).not.toBeInTheDocument();
  });

  it('un producto NUEVO no confirma deriva (todavía no existe publicado), pero avisa igual', async () => {
    const { onSubmit, form } = renderForm({ initial: null, initialCost: null });
    expect(screen.getAllByText(AVISO_CAMPO).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Nombre *'), { target: { value: 'Producto nuevo' } });
    fireEvent.change(screen.getByLabelText('Precio de venta (₲) *'), { target: { value: '150000' } });
    fireEvent.submit(form);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(modalGobernado()).not.toBeInTheDocument();
  });
});
