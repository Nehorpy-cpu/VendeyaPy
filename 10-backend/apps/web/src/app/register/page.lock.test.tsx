/**
 * page.lock.test.tsx — SINGLE-TENANT-LOCK en /register y el CTA del login.
 * Flag NEXT_PUBLIC_ALLOW_SELF_REGISTRATION='false' → aviso "Registro por invitación"
 * (sin formulario); default → el flujo de registro renderiza normal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import RegisterPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: null, claims: {}, loading: false }) }));
vi.mock('@/lib/firebase', () => ({ firebaseAuth: () => ({}) }));
vi.mock('firebase/auth', () => ({ createUserWithEmailAndPassword: vi.fn(), sendEmailVerification: vi.fn(), reload: vi.fn() }));
vi.mock('@/components/marketing/ui', () => ({ Logo: () => <div /> }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/register con SINGLE-TENANT-LOCK', () => {
  it('flag en "false" → aviso "Registro por invitación", SIN formulario de alta', () => {
    vi.stubEnv('NEXT_PUBLIC_ALLOW_SELF_REGISTRATION', 'false');
    render(<RegisterPage />);
    expect(screen.getByRole('heading', { name: /registro por invitación/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /iniciar sesión/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument(); // sin form
    expect(document.querySelector('input[type=password]')).toBeNull();
  });

  it('default (var ausente) → el flujo de registro renderiza normal', () => {
    render(<RegisterPage />);
    expect(screen.queryByRole('heading', { name: /registro por invitación/i })).not.toBeInTheDocument();
    expect(document.querySelector('input[type=password]')).not.toBeNull(); // form visible
  });
});
