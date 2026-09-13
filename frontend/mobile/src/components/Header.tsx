import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useNav } from '../navigation';
import { useTheme } from './ui';

export function Header({ title, right }: { title: string; right?: React.ReactNode }) {
  const nav = useNav();
  const th = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 }}>
      {nav.canGoBack() && (
        <Pressable
          onPress={() => nav.goBack()}
          style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: th.card, borderWidth: 1, borderColor: th.border, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: th.text, fontSize: 18 }}>‹</Text>
        </Pressable>
      )}
      <Text style={{ flex: 1, fontSize: 22, fontWeight: '800', color: th.text }}>{title}</Text>
      {right}
    </View>
  );
}
