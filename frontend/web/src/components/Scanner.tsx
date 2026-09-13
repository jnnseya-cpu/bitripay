import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

/** Camera QR scanner built on html5-qrcode; falls back to file upload on devices without camera access. */
export function Scanner({ onScan, active = true }: { onScan: (text: string) => void; active?: boolean }) {
  const id = useRef(`scanner-${Math.random().toString(36).slice(2)}`);
  const instance = useRef<Html5Qrcode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (!active) return;
    handled.current = false;
    const scanner = new Html5Qrcode(id.current, { verbose: false });
    instance.current = scanner;
    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (text) => {
          if (handled.current) return;
          handled.current = true;
          onScan(text);
        },
        () => {},
      )
      .catch((err) => setError(typeof err === 'string' ? err : err?.message || 'Camera unavailable'));
    return () => {
      const s = instance.current;
      instance.current = null;
      if (s) {
        s.stop()
          .then(() => s.clear())
          .catch(() => {});
      }
    };
  }, [active, onScan]);

  return (
    <div>
      <div id={id.current} className="scanner" />
      {error && (
        <div className="alert warning mt">
          Camera unavailable ({error}). You can upload a QR image instead:
          <input
            type="file"
            accept="image/*"
            className="mt-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const s = new Html5Qrcode(id.current + '-file', { verbose: false });
                const text = await s.scanFile(file, false);
                onScan(text);
              } catch {
                setError('Could not read a QR code from that image');
              }
            }}
          />
          <div id={id.current + '-file'} className="hidden" />
        </div>
      )}
    </div>
  );
}
