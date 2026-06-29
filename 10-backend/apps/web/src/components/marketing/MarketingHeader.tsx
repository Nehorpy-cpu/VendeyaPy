'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { Logo, Button } from './ui';
import { MenuIcon, CloseIcon } from './icons';

const NAV_LINKS = [
  { label: 'Producto', href: '/#producto' },
  { label: 'Diferencial', href: '/#diferencial' },
  { label: 'Cómo funciona', href: '/#como-funciona' },
  { label: 'Planes', href: '/#pricing' },
  { label: 'Demo', href: '/#demo' },
];

export function MarketingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Cierra el menú mobile al pasar a desktop.
  useEffect(() => {
    if (!open) return;
    const onResize = () => window.innerWidth >= 1024 && setOpen(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  return (
    <header
      className={cn(
        'sticky top-0 z-50 transition-all duration-300',
        scrolled || open
          ? 'border-b border-ink-100 bg-white/85 backdrop-blur-md'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <div className="mk-container flex h-16 items-center justify-between gap-4">
        <Logo />

        <nav className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-full px-3 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-900"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <Button href="/dashboard" variant="ghost" size="sm">
            Entrar al panel
          </Button>
          <Button href="/register" variant="primary" size="sm" withArrow>
            Probar gratis
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={open}
          className="grid h-10 w-10 place-items-center rounded-xl text-ink-700 hover:bg-ink-50 lg:hidden"
        >
          {open ? <CloseIcon className="h-6 w-6" /> : <MenuIcon className="h-6 w-6" />}
        </button>
      </div>

      {/* Menú mobile */}
      {open && (
        <div className="border-t border-ink-100 bg-white lg:hidden">
          <nav className="mk-container flex flex-col gap-1 py-4">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-xl px-3 py-2.5 text-base font-medium text-ink-700 hover:bg-ink-50"
              >
                {l.label}
              </a>
            ))}
            <div className="mt-3 flex flex-col gap-2">
              <Button href="/dashboard" variant="secondary" size="md" className="w-full">
                Entrar al panel
              </Button>
              <Button href="/register" variant="primary" size="md" className="w-full" withArrow>
                Probar gratis
              </Button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
