import { session, type Session } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export const RENDERER_PARTITION = 'persist:ariadne-renderer';
export const PACKAGED_RENDERER_ORIGIN = 'https://ariadne.local';

export interface RendererSourceOptions {
  allowDevelopmentServer: boolean;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

export class RendererSource {
  private protocolSession: Session | null = null;

  constructor(
    private readonly rendererRoot: string,
    private readonly options: RendererSourceOptions
  ) {}

  start(): string {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (developmentUrl) {
      return resolveDevelopmentRendererUrl(developmentUrl, this.options.allowDevelopmentServer);
    }

    const rendererRoot = resolve(this.rendererRoot);
    const protocolSession = session.fromPartition(RENDERER_PARTITION);
    protocolSession.protocol.handle('https', async (request) => {
      const requestUrl = new URL(request.url);
      if (requestUrl.origin !== PACKAGED_RENDERER_ORIGIN) {
        return response('Forbidden', 403, 'text/plain; charset=utf-8');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return response('Method Not Allowed', 405, 'text/plain; charset=utf-8');
      }

      const filePath = resolveRendererFile(rendererRoot, requestUrl.pathname);
      if (!filePath) return response('Not Found', 404, 'text/plain; charset=utf-8');

      try {
        const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        const body = request.method === 'HEAD' ? null : Uint8Array.from(await readFile(filePath));
        return new Response(body, {
          status: 200,
          headers: securityHeaders(contentType)
        });
      } catch {
        return response('Not Found', 404, 'text/plain; charset=utf-8');
      }
    });
    this.protocolSession = protocolSession;
    return `${PACKAGED_RENDERER_ORIGIN}/index.html`;
  }

  stop(): void {
    if (!this.protocolSession) return;
    this.protocolSession.protocol.unhandle('https');
    this.protocolSession = null;
  }
}

export function resolveRendererFile(rendererRoot: string, pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  if (!relativePath || relativePath.includes('\0')) return null;

  const root = resolve(rendererRoot);
  const filePath = resolve(root, relativePath);
  const pathFromRoot = relative(root, filePath);
  if (pathFromRoot === '' || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) return null;
  return filePath;
}

export function resolveDevelopmentRendererUrl(value: string, allowed: boolean): string {
  if (!allowed) throw new Error('ELECTRON_RENDERER_URL is disabled in packaged builds.');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ELECTRON_RENDERER_URL must use http or https.');
  }
  if (url.username || url.password) {
    throw new Error('ELECTRON_RENDERER_URL must not contain credentials.');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('ELECTRON_RENDERER_URL must target a loopback development server.');
  }
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}

function securityHeaders(contentType: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });
}

function response(body: string, status: number, contentType: string): Response {
  return new Response(body, {
    status,
    headers: securityHeaders(contentType)
  });
}
