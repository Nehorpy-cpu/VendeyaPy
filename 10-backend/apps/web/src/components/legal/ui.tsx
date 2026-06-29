/**
 * Primitivas de las páginas legales públicas (/privacy, /terms, /data-deletion).
 * Sin estado: server components. Estilo alineado al sitio de marketing.
 */
import Link from 'next/link';
import { ArrowRightIcon } from '@/components/marketing/icons';

/** Fecha de vigencia de los documentos legales (manual; actualizar al revisar). */
export const LEGAL_LAST_UPDATED = 'junio de 2026';
/** Contacto de soporte para consultas y solicitudes de datos. */
export const LEGAL_CONTACT_EMAIL = 'soporte@vendeyapy.com';

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="mk-container max-w-3xl py-12 sm:py-16">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm font-medium text-ink-500 transition-colors hover:text-ink-800"
      >
        <ArrowRightIcon className="h-4 w-4 rotate-180" />
        Volver al inicio
      </Link>

      <h1 className="mt-6 text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-ink-400">Última actualización: {LEGAL_LAST_UPDATED}</p>

      <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        ⚠️ <strong>Versión inicial.</strong> Este documento es una base para cumplir requisitos de las
        plataformas (Meta/WhatsApp) y <strong>debe ser revisado por un profesional legal</strong> antes de un
        lanzamiento masivo. No constituye asesoramiento legal.
      </div>

      {intro && <p className="mt-6 text-[0.95rem] leading-relaxed text-ink-600">{intro}</p>}

      <div className="mt-8 space-y-9">{children}</div>

      <ContactNote />
    </main>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[0.95rem] leading-relaxed text-ink-600">{children}</p>;
}

export function UL({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-[0.95rem] leading-relaxed text-ink-600">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

export function ContactNote() {
  return (
    <div className="mt-10 rounded-2xl border border-ink-100 bg-ink-50/50 px-5 py-4 text-sm text-ink-600">
      <p className="font-semibold text-ink-800">Contacto de soporte</p>
      <p className="mt-1">
        Para consultas o solicitudes sobre tus datos, escribinos a{' '}
        <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="font-medium text-mint-700 hover:text-mint-800">
          {LEGAL_CONTACT_EMAIL}
        </a>{' '}
        o por nuestro canal de WhatsApp de soporte.
      </p>
    </div>
  );
}
