/**
 * Fondo del hero: red de nodos y conexiones sutiles sobre blanco (sin orbs ni blobs).
 * SVG puro y decorativo (aria-hidden). Algunos nodos laten muy suave (animate-pulse-soft).
 * Pensado para verse premium pero discreto; respeta prefers-reduced-motion vía globals.css.
 */
import { cn } from '@/lib/cn';

// Coordenadas en un viewBox 1200x620. Dos "constelaciones" (izq/der) para enmarcar el contenido.
const NODES: { x: number; y: number; r: number; accent?: boolean; pulse?: boolean }[] = [
  { x: 70, y: 110, r: 3, pulse: true },
  { x: 250, y: 66, r: 2.4 },
  { x: 430, y: 150, r: 3.2, accent: true },
  { x: 150, y: 250, r: 2.4 },
  { x: 340, y: 330, r: 3, pulse: true },
  { x: 80, y: 430, r: 2.4 },
  { x: 300, y: 470, r: 2.8 },
  { x: 520, y: 410, r: 2.4, accent: true },
  { x: 1130, y: 80, r: 3, pulse: true },
  { x: 970, y: 160, r: 2.6, accent: true },
  { x: 1085, y: 280, r: 2.4 },
  { x: 880, y: 360, r: 2.8 },
  { x: 1140, y: 470, r: 3.2, pulse: true },
  { x: 760, y: 150, r: 2.4 },
  { x: 700, y: 500, r: 2.8, accent: true },
];

const LINKS: [number, number][] = [
  [0, 1], [1, 2], [0, 3], [3, 4], [2, 4], [3, 5], [4, 6], [5, 6], [6, 7], [4, 7],
  [8, 9], [9, 10], [10, 11], [8, 13], [10, 12], [11, 12], [13, 2], [11, 14], [14, 7],
];

export function HeroBackground({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1200 620"
      className={cn('h-full w-full', className)}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g stroke="#9bb1d1" strokeOpacity="0.35" strokeWidth="1">
        {LINKS.map(([a, b], i) => (
          <line key={i} x1={NODES[a]!.x} y1={NODES[a]!.y} x2={NODES[b]!.x} y2={NODES[b]!.y} />
        ))}
      </g>
      {NODES.map((n, i) => (
        <g key={i}>
          {n.pulse && (
            <circle cx={n.x} cy={n.y} r={n.r * 3.2} fill={n.accent ? '#34d399' : '#6483b0'} opacity="0.12" className="animate-pulse-soft" />
          )}
          <circle cx={n.x} cy={n.y} r={n.r} fill={n.accent ? '#34d399' : '#9bb1d1'} opacity={n.accent ? 0.9 : 0.6} />
        </g>
      ))}
    </svg>
  );
}
