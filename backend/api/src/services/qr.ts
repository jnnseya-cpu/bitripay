import QRCode from 'qrcode';
import { encodeQr, encodeQrLink, decodeQr, type QrPayload } from '@bitripay/shared';
import { config } from '../config';

export async function qrDataUrl(content: string): Promise<string> {
  return QRCode.toDataURL(content, { errorCorrectionLevel: 'M', margin: 1, width: 320, color: { dark: '#0f172a', light: '#ffffff' } });
}

export async function qrSvg(content: string): Promise<string> {
  return QRCode.toString(content, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
}

export function qrContent(payload: QrPayload): { native: string; link: string } {
  return { native: encodeQr(payload), link: encodeQrLink(payload, config.webUrl) };
}

export { decodeQr };
