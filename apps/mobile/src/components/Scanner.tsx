import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, useTheme } from './ui';

/** Full-bleed camera QR scanner. Calls onScan once per mount with the decoded text. */
export function Scanner({ onScan, active = true }: { onScan: (data: string) => void; active?: boolean }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);
  const th = useTheme();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    handled.current = false;
  }, [active]);
  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={{ padding: 20, alignItems: 'center', gap: 12 }}>
        <Text style={{ color: th.text, textAlign: 'center' }}>BitriPay needs camera access to scan QR codes.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
      </View>
    );
  }
  return (
    <View style={{ borderRadius: 20, overflow: 'hidden', aspectRatio: 1, backgroundColor: '#000' }}>
      {active && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          onCameraReady={() => setReady(true)}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current || !data) return;
            handled.current = true;
            onScan(data);
          }}
        />
      )}
      <View pointerEvents="none" style={{ ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: '65%', aspectRatio: 1, borderWidth: 3, borderColor: ready ? '#22c55e' : '#fff', borderRadius: 20 }} />
      </View>
    </View>
  );
}
