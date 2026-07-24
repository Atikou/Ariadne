import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveDevelopmentRendererUrl,
  resolveRendererFile
} from '../src/main/windows/renderer-source';

describe('packaged renderer source', () => {
  const root = resolve('out/renderer');

  it('maps only files inside the packaged renderer directory', () => {
    expect(resolveRendererFile(root, '/')).toBe(resolve(root, 'index.html'));
    expect(resolveRendererFile(root, '/assets/app.js')).toBe(resolve(root, 'assets/app.js'));
    expect(resolveRendererFile(root, '/../main/index.js')).toBeNull();
    expect(resolveRendererFile(root, '/%2e%2e/main/index.js')).toBeNull();
  });

  it('accepts only loopback development servers in unpackaged builds', () => {
    expect(resolveDevelopmentRendererUrl('http://localhost:5173', true)).toBe('http://localhost:5173/');
    expect(resolveDevelopmentRendererUrl('https://127.0.0.1:5173/app', true)).toBe(
      'https://127.0.0.1:5173/app'
    );
    expect(resolveDevelopmentRendererUrl('http://[::1]:5173', true)).toBe('http://[::1]:5173/');
    expect(() => resolveDevelopmentRendererUrl('https://example.com', true)).toThrow(/loopback/);
    expect(() => resolveDevelopmentRendererUrl('http://user:password@localhost:5173', true)).toThrow(/credentials/);
  });

  it('rejects development server overrides in packaged builds', () => {
    expect(() => resolveDevelopmentRendererUrl('http://localhost:5173', false)).toThrow(/packaged/);
  });
});
