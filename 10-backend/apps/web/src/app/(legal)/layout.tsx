import { MarketingHeader } from '@/components/marketing/MarketingHeader';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';

/** Layout público de las páginas legales (sin login). Mismo header/footer que la landing. */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-ink-900">
      <MarketingHeader />
      {children}
      <MarketingFooter />
    </div>
  );
}
