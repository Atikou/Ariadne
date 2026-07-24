import { safeStorage } from 'electron';

export interface SecretCipher {
  encrypt(value: string): string;
  decrypt(ciphertext: string): string;
}

export class ElectronSafeStorageCipher implements SecretCipher {
  encrypt(value: string): string {
    this.assertAvailable();
    return safeStorage.encryptString(value).toString('base64');
  }

  decrypt(ciphertext: string): string {
    this.assertAvailable();
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  }

  private assertAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法使用安全凭据存储，API Key 未保存。');
    }
  }
}
