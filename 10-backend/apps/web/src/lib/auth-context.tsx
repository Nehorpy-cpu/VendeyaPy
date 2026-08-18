'use client';

/**
 * Contexto de autenticación del panel.
 * Lee el usuario de Firebase Auth y sus custom claims { tenantId, role }.
 * La autorización REAL se valida en el backend (firestore.rules + Functions);
 * acá solo se usa para mostrar/ocultar UI y proteger rutas en el cliente.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import { onIdTokenChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { firebaseAuth } from './firebase';
import { limpiarBorradores } from './conversationsUi';

export type Role =
  | 'PLATFORM_ADMIN'
  | 'TENANT_OWNER'
  | 'TENANT_MANAGER'
  | 'TENANT_VIEWER'
  | 'SELLER';

export interface AuthClaims {
  role: Role | null;
  tenantId: string | null;
}

interface AuthState {
  user: User | null;
  claims: AuthClaims;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>({
  user: null,
  claims: { role: null, tenantId: null },
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<AuthClaims>({ role: null, tenantId: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = firebaseAuth();
    const unsub = onIdTokenChanged(auth, async (u) => {
      if (u) {
        const token = await u.getIdTokenResult();
        setClaims({
          role: (token.claims['role'] as Role | undefined) ?? null,
          tenantId: (token.claims['tenantId'] as string | undefined) ?? null,
        });
        setUser(u);
      } else {
        setUser(null);
        setClaims({ role: null, tenantId: null });
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const signOut = async () => {
    // B5 (ADR-0021): los borradores del chat son texto de negocio — se borran TODOS al cerrar
    // sesión para que no queden legibles en una máquina compartida. Es el único punto de logout:
    // el «Salir» del header y el del RegistrationGate llaman a este signOut.
    limpiarBorradores();
    await fbSignOut(firebaseAuth());
  };

  return (
    <AuthCtx.Provider value={{ user, claims, loading, signOut }}>{children}</AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}
