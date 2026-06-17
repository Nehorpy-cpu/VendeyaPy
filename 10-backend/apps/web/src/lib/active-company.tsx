'use client';

/**
 * Empresa "activa" del panel.
 * - Owner/Seller: su propia empresa (claims.tenantId).
 * - Super Admin: la empresa seleccionada en el Header (persistida en localStorage).
 * Los módulos consultan datos usando este tenantId.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { useAuth } from './auth-context';
import { firebaseDb } from './firebase';

export interface CompanyOption {
  id: string;
  name: string;
}

interface ActiveCompanyState {
  tenantId: string | null;
  companies: CompanyOption[];
  isSuperAdmin: boolean;
  loading: boolean;
  setTenantId: (id: string) => void;
}

const STORAGE_KEY = 'aiafg.activeCompany';

const Ctx = createContext<ActiveCompanyState>({
  tenantId: null,
  companies: [],
  isSuperAdmin: false,
  loading: true,
  setTenantId: () => {},
});

export function ActiveCompanyProvider({ children }: { children: React.ReactNode }) {
  const { user, claims, loading: authLoading } = useAuth();
  const isSuperAdmin = claims.role === 'PLATFORM_ADMIN';
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [tenantId, setTenantIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setTenantIdState(null);
      setLoading(false);
      return;
    }
    if (!isSuperAdmin) {
      setTenantIdState(claims.tenantId);
      setLoading(false);
      return;
    }
    // Super Admin: cargar empresas y elegir la activa.
    (async () => {
      const snap = await getDocs(collection(firebaseDb(), 'tenants'));
      const list = snap.docs.map((d) => ({ id: d.id, name: (d.data().name as string) ?? d.id }));
      setCompanies(list);
      const stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      const valid = stored && list.some((c) => c.id === stored) ? stored : (list[0]?.id ?? null);
      setTenantIdState(valid);
      setLoading(false);
    })().catch(() => {
      setCompanies([]);
      setLoading(false);
    });
  }, [authLoading, user, isSuperAdmin, claims.tenantId]);

  const setTenantId = (id: string) => {
    setTenantIdState(id);
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, id);
  };

  return (
    <Ctx.Provider value={{ tenantId, companies, isSuperAdmin, loading, setTenantId }}>
      {children}
    </Ctx.Provider>
  );
}

export function useActiveCompany(): ActiveCompanyState {
  return useContext(Ctx);
}
