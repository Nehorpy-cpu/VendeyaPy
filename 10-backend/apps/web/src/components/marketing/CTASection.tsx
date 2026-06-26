/**
 * Banda final de conversión. Fondo oscuro con gradiente + grilla sutil.
 * CTA primaria = "Probar gratis" → /register (trial autoservicio); secundaria = agendar demo por WhatsApp.
 */
import { cn } from '@/lib/cn';
import { Button, Eyebrow } from './ui';
import { WhatsappIcon, CheckIcon } from './icons';

export function CTASection({
  id = 'demo',
  registerHref = '/register',
  whatsappHref = 'https://wa.me/595993083000?text=Hola%20VendeYaPy%2C%20quiero%20agendar%20una%20demo',
  className,
}: {
  id?: string;
  registerHref?: string;
  whatsappHref?: string;
  className?: string;
}) {
  return (
    <section id={id} className={cn('mk-container scroll-mt-24', className)}>
      <div className="relative overflow-hidden rounded-3xl bg-ink-deep px-6 py-14 sm:px-12 sm:py-16">
        <div className="bg-grid-dark absolute inset-0 opacity-60" aria-hidden />
        <div
          className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-mint-brand opacity-25 blur-3xl"
          aria-hidden
        />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center text-center">
          <Eyebrow tone="dark">Empezá hoy</Eyebrow>
          <h2 className="mt-5 text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Convertí tus conversaciones en{' '}
            <span className="text-gradient">ganancia medible</span>
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-200 sm:text-lg">
            Probá gratis 7 días, o agendá una demo de 20 minutos para verlo con tus propios números.
            Sin compromiso.
          </p>
          <div className="mt-8 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
            <Button href={registerHref} variant="primary" size="lg" withArrow className="w-full sm:w-auto">
              Probar gratis
            </Button>
            <Button href={whatsappHref} variant="white" size="lg" target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto">
              <WhatsappIcon className="h-5 w-5" />
              Agendar demo por WhatsApp
            </Button>
          </div>
          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-ink-200">
            {['Implementación guiada', 'Datos de tu negocio', 'Cancelás cuando quieras'].map((t) => (
              <li key={t} className="inline-flex items-center gap-1.5">
                <CheckIcon className="h-4 w-4 text-mint-300" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
