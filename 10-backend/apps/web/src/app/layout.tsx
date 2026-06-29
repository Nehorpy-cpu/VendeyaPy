import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'VendeYaPy — Panel',
  description: 'VendeYaPy — vendé más por WhatsApp, gestioná tu negocio y medí la ganancia real.',
  // Verificación de dominio de Meta/Facebook (estático en el <head>, no por JS).
  other: {
    'facebook-domain-verification': 'b80q6zumjnvq0lg6c3jo96124sqs3m',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body className="bg-ink-50 text-ink-900 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
