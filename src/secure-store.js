const ElectronStore = require("electron-store");

const SECRET_KEYS = [
  "claudeApiKey",
  "openaiApiKey",
  "geminiApiKey",
  "groqApiKey",
  "openrouterApiKey",
  "assemblyaiApiKey",
  "whisperApiKey",
  "elevenlabsApiKey",
  "openaiTtsApiKey",
];

let keytar = null;
try {
  keytar = require("keytar");
} catch (_error) {
  keytar = null;
}

class SecureStore {
  constructor({ safeStorage, serviceName = "OpenGuider" }) {
    this.safeStorage = safeStorage;
    this.serviceName = serviceName;
    this.fallbackStore = new ElectronStore({
      name: "secure-settings",
      clearInvalidConfig: true,
    });
  }

  async setSecret(key, value) {
    const normalizedValue = String(value || "");
    if (!SECRET_KEYS.includes(key)) {
      return;
    }

    if (!normalizedValue) {
      await this.deleteSecret(key);
      return;
    }

    if (keytar) {
      await keytar.setPassword(this.serviceName, key, normalizedValue);
      return;
    }

    if (this.safeStorage?.isEncryptionAvailable?.()) {
      const encrypted = this.safeStorage.encryptString(normalizedValue);
      this.fallbackStore.set(key, encrypted.toString("base64"));
      return;
    }

    this.fallbackStore.set(key, normalizedValue);
  }

  async getSecret(key) {
    if (!SECRET_KEYS.includes(key)) {
      return "";
    }

    if (keytar) {
      return (await keytar.getPassword(this.serviceName, key)) || "";
    }

    const stored = this.fallbackStore.get(key, "");
    if (!stored) {
      return "";
    }
    if (this.safeStorage?.isEncryptionAvailable?.()) {
      try {
        const decrypted = this.safeStorage.decryptString(Buffer.from(stored, "base64"));
        return decrypted || "";
      } catch (_error) {
        return "";
      }
    }
    return String(stored || "");
  }

  async deleteSecret(key) {
    if (!SECRET_KEYS.includes(key)) {
      return;
    }
    if (keytar) {
      await keytar.deletePassword(this.serviceName, key);
      return;
    }
    this.fallbackStore.delete(key);
  }

  async fillSecrets(settings) {
    const nextSettings = { ...(settings || {}) };
    await Promise.all(
      SECRET_KEYS.map(async (key) => {
        nextSettings[key] = await this.getSecret(key);
      }),
    );
    return nextSettings;
  }

  async saveSecretsFromSettings(settings) {
    const updates = settings || {};
    await Promise.all(
      SECRET_KEYS.map(async (key) => {
        if (!(key in updates)) {
          return;
        }
        await this.setSecret(key, updates[key]);
      }),
    );
  }

  async clearAllSecrets() {
    await Promise.all(SECRET_KEYS.map((key) => this.deleteSecret(key)));
  }
}

module.exports = {
  SECRET_KEYS,
  SecureStore,
};
