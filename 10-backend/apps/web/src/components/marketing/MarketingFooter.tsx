/**
 * Footer del sitio público. Enlaces internos (anclas) + secundarios.
 */
import { Logo } from './ui';
import { WhatsappIcon, InstagramIcon, MessengerIcon } from './icons';

const COLUMNS = [
  {
    title: 'Producto',
    links: [
      { label: 'Qué resuelve', href: '#producto' },
      { label: 'Cómo funciona', href: '#como-funciona' },
      { label: 'Diferencial', href: '#diferencial' },
      { label: 'Planes', href: '#pricing' },
    ],
  },
  {
    title: 'Integraciones',
    links: [
      { label: 'WhatsApp Cloud API', href: '#producto' },
      { label: 'Meta Ads', href: '#producto' },
      { label: 'Instagram / Messenger (pronto)', href: '#producto' },
    ],
  },
  {
    title: 'Empresa',
    links: [
      { label: 'Agendar demo', href: '#demo' },
      { label: 'Entrar al panel', href: '/dashboard' },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-ink-100 bg-white">
      <div className="mk-container grid grid-cols-2 gap-8 py-12 sm:grid-cols-2 md:grid-cols-5">
        <div className="col-span-2 flex flex-col gap-4">
          <Logo />
          <p className="max-w-xs text-sm leading-relaxed text-ink-500">
            La plataforma que convierte tus conversaciones de WhatsApp en ventas y ganancia medible, con
            atribución de tus anuncios de Meta.
          </p>
          <div className="flex items-center gap-2">
            {[WhatsappIcon, InstagramIcon, MessengerIcon].map((Icon, i) => (
              <span
                key={i}
                className="grid h-9 w-9 place-items-center rounded-xl border border-ink-100 text-ink-500"
              >
                <Icon className="h-4 w-4" />
              </span>
            ))}
          </div>
        </div>

        {COLUMNS.map((col) => (
          <div key={col.title} className="flex flex-col gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-400">{col.title}</h4>
            <ul className="flex flex-col gap-2">
              {col.links.map((l) => (
                <li key={l.label}>
                  <a href={l.href} className="text-sm text-ink-600 transition-colors hover:text-mint-600">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-ink-100">
        <div className="mk-container flex flex-col items-center justify-between gap-2 py-5 text-xs text-ink-400 sm:flex-row">
          <span>© {new Date().getFullYear()} AI_AFG · Vendé por chat, medí la ganancia.</span>
          <span>Hecho en Paraguay 🇵🇾</span>
        </div>
      </div>
    </footer>
  );
}
