import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'VendeYaPy — Panel',
  description: 'VendeYaPy — vendé más por WhatsApp, gestioná tu negocio y medí la ganancia real.',
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
