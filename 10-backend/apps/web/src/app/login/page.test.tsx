import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from './page';

// En happy-dom, click en un <button type="submit"> no dispara el submit del form → lo hacemos directo.
const submitResetForm = () => fireEvent.submit(screen.getByLabelText(/email/i).closest('form') as HTMLFormElement);

const replace = vi.fn();
const sendPasswordResetEmail = vi.fn();
const signInWithEmailAndPassword = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('next/link', () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock('@/lib/firebase', () => ({ firebaseAuth: () => ({}) }));
vi.mock('firebase/auth', () => ({
  sendPasswordResetEmail: (...a: unknown[]) => sendPasswordResetEmail(...a),
  signInWithEmailAndPassword: (...a: unknown[]) => signInWithEmailAndPassword(...a),
}));
// Stubs de los componentes de marketing (evita cadenas de import pesadas / animación).
vi.mock('@/components/marketing/ui', () => ({ Logo: () => <div /> }));
vi.mock('@/components/marketing/MetricCard', () => ({ MetricCard: () => <div /> }));
vi.mock('@/components/marketing/AnimatedChart', () => ({ AnimatedChart: () => <div /> }));
vi.mock('@/components/marketing/icons', () => ({
  ArrowRightIcon: () => <svg />, TrendingIcon: () => <svg />, BagIcon: () => <svg />,
  CheckIcon: () => <svg />, ChatIcon: () => <svg />, ShieldIcon: () => <svg />,
}));

describe('LoginPage — recuperación de contraseña', () => {
  beforeEach(() => { replace.mockClear(); sendPasswordResetEmail.mockReset(); signInWithEmailAndPassword.mockReset(); });

  it('(a→e) login renderiza → abrir reset → email válido → mensaje genérico → volver', async () => {
    render(<LoginPage />);
    // a) /login normal
    expect(screen.getByRole('heading', { name: /entrá a tu panel/i })).toBeInTheDocument();
    // b) click "¿Olvidaste tu contraseña?"
    fireEvent.click(screen.getByRole('button', { name: /olvidaste tu contraseña/i }));
    expect(screen.getByRole('heading', { name: /recuperar contraseña/i })).toBeInTheDocument();
    // c) email válido + d) submit → mensaje genérico
    sendPasswordResetEmail.mockResolvedValueOnce(undefined);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@test.com' } });
    submitResetForm();
    await waitFor(() => expect(screen.getByText(/si existe una cuenta con ese correo/i)).toBeInTheDocument());
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(expect.anything(), 'user@test.com');
    // e) volver a login
    fireEvent.click(screen.getByRole('button', { name: /volver a iniciar sesión/i }));
    expect(screen.getByRole('heading', { name: /entrá a tu panel/i })).toBeInTheDocument();
  });

  it('email inexistente → MISMO mensaje genérico (no revela existencia)', async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /olvidaste tu contraseña/i }));
    sendPasswordResetEmail.mockRejectedValueOnce({ code: 'auth/user-not-found' });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ghost@test.com' } });
    submitResetForm();
    await waitFor(() => expect(screen.getByText(/si existe una cuenta con ese correo/i)).toBeInTheDocument());
  });

  it('email inválido → error de validación y NO llama a Firebase', () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /olvidaste tu contraseña/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'no-es-email' } });
    submitResetForm();
    expect(screen.getByText(/ingresá un email válido/i)).toBeInTheDocument();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('too-many-requests → error amigable específico', async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /olvidaste tu contraseña/i }));
    sendPasswordResetEmail.mockRejectedValueOnce({ code: 'auth/too-many-requests' });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@test.com' } });
    submitResetForm();
    await waitFor(() => expect(screen.getByText(/demasiados intentos/i)).toBeInTheDocument());
  });
});
