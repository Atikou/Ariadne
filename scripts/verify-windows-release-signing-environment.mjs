import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const required = [
  'ARIADNE_APP_PUBLISHER_SHA256',
  'ARIADNE_SANDBOX_PUBLISHER_SHA256',
  'ARIADNE_SANDBOX_SIGNTOOL_PATH',
  'ARIADNE_SANDBOX_SIGN_CERT_SHA1',
  'ARIADNE_SANDBOX_TIMESTAMP_URL'
];

if (process.platform !== 'win32') {
  throw new Error('Windows release signing must run on Windows.');
}

const missing = required.filter((name) => !process.env[name]?.trim());
if (!process.env.WIN_CSC_LINK?.trim() && !process.env.CSC_LINK?.trim()) {
  missing.push('WIN_CSC_LINK or CSC_LINK');
}
if (!process.env.WIN_CSC_KEY_PASSWORD?.trim() && !process.env.CSC_KEY_PASSWORD?.trim()) {
  missing.push('WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD');
}
if (missing.length > 0) {
  throw new Error(`Windows release signing environment is incomplete: ${missing.join(', ')}`);
}
if (!/^[0-9a-f]{64}$/iu.test(process.env.ARIADNE_APP_PUBLISHER_SHA256.trim())) {
  throw new Error('ARIADNE_APP_PUBLISHER_SHA256 must be 64 hex characters.');
}
if (!/^[0-9a-f]{64}$/iu.test(process.env.ARIADNE_SANDBOX_PUBLISHER_SHA256.trim())) {
  throw new Error('ARIADNE_SANDBOX_PUBLISHER_SHA256 must be 64 hex characters.');
}
if (!/^[0-9a-f]{40}$/iu.test(process.env.ARIADNE_SANDBOX_SIGN_CERT_SHA1.trim())) {
  throw new Error('ARIADNE_SANDBOX_SIGN_CERT_SHA1 must be 40 hex characters.');
}
const signToolPath = process.env.ARIADNE_SANDBOX_SIGNTOOL_PATH.trim();
if (!path.isAbsolute(signToolPath) || !existsSync(signToolPath) || !statSync(signToolPath).isFile()) {
  throw new Error('ARIADNE_SANDBOX_SIGNTOOL_PATH must name an existing absolute file.');
}
let timestampUrl;
try {
  timestampUrl = new URL(process.env.ARIADNE_SANDBOX_TIMESTAMP_URL.trim());
} catch {
  throw new Error('ARIADNE_SANDBOX_TIMESTAMP_URL must be an HTTPS URL.');
}
if (timestampUrl.protocol !== 'https:') {
  throw new Error('ARIADNE_SANDBOX_TIMESTAMP_URL must be an HTTPS URL.');
}

console.log('windows-release: signing environment is present');
