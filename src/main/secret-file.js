'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A small encrypted file: {read(): Buffer|null, write(Buffer): boolean}.
 *
 * `safeStorage` (DPAPI on Windows) ties the ciphertext to the user account.
 * When it is unavailable the secret is simply not persisted: writing a key in
 * the clear would be worse than a fresh identity next launch.
 */
function createSecretFile({ filePath, safeStorage }) {
  return {
    read() {
      try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return Buffer.from(safeStorage.decryptString(fs.readFileSync(filePath)), 'base64');
      } catch {
        return null;
      }
    },
    write(buffer) {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, safeStorage.encryptString(Buffer.from(buffer).toString('base64')));
        return true;
      } catch (err) {
        console.error(`[flowcus] failed to write ${filePath}:`, err.message);
        return false;
      }
    },
  };
}

module.exports = { createSecretFile };
