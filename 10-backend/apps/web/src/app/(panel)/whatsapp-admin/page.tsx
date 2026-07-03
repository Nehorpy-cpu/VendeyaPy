'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { SectionHeader, EmptyState } from '@/components/ui';
import { WhatsappActivationQueue } from '@/components/whatsapp-admin/WhatsappActivationQueue';
import { ManualWhatsappConnectForm } from '@/components/whatsapp-admin/ManualWhatsappConnectForm';
import { TenantWhatsappNumbers } from '@/components/whatsapp-admin/TenantWhatsappNumbers';

/**
 * Panel del PLATFORM_ADMIN (WM-2): bandeja de solicitudes de activación de WhatsApp + carga manual
 * de la conexión (WM-1). Gate por rol en el componente (la autorización REAL la reexige el callable).
 * El acceso a esta ruta desde el sidebar ya está restringido a PLATFORM_ADMIN (roles.ts).
 */
export default function WhatsappAdminPage() {
  const { claims } = useAuth();
  const [selected, setSelected] = useState<{ tenantId: string; requestId?: string; businessName?: string } | null>(null);

  if (claims.role !== 'PLATFORM_ADMIN') {
    return <EmptyState title="Solo para administradores" text="Esta sección es exclusiva del administrador de la plataforma." />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <SectionHeader
        title="Activación manual de WhatsApp"
        subtitle="Solicitudes de las empresas y carga manual de la conexión. El token se envía cifrado y no se guarda ni se muestra."
      />
      <WhatsappActivationQueue
        onLoad={(r) => setSelected({ tenantId: r.tenantId, requestId: r.requestId, businessName: r.businessName ?? undefined })}
      />
      <ManualWhatsappConnectForm
        key={selected?.requestId ?? selected?.tenantId ?? 'blank'}
        initial={selected ?? undefined}
        onDone={() => setSelected(null)}
      />
      {/* MULTI-NUMBER-1: números de la empresa (agregar adicional / desactivar). */}
      <TenantWhatsappNumbers />
    </div>
  );
}
