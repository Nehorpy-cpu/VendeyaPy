import { describe, it, expect } from 'vitest';
import { resumenVentas } from './internalTools.js';
import type { TenantStatsPublic, TenantStatsPrivate } from '@vpw/shared';

describe('ai/internalTools resumen_ventas', () => {
  it('usa el tenantId del CONTEXTO e ignora el del input; devuelve agregados del propio tenant', async () => {
    let seenTenant = '';
    const deps = {
      readStats: async (tenantId: string) => {
        seenTenant = tenantId;
        return {
          pub: { ventas: 5, ingresos: 500, ticketPromedio: 100, pendingOrders: 0, topVendidos: [] } as unknown as TenantStatsPublic,
          priv: { ganancia: 200, margen: 0.4, topRentables: [] } as unknown as TenantStatsPrivate,
        };
      },
    };
    const out = (await resumenVentas.execute('perfumeria', { tenantId: 'boutique-demo' }, deps)) as Record<string, unknown>;
    expect(seenTenant).toBe('perfumeria'); // NO boutique-demo
    expect(out.ventas).toBe(5);
    expect(out.ganancia).toBe(200); // interno SÍ ve ganancia
  });
});
