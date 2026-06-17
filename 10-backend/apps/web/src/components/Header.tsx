'use client';

import { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS } from '@/lib/roles';
import { firebaseDb } from '@/lib/firebase';

interface CompanyOption {
  id: string;
  name: string;
}

/** Empresa "activa" que el Super Admin está viendo (se guarda en localStorage). */
const ACTIVE_KEY = 'aiafg.activeCompany';

export function Header() {
  const { user, claims, signOut } = useAuth();
  const isSuperAdmin = claims.role === 'PLATFORM_ADMIN';

  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [active, setActive] = useState<string>('');

  // Super Admin: cargar lista de empresas para el selector.
  useEffect(() => {
    if (!isSuperAdmin) return;
    (async () => {
      const snap = await getDocs(collection(firebaseDb(), 'tenants'));
      const list = snap.docs.map((d) => ({ id: d.id, name: (d.data().name as string) ?? d.id }));
      setCompanies(list);
      const stored = typeof window !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null;
      setActive(stored ?? list[0]?.id ?? '');
    })().catch(() => setCompanies([]));
  }, [isSuperAdmin]);

  const onSelect = (id: string) => {
    setActive(id);
    if (typeof window !== 'undefined') localStorage.setItem(ACTIVE_KEY, id);
  };

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-4 md:px-6">
      <div className="flex items-center gap-3">
        {isSuperAdmin ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">Empresa:</span>
            <select
              value={active}
              onChange={(e) => onSelect(e.target.value)}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
            >
              {companies.length === 0 && <option value="">(sin empresas)</option>}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        ) : (
          <span className="text-sm font-medium text-gray-700">
            {claims.tenantId ?? 'Mi empresa'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden text-right sm:block">
          <div className="text-sm font-medium text-gray-800">{user?.email}</div>
          <div className="text-xs text-gray-500">
            {claims.role ? ROLE_LABELS[claims.role] : '—'}
          </div>
        </div>
        <button
          onClick={() => signOut()}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          Salir
        </button>
      </div>
    </header>
  );
}
