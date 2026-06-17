import { redirect } from 'next/navigation';

export default function HomePage() {
  // El panel vive bajo /dashboard (protegido). Si no hay sesión, ese layout
  // redirige a /login.
  redirect('/dashboard');
}
