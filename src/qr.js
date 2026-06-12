import QRCode from 'qrcode';
import { env } from './config.js';

// El QR codifica la URL del ticket. Al escanearlo con cualquier cámara,
// abre la página del boleto; el escáner del panel extrae el token.
export function ticketUrl(t) {
  return `${env.BASE_URL}/t/${t}`;
}

export async function qrDataUrl(t) {
  return QRCode.toDataURL(ticketUrl(t), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#111111', light: '#ffffff' },
  });
}

// PNG buffer (para adjuntar en el correo)
export async function qrPngBuffer(t) {
  return QRCode.toBuffer(ticketUrl(t), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 480,
  });
}
