import { describe, it, expect } from 'vitest';
import { toolsForContext, toolDefinitionsForContext, executeTool } from './registry.js';

describe('ai/tools registry — allowlist por contexto', () => {
  it('sales agent ve solo sus tools (no internas, no el contrato de write)', () => {
    const names = toolDefinitionsForContext('whatsapp_sales_agent').map((t) => t.name);
    expect(names).toEqual(['buscar_productos', 'listar_promociones_activas']);
    expect(names).not.toContain('resumen_ventas');
    expect(names).not.toContain('crear_borrador_pedido');
  });

  it('internal assistant ve solo sus tools', () => {
    const names = toolDefinitionsForContext('internal_growth_assistant').map((t) => t.name);
    expect(names).toEqual(['resumen_ventas']);
    expect(names).not.toContain('buscar_productos');
  });

  it('sales NO puede llamar una tool interna (not-found, no se ejecuta)', async () => {
    const r = await executeTool('whatsapp_sales_agent', 'perfumeria', 'resumen_ventas', {});
    expect(r.ok).toBe(false);
    expect(r.result).toBeUndefined();
  });

  it('internal NO puede llamar una tool de sales', async () => {
    const r = await executeTool('internal_growth_assistant', 'perfumeria', 'buscar_productos', {});
    expect(r.ok).toBe(false);
  });

  it('tool desconocida → not-found', async () => {
    const r = await executeTool('whatsapp_sales_agent', 'perfumeria', 'crear_borrador_pedido', {});
    expect(r.ok).toBe(false); // el contrato de write no está en ningún allowlist
  });

  it('ningún contexto tiene tools de escritura en AG-2 (read-only)', () => {
    const all = [...toolsForContext('whatsapp_sales_agent'), ...toolsForContext('internal_growth_assistant')];
    const names = all.map((t) => t.definition.name);
    expect(names).not.toContain('crear_borrador_pedido');
  });
});
