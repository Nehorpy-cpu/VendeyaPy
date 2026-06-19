'use client';

/**
 * RegistrationGate — guard de estados post-autenticación del panel (Fase registro R-3).
 *
 * El layout del panel ya resuelve `loading` y `!user → /login`. Este componente cubre el resto:
 *   - PLATFORM_ADMIN → pasa siempre (no tiene onboarding de tenant).
 *   - Owner/staff con claims → si es owner y su tenant NO completó el onboarding, lo manda a /welcome.
 *   - Usuario autenticado SIN claims todavía → "Preparando tu empresa" (refresca el token unos
 *     segundos esperando que propaguen los claims); si expira, estado huérfano con CTA claro (#10).
 * Se evita el loop: el gate redirige a /welcome solo si onboarding=false; /welcome sale a /dashboard
 * solo cuando está completo. Un read fallido del flag NO bloquea (fail-open).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { firebaseAuth } from '@/lib/firebase';
import { getTenantOnboardingCompleted } from '@/lib/registration';

const SUPPORT_WHATSAPP = process.env['NEXT_PUBLIC_SUPPORT_WHATSAPP'] ?? '';

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-ink-50/50 px-6 text-center">{children}</div>;
}

/** Usuario autenticado pero sin claims: refresca el token unos segundos; al expirar muestra el estado huérfano. */
function PreparingCompany() {
  const [timedOut, setTimedOut] = useState(false);
  const { signOut } = useAuth();

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      tries += 1;
      const u = firebaseAuth().currentUser;
      // Forzar refresh: si ya hay claims, onIdTokenChanged (auth-context) re-renderiza y este gate sale solo.
      if (u) await u.getIdTokenResult(true).catch(() => {});
      if (cancelled) return;
      if (tries >= 6) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!timedOut) {
    return (
      <FullScreen>
        <div className="max-w-sm">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-ink-200 border-t-mint-brand" />
          <h1 className="text-lg font-semibold text-ink-900">Preparando tu empresa…</h1>
          <p className="mt-1 text-sm text-ink-500">Estamos terminando de configurar tu acceso. Esto toma unos segundos.</p>
        </div>
      </FullScreen>
    );
  }

  const waHref = SUPPORT_WHATSAPP ? `https://wa.me/${SUPPORT_WHATSAPP.replace(/\D/g, '')}` : '';
  return (
    <FullScreen>
      <div className="max-w-md">
        <h1 className="text-lg font-semibold text-ink-900">No encontramos tu empresa</h1>
        <p className="mt-1 text-sm text-ink-500">
          Tu cuenta está activa pero todavía no tiene una empresa asociada. Continuá el registro para crearla o
          escribinos si creés que es un error.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Link
            href="/register"
            className="inline-flex h-11 items-center justify-center rounded-full bg-mint-brand text-sm font-semibold text-white shadow-glow transition hover:brightness-105"
          >
            Continuar registro
          </Link>
          {waHref && (
            <a
              href={waHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center rounded-full border border-ink-200 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
            >
              Contactar soporte
            </a>
          )}
          <button
            onClick={() => signOut()}
            className="inline-flex h-10 items-center justify-center text-sm font-medium text-ink-400 transition hover:text-ink-700"
          >
            Cerrar sesión
          </button>
        </div>
      </div>
    </FullScreen>
  );
}

export function RegistrationGate({ children }: { children: React.ReactNode }) {
  const { user, claims, loading } = useAuth();
  const router = useRouter();
  // onboarding del owner: undefined = leyendo, true/false = resuelto, null = read fallido (fail-open).
  const [onboarding, setOnboarding] = useState<boolean | null | undefined>(undefined);
  const redirectedRef = useRef(false);

  const isAdmin = claims.role === 'PLATFORM_ADMIN';
  const isOwner = claims.role === 'TENANT_OWNER';
  const hasClaims = !!claims.tenantId && !!claims.role;

  useEffect(() => {
    let cancelled = false;
    // Solo el owner tiene gate de onboarding; admin y staff no consultan el flag.
    if (!isOwner || !claims.tenantId) {
      setOnboarding(undefined);
      return;
    }
    setOnboarding(undefined);
    getTenantOnboardingCompleted(claims.tenantId).then((v) => {
      if (!cancelled) setOnboarding(v);
    });
    return () => {
      cancelled = true;
    };
  }, [isOwner, claims.tenantId]);

  useEffect(() => {
    if (isOwner && onboarding === false && !redirectedRef.current) {
      redirectedRef.current = true;
      router.replace('/welcome');
    }
  }, [isOwner, onboarding, router]);

  // El layout ya cubre loading/!user, pero por las dudas no renderizamos el panel sin usuario.
  if (loading || !user) return null;

  // Admin: acceso directo (sin onboarding de tenant).
  if (isAdmin) return <>{children}</>;

  // Autenticado sin claims todavía: preparando / huérfano.
  if (!hasClaims) return <PreparingCompany />;

  // Owner: esperar la lectura del flag; si falta onboarding, ya estamos redirigiendo a /welcome.
  if (isOwner) {
    if (onboarding === undefined) {
      return (
        <FullScreen>
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-200 border-t-mint-brand" />
        </FullScreen>
      );
    }
    if (onboarding === false) return null; // redirigiendo a /welcome
  }

  // Owner con onboarding completo (o null/fail-open) y staff con claims: al panel.
  return <>{children}</>;
}
