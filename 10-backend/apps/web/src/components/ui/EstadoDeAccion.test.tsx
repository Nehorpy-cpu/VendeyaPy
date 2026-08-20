/**
 * EstadoDeAccion.test.tsx — el contrato de accesibilidad del aviso.
 *
 * El detalle que motiva estos tests: un `role="status"` que se INSERTA junto con su texto no se
 * anuncia de forma confiable (el lector de pantalla tenía que estar observando esa región desde
 * antes). Por eso la live region existe siempre, aunque esté vacía, y solo cambia su contenido.
 * El error usa `role="alert"`, que sí se anuncia al insertarse.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EstadoDeAccion } from './EstadoDeAccion';

describe('EstadoDeAccion', () => {
  it('la live region existe ANTES de que haya mensaje', () => {
    const { rerender } = render(<EstadoDeAccion tipo="ok" mensaje={null} />);

    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(<EstadoDeAccion tipo="ok" mensaje="Listo." />);

    // La MISMA región (no una nueva) es la que ahora lleva el texto: eso es lo que hace que se anuncie.
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Listo.');
  });

  it('pasar de éxito a error monta un alert NUEVO (si no, no se anuncia)', () => {
    // Las pantallas con un solo estado de mensaje pasan de ok a error sin pasar por null. Sin
    // `key`, React reutilizaría el mismo <p> y solo le agregaría el rol: un `alert` que ya estaba
    // en el DOM no se anuncia.
    const { container, rerender } = render(<EstadoDeAccion tipo="ok" mensaje="Listo." />);
    const anterior = container.querySelector('p');

    rerender(<EstadoDeAccion tipo="error" mensaje="No se pudo." />);

    const alerta = screen.getByRole('alert');
    expect(alerta).not.toBe(anterior);
    expect(alerta.textContent).toBe('No se pudo.');
  });

  it('sin mensaje no pinta nada visible', () => {
    const { container } = render(<EstadoDeAccion tipo="error" mensaje={null} />);

    expect(container.querySelector('p')).toBeNull();
  });

  it('el error se anuncia como alert y no se duplica en la región de éxito', () => {
    render(<EstadoDeAccion tipo="error" mensaje="No se pudo guardar." />);

    expect(screen.getByRole('alert').textContent).toBe('No se pudo guardar.');
    // Si el texto también cayera en la live region, un lector lo diría dos veces.
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getAllByText('No se pudo guardar.')).toHaveLength(1);
  });

  it('el éxito aparece una sola vez a la vista (la copia extra es solo para lectores)', () => {
    const { container } = render(<EstadoDeAccion tipo="ok" mensaje="Guardado." />);

    const visibles = [...container.querySelectorAll('p')];
    expect(visibles).toHaveLength(1);
    expect(visibles[0]!.className).not.toContain('sr-only');
    expect(screen.getByRole('status').className).toContain('sr-only');
    // …y la copia visible sale del árbol de accesibilidad, o el lector diría el éxito dos veces.
    expect(visibles[0]!.getAttribute('aria-hidden')).toBe('true');
  });
});
