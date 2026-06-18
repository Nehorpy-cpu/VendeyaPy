/**
 * Gráfica de área + línea en SVG puro, responsive y con animación de "dibujado"
 * (stroke-dashoffset). Sin librerías. Pensada para datos demo de marketing.
 */
import { cn } from '@/lib/cn';

interface AnimatedChartProps {
  /** Valores de la serie principal (la línea/área). */
  data: number[];
  /** Barras de fondo opcionales (misma cantidad de puntos). */
  bars?: number[];
  labels?: string[];
  /** Id único para los gradientes (evita colisiones con varias gráficas). */
  id?: string;
  className?: string;
  tone?: 'light' | 'dark';
}

const W = 640;
const H = 260;
const PAD = { top: 18, right: 14, bottom: 30, left: 14 };

function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  const k = 0.9;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + ((p2.x - p0.x) / 6) * k;
    const cp1y = p1.y + ((p2.y - p0.y) / 6) * k;
    const cp2x = p2.x - ((p3.x - p1.x) / 6) * k;
    const cp2y = p2.y - ((p3.y - p1.y) / 6) * k;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

export function AnimatedChart({
  data,
  bars,
  labels,
  id = 'chart',
  className,
  tone = 'dark',
}: AnimatedChartProps) {
  const n = data.length;
  if (n === 0) return null;
  const min = Math.min(...data) * 0.82;
  const max = Math.max(...data) * 1.06;
  const span = max - min || 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const xAt = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const yAt = (v: number) => PAD.top + innerH - ((v - min) / span) * innerH;

  const points = data.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
  const line = smoothPath(points);
  const area = `${line} L ${points[n - 1]!.x} ${PAD.top + innerH} L ${points[0]!.x} ${PAD.top + innerH} Z`;

  const barMax = bars ? Math.max(...bars) * 1.1 : 1;
  const grid = [0.25, 0.5, 0.75];

  const stroke = tone === 'dark' ? '#34d399' : '#059669';
  const gridColor = tone === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(13,23,44,0.08)';
  const labelColor = tone === 'dark' ? 'rgba(226,236,250,0.55)' : 'rgba(13,23,44,0.45)';

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={cn('h-full w-full', className)}
      preserveAspectRatio="none"
      role="img"
      aria-label="Tendencia de ganancia"
    >
      <defs>
        <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.38" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="60%" stopColor="#22c55e" />
          <stop offset="100%" stopColor="#34d399" />
        </linearGradient>
      </defs>

      {/* Grilla horizontal */}
      {grid.map((g) => {
        const y = PAD.top + innerH * g;
        return <line key={g} x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke={gridColor} strokeWidth={1} />;
      })}

      {/* Barras de fondo (volumen) */}
      {bars &&
        bars.map((b, i) => {
          const bw = (innerW / n) * 0.4;
          const x = xAt(i) - bw / 2;
          const h = (b / barMax) * innerH * 0.7;
          const y = PAD.top + innerH - h;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={bw}
              height={h}
              rx={3}
              fill={tone === 'dark' ? 'rgba(99,131,176,0.28)' : 'rgba(43,69,112,0.12)'}
            />
          );
        })}

      {/* Área */}
      <path d={area} fill={`url(#${id}-area)`} className="animate-fade-up" />

      {/* Línea con animación de dibujado */}
      <path
        d={line}
        fill="none"
        stroke={`url(#${id}-line)`}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        className="[stroke-dasharray:1] animate-draw"
      />

      {/* Punto final destacado */}
      <circle cx={points[n - 1]!.x} cy={points[n - 1]!.y} r={5.5} fill={stroke} />
      <circle cx={points[n - 1]!.x} cy={points[n - 1]!.y} r={10} fill={stroke} opacity={0.18} className="animate-pulse-soft" />

      {/* Etiquetas del eje X */}
      {labels &&
        labels.map((l, i) => (
          <text key={i} x={xAt(i)} y={H - 8} fontSize="12" textAnchor="middle" fill={labelColor}>
            {l}
          </text>
        ))}
    </svg>
  );
}
