import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Rect, Circle, Path, Line, Polygon, Text as SvgText } from 'react-native-svg';
import type { Scene, Primitive } from '@bitripay/charts';
import { useTheme } from './ui';

/** react-native-svg renderer for chart scenes: the same geometry the web and the console draw, with theme text colour. */
function Mark({ it, text }: { it: Primitive; text: string }) {
  const fill = (f?: string) => (f === 'currentColor' || f === undefined ? text : f);
  switch (it.kind) {
    case 'rect':
      return <Rect x={it.x} y={it.y} width={it.w} height={it.h} fill={fill(it.fill)} rx={it.rx} opacity={it.opacity ?? 1} />;
    case 'circle':
      return <Circle cx={it.cx} cy={it.cy} r={it.r} fill={fill(it.fill)} opacity={it.opacity ?? 1} stroke={it.stroke ? fill(it.stroke) : undefined} />;
    case 'path':
      return (
        <Path
          d={it.d}
          stroke={it.stroke ? fill(it.stroke) : undefined}
          fill={it.fill && it.fill !== 'none' ? fill(it.fill) : 'none'}
          strokeWidth={it.width}
          opacity={it.opacity ?? 1}
          strokeDasharray={it.dash}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      );
    case 'line':
      return <Line x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke={fill(it.stroke)} strokeWidth={it.width ?? 1} opacity={it.opacity ?? 1} strokeDasharray={it.dash} />;
    case 'polygon':
      return (
        <Polygon
          points={it.points.map((p) => p.join(',')).join(' ')}
          fill={it.fill && it.fill !== 'none' ? fill(it.fill) : 'none'}
          stroke={it.stroke ? fill(it.stroke) : undefined}
          strokeWidth={it.width}
          opacity={it.opacity ?? 1}
        />
      );
    case 'text':
      return (
        <SvgText
          x={it.x}
          y={it.y}
          fontSize={it.size ?? 11}
          fill={fill(it.fill)}
          textAnchor={it.anchor ?? 'start'}
          fontWeight={it.weight ? String(it.weight) : undefined}
          opacity={it.opacity ?? 1}
          alignmentBaseline={it.baseline === 'middle' ? 'middle' : it.baseline === 'hanging' ? 'hanging' : undefined}
        >
          {it.text}
        </SvgText>
      );
  }
}

export function Chart({ scene, width }: { scene: Scene; width: number }) {
  const th = useTheme();
  const height = (scene.height / scene.width) * width;
  return (
    <View accessible accessibilityLabel={scene.summary}>
      <Svg width={width} height={height} viewBox={`0 0 ${scene.width} ${scene.height}`}>
        {scene.items.map((it, i) => (
          <Mark key={i} it={it} text={th.text} />
        ))}
      </Svg>
      {scene.legend.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
          {scene.legend.map((l) => (
            <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: l.color }} />
              <Text style={{ color: th.text, fontSize: 12 }}>
                {l.label}
                {l.value ? <Text style={{ color: th.muted }}> · {l.value}</Text> : null}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
