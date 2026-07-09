'use client';

/**
 * /register — Alta self-service de cuenta + empresa (Fase registro R-3).
 *
 * Flujo:
 *   1) El visitante crea su cuenta (email/password) y completa los datos de la empresa.
 *   2) Firebase Auth crea el usuario y le enviamos email de verificación.
 *   3) NO se puede crear la empresa hasta que email_verified sea true.
 *   4) "Ya verifiqué mi email": reload + getIdToken(true) y, si está verificado, llamamos
 *      registerTenantOwner (sin role/tenantId/planId/ownerUid/ownerEmail — los pone el backend).
 *   5) Refrescamos claims y vamos a /welcome (onboarding inicial).
 * Reanuda huérfanos: un usuario autenticado sin empresa entra directo al paso de verificación.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createUserWithEmailAndPassword, sendEmailVerification, reload } from 'firebase/auth';
import { COUNTRY, CURRENCY } from '@vpw/shared';
import { firebaseAuth } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { registerTenantOwner, friendlyRegisterError, waitForTenantClaim, selfRegistrationEnabled } from '@/lib/registration';
import { Logo } from '@/components/marketing/ui';

const SUPPORT_WHATSAPP = process.env['NEXT_PUBLIC_SUPPORT_WHATSAPP'] ?? '';

/** SINGLE-TENANT-LOCK: registro cerrado → aviso amable (la barrera real es el backend). */
function RegistroCerrado() {
  const waHref = SUPPORT_WHATSAPP ? `https://wa.me/${SUPPORT_WHATSAPP.replace(/\D/g, '')}` : '';
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50/50 px-6 text-center">
      <div className="w-full max-w-md rounded-2xl border border-ink-100 bg-white p-8 shadow-soft">
        <div className="mx-auto mb-4 w-fit"><Logo /></div>
        <h1 className="text-lg font-semibold text-ink-900">Registro por invitación</h1>
        <p className="mt-2 text-sm text-ink-500">
          Por ahora el alta de nuevas empresas está cerrada. Si querés usar VendeYaPy en tu negocio,
          escribinos y te avisamos apenas abramos nuevos cupos.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          {waHref && (
            <a href={waHref} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center justify-center rounded-full bg-mint-600 text-sm font-semibold text-white transition hover:bg-mint-700">
              Escribinos por WhatsApp
            </a>
          )}
          <Link href="/login" className="inline-flex h-11 items-center justify-center rounded-full border border-ink-200 text-sm font-medium text-ink-700 transition hover:bg-ink-50">
            Ya tengo cuenta — Iniciar sesión
          </Link>
        </div>
      </div>
    </div>
  );
}

const COUNTRY_LABEL: Record<string, string> = { PY: 'Paraguay', AR: 'Argentina', BR: 'Brasil', MX: 'México', CO: 'Colombia' };
const CURRENCY_LABEL: Record<string, string> = { PYG: 'Guaraní (₲)', ARS: 'Peso argentino ($)', USD: 'Dólar (US$)' };
const inputCls =
  'w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-mint-500 focus:ring-2 focus:ring-mint-500/30';
const isEmulator = process.env['NEXT_PUBLIC_USE_EMULATORS'] === 'true';

function mapAuthError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'auth/email-already-in-use') return 'Ese email ya tiene una cuenta. Iniciá sesión para continuar.';
  if (code === 'auth/weak-password') return 'La contraseña debe tener al menos 6 caracteres.';
  if (code === 'auth/invalid-email') return 'El email no es válido.';
  return 'No pudimos crear la cuenta. Probá de nuevo.';
}

export default function RegisterPage() {
  // SINGLE-TENANT-LOCK: con el alta cerrada, TODOS los CTAs que apuntan acá ven el aviso.
  if (!selfRegistrationEnabled()) return <RegistroCerrado />;
  return <RegisterFlow />;
}

function RegisterFlow() {
  const router = useRouter();
  const { user, claims, loading } = useAuth();

  const [step, setStep] = useState<'collect' | 'verify'>('collect');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState<string>('PY');
  const [currency, setCurrency] = useState<string>('PYG');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const initRef = useRef(false);

  // Estado inicial según sesión: con empresa → al panel; autenticado sin empresa → reanudar en "verificar".
  useEffect(() => {
    if (loading || initRef.current) return;
    initRef.current = true;
    if (user && claims.tenantId) {
      router.replace('/dashboard');
      return;
    }
    if (user) {
      setStep('verify');
      setEmail(user.email ?? '');
    }
  }, [loading, user, claims.tenantId, router]);

  // Paso 1: crear cuenta + enviar verificación.
  const onCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (businessName.trim().length < 2 || businessName.trim().length > 60) {
      setError('El nombre de la empresa debe tener entre 2 y 60 caracteres.');
      return;
    }
    setSubmitting(true);
    try {
      const cred = await createUserWithEmailAndPassword(firebaseAuth(), email.trim(), password);
      await sendEmailVerification(cred.user);
      setStep('verify');
      setInfo('Te enviamos un correo para verificar tu email.');
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onResend = async () => {
    setError(null);
    setInfo(null);
    const u = firebaseAuth().currentUser;
    if (!u) return;
    try {
      await sendEmailVerification(u);
      setInfo('Te reenviamos el correo de verificación.');
    } catch {
      setError('No pudimos reenviar el correo. Esperá unos minutos e intentá de nuevo.');
    }
  };

  // Paso 2: confirmar verificación y crear la empresa.
  const onCreateCompany = async () => {
    setError(null);
    setInfo(null);
    if (businessName.trim().length < 2 || businessName.trim().length > 60) {
      setError('El nombre de la empresa debe tener entre 2 y 60 caracteres.');
      return;
    }
    const u = firebaseAuth().currentUser;
    if (!u) {
      setError('Tu sesión expiró. Volvé a ingresar.');
      return;
    }
    setSubmitting(true);
    try {
      await reload(u);
      await u.getIdToken(true); // refrescar el token para que email_verified llegue al backend
      if (!u.emailVerified) {
        setError('Tu email todavía no figura como verificado. Tocá el enlace del correo y reintentá.');
        return;
      }
      // NO enviamos role/tenantId/planId/ownerUid/ownerEmail — los fija el backend.
      await registerTenantOwner({
        businessName: businessName.trim(),
        ownerName: ownerName.trim() || undefined,
        phone: phone.trim() || undefined,
        country,
        currency,
      });
      await waitForTenantClaim(); // refresca claims { tenantId, role } tras el alta
      router.replace('/welcome');
    } catch (err) {
      setError(friendlyRegisterError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center text-ink-400">Cargando…</main>;
  }

  return (
    <main className="flex min-h-screen flex-col bg-white">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <Link href="/login" className="text-sm font-medium text-ink-500 transition-colors hover:text-ink-800">
          Ya tengo cuenta
        </Link>
      </header>

      <section className="flex flex-1 items-start justify-center px-5 py-6 sm:items-center">
        <div className="w-full max-w-md">
          <div className="mb-7">
            <h1 className="text-2xl font-bold tracking-tight text-ink-900">
              {step === 'collect' ? 'Creá tu empresa' : 'Verificá tu email'}
            </h1>
            <p className="mt-1 text-sm text-ink-500">
              {step === 'collect'
                ? 'Una cuenta y tu empresa, en un solo paso. Empezás gratis.'
                : 'Confirmá tu email para activar tu empresa. Es una sola vez.'}
            </p>
          </div>

          {step === 'collect' ? (
            <form onSubmit={onCreateAccount} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="businessName" className="mb-1.5 block text-sm font-medium text-ink-700">
                    Nombre de la empresa
                  </label>
                  <input id="businessName" required value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputCls} placeholder="Mi Tienda" />
                </div>
                <div>
                  <label htmlFor="ownerName" className="mb-1.5 block text-sm font-medium text-ink-700">
                    Tu nombre
                  </label>
                  <input id="ownerName" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} className={inputCls} placeholder="Ana" autoComplete="name" />
                </div>
                <div>
                  <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-ink-700">
                    Teléfono <span className="text-ink-300">(opcional)</span>
                  </label>
                  <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} placeholder="+595…" autoComplete="tel" />
                </div>
                <div>
                  <label htmlFor="country" className="mb-1.5 block text-sm font-medium text-ink-700">
                    País
                  </label>
                  <select id="country" value={country} onChange={(e) => setCountry(e.target.value)} className={inputCls}>
                    {COUNTRY.map((c) => (
                      <option key={c} value={c}>{COUNTRY_LABEL[c] ?? c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="currency" className="mb-1.5 block text-sm font-medium text-ink-700">
                    Moneda
                  </label>
                  <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls}>
                    {CURRENCY.map((c) => (
                      <option key={c} value={c}>{CURRENCY_LABEL[c] ?? c}</option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink-700">
                    Email
                  </label>
                  <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="tu@email.com" autoComplete="email" />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink-700">
                    Contraseña
                  </label>
                  <input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} placeholder="Mínimo 6 caracteres" autoComplete="new-password" />
                </div>
              </div>

              {error && <p className="rounded-xl bg-coral-50 px-3.5 py-2.5 text-sm text-coral-700 ring-1 ring-inset ring-coral-100">{error}</p>}

              <button type="submit" disabled={submitting} className="inline-flex h-11 w-full items-center justify-center rounded-full bg-mint-brand text-sm font-semibold text-white shadow-glow transition hover:brightness-105 disabled:opacity-60">
                {submitting ? 'Creando tu cuenta…' : 'Crear cuenta y continuar'}
              </button>
            </form>
          ) : (
            <div className="space-y-5">
              <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-4 text-sm text-ink-600">
                Te enviamos un correo a <span className="font-semibold text-ink-800">{email || user?.email}</span>. Abrí el
                enlace para verificar y volvé acá.
                <p className="mt-2 text-xs text-ink-500">
                  Si no ves el correo, revisá Spam, Promociones o Correo no deseado. A veces puede tardar unos minutos.
                </p>
                {isEmulator && (
                  <p className="mt-2 text-xs text-ink-500">
                    Emulador: abrí el enlace desde la consola de Auth en{' '}
                    <a href="http://localhost:4000/auth" target="_blank" rel="noreferrer" className="font-mono text-mint-700 underline">
                      localhost:4000/auth
                    </a>
                    .
                  </p>
                )}
              </div>

              {/* Datos de empresa (editables; necesarios al reanudar un registro sin empresa). */}
              <div className="space-y-3">
                <div>
                  <label htmlFor="businessName2" className="mb-1.5 block text-sm font-medium text-ink-700">
                    Nombre de la empresa
                  </label>
                  <input id="businessName2" required value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputCls} placeholder="Mi Tienda" />
                </div>
              </div>

              {error && <p className="rounded-xl bg-coral-50 px-3.5 py-2.5 text-sm text-coral-700 ring-1 ring-inset ring-coral-100">{error}</p>}
              {info && <p className="rounded-xl bg-mint-50 px-3.5 py-2.5 text-sm text-mint-700 ring-1 ring-inset ring-mint-100">{info}</p>}

              <button onClick={onCreateCompany} disabled={submitting} className="inline-flex h-11 w-full items-center justify-center rounded-full bg-mint-brand text-sm font-semibold text-white shadow-glow transition hover:brightness-105 disabled:opacity-60">
                {submitting ? 'Creando tu empresa…' : 'Ya verifiqué mi email — crear empresa'}
              </button>
              <button onClick={onResend} disabled={submitting} className="inline-flex h-10 w-full items-center justify-center text-sm font-medium text-ink-500 transition hover:text-ink-800 disabled:opacity-60">
                Reenviar correo de verificación
              </button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
