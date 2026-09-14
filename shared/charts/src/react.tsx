/**
 * React SVG renderer for chart scenes (web app and console). Text inherits `currentColor`, so the chart follows the
 * page theme; every mark with a tip gets a native tooltip and the scene summary is the accessible name.
 */
import type { Scene, Primitive } from './builders.ts';

export interface ChartProps {
  scene: Scene;
  /** CSS height; width is fluid. */
  height?: number | string;
  className?: string;
  /** Hide the legend below the drawing. */
  noLegend?: boolean;
}

function Mark({ it }: { it: Primitive }) {
  const tip = 'tip' in it && it.tip ? <title>{it.tip}</title> : null;
  switch (it.kind) {
    case 'rect':
      return (
        <rect x={it.x} y={it.y} width={it.w} height={it.h} fill={it.fill} rx={it.rx} opacity={it.opacity}>
          {tip}
        </rect>
      );
    case 'circle':
      return (
        <circle cx={it.cx} cy={it.cy} r={it.r} fill={it.fill} opacity={it.opacity} stroke={it.stroke}>
          {tip}
        </circle>
      );
    case 'path':
      return (
        <path d={it.d} stroke={it.stroke} fill={it.fill ?? 'none'} strokeWidth={it.width} opacity={it.opacity} strokeDasharray={it.dash} strokeLinejoin="round" strokeLinecap="round">
          {tip}
        </path>
      );
    case 'line':
      return <line x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke={it.stroke} strokeWidth={it.width} opacity={it.opacity} strokeDasharray={it.dash} />;
    case 'polygon':
      return (
        <polygon points={it.points.map((p) => p.join(',')).join(' ')} fill={it.fill ?? 'none'} stroke={it.stroke} strokeWidth={it.width} opacity={it.opacity}>
          {tip}
        </polygon>
      );
    case 'text':
      return (
        <text x={it.x} y={it.y} fontSize={it.size ?? 11} fill={it.fill ?? 'currentColor'} textAnchor={it.anchor} fontWeight={it.weight} opacity={it.opacity} dominantBaseline={it.baseline}>
          {it.text}
        </text>
      );
  }
}

export function Chart({ scene, height, className, noLegend }: ChartProps) {
  return (
    <figure className={className} style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${scene.width} ${scene.height}`} role="img" aria-label={scene.summary} style={{ width: '100%', height: height ?? 'auto', display: 'block', fontFamily: 'inherit' }}>
        {scene.items.map((it, i) => (
          <Mark key={('key' in it && it.key ? `${it.key}-` : '') + i} it={it} />
        ))}
      </svg>
      {!noLegend && scene.legend.length > 0 && (
        <figcaption style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12, marginTop: 6, opacity: 0.85 }}>
          {scene.legend.map((l) => (
            <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: l.color, display: 'inline-block' }} />
              {l.label}
              {l.value ? <span style={{ opacity: 0.7 }}>· {l.value}</span> : null}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
