import crypto from 'crypto';
import { config, loadPrivateKey } from './config';

let cachedPrivateKey: string | null = null;

function getPrivateKey(): string {
  if (!cachedPrivateKey) {
    cachedPrivateKey = loadPrivateKey();
  }
  return cachedPrivateKey;
}

export function signRequest(
  method: string,
  path: string,
  body: string = ''
): { signature: string; timestamp: string } {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path + body;

  const privateKey = getPrivateKey();
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(message),
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }
  );

  return {
    signature: signature.toString('base64'),
    timestamp,
  };
}

export function getAuthHeaders(
  method: string,
  path: string,
  body: string = ''
): Record<string, string> {
  const { signature, timestamp } = signRequest(method, path, body);

  return {
    'KALSHI-ACCESS-KEY': config.kalshi.apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json',
  };
}
