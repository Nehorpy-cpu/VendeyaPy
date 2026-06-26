/**
 * BrandMark — isotipo de VendeYaPy: monograma V/Y/P en un círculo (navy + mint).
 *   V = Vendé (ventas/crecimiento) · Y = Ya (acción/automatización) · P = Py (Paraguay).
 * SVG vectorial liviano y escalable; se ve bien en fondo claro u oscuro (va dentro de un
 * contenedor navy en el Logo/Sidebar). Reutilizado en logo, sidebar y favicon (DRY).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="vyp-ring" x1="5" y1="3" x2="27" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6ee7b7" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
        <linearGradient id="vyp-grn" x1="9" y1="9" x2="23" y2="25" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4ade80" />
          <stop offset="1" stopColor="#10b981" />
        </linearGradient>
      </defs>
      {/* Anillo */}
      <circle cx="16" cy="16" r="13" stroke="url(#vyp-ring)" strokeWidth="2.1" />
      {/* V (arriba) */}
      <path d="M8.8 10.8 16 17.6 23.2 10.8" stroke="url(#vyp-grn)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {/* Y (tronco, en blanco) */}
      <path d="M16 16.8 16 24.4" stroke="#ffffff" strokeWidth="3.1" strokeLinecap="round" />
      {/* P (abajo-derecha) */}
      <path d="M19.8 18.6 19.8 24.4 M19.8 18.6 H22.1 A2.05 2.05 0 0 1 22.1 22.7 H19.8" stroke="url(#vyp-grn)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
