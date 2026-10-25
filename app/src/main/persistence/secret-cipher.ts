import { app, safeStorage } from 'electron';
import { awaitDurableWindowsStorageKey } from './safe-storage-bootstrap';

export interface SecretCipher {
  encrypt(value: string): string;
  decrypt(ciphertext: string): string;
}

export class ElectronSafeStorageCipher implements SecretCipher {
  private initialized = false;
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.assertAvailable();
    if (process.platform === 'win32') await awaitDurableWindowsStorageKey(app.getPath('sessionData'));
    this.initialized = true;
  }
  encrypt(value: string): string {
    if (!this.initialized) throw new Error('safe_storage_not_initialized');
    this.assertAvailable();
    return safeStorage.encryptString(value).toString('base64');
  }

  decrypt(ciphertext: string): string {
    if (!this.initialized) throw new Error('safe_storage_not_initialized');
    this.assertAvailable();
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  }

  private assertAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法使用安全凭据存储，API Key 未保存。');
    }
  }
}
