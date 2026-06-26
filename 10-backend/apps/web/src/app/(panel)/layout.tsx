'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { RegistrationGate } from '@/components/RegistrationGate';
import { TrialGuard } from '@/components/billing/TrialGuard';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-400">
        Cargando…
      </div>
    );
  }
  if (!user) return null; // redirigiendo a /login

  return (
    <RegistrationGate>
      <div className="flex min-h-screen bg-ink-50/50">
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header onMenuClick={() => setNavOpen(true)} />
          <main className="flex-1 overflow-y-auto p-4 md:p-6">
            <TrialGuard>{children}</TrialGuard>
          </main>
        </div>
      </div>
    </RegistrationGate>
  );
}
