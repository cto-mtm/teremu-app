import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Third-party tokens at rest: AES-256-GCM (docs/pos.md §Identity,
 * docs/email-ingestion.md §Token storage). Each integration has its own
 * key ring in its own secret, `ver:base64key[,ver:base64key…]` — the
 * FIRST entry encrypts, every entry decrypts, and each ciphertext names
 * its key version. Rotation is: prepend a new key, let the upkeep job
 * re-encrypt, drop the old one later. No big-bang.
 *
 * The emulator and the test suite run without the secret on a fixed
 * dev key (offline rule); a deployed function without it refuses.
 */

export interface Sealer {
  /** Whether a deployed function could encrypt right now (else 501). */
  configured(): boolean;
  encrypt(plaintext: string): string;
  decrypt(sealed: string): string;
  /** Whether a sealed value was written with an older key (rotate on next write). */
  sealedWithOldKey(sealed: string): boolean;
}

type KeyRing = { current: string; keys: Map<string, Buffer> };

/** `envVar` names the secret holding the key ring; `label` goes into
 * error messages ("POS token", "email token"); `devSeed` derives the
 * offline key — never change one, or local sealed data stops decrypting. */
export function makeSealer(envVar: string, label: string, devSeed: string): Sealer {
  const devKey = `dev:${createHash("sha256").update(devSeed).digest("base64")}`;

  function keyRing(): KeyRing {
    let raw = process.env[envVar];
    if (!raw) {
      const offline = process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.TEREMU_TEST_MOCKS);
      if (!offline) throw new Error(`${envVar} not set`);
      raw = devKey;
    }
    const keys = new Map<string, Buffer>();
    let current = "";
    for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const sep = entry.indexOf(":");
      const version = entry.slice(0, sep);
      const key = Buffer.from(entry.slice(sep + 1), "base64");
      if (sep < 1 || key.length !== 32) throw new Error(`${envVar} entries must be ver:base64(32 bytes)`);
      keys.set(version, key);
      current ||= version;
    }
    if (!current) throw new Error(`${envVar} is empty`);
    return { current, keys };
  }

  return {
    configured() {
      try {
        keyRing();
        return true;
      } catch {
        return false;
      }
    },

    encrypt(plaintext) {
      const { current, keys } = keyRing();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keys.get(current)!, iv);
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [current, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
    },

    decrypt(sealed) {
      const [version, iv, tag, data] = sealed.split(":");
      const key = keyRing().keys.get(version);
      if (!key || !iv || !tag || data === undefined) throw new Error(`no ${label} key for version "${version}"`);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    },

    sealedWithOldKey: (sealed) => sealed.split(":")[0] !== keyRing().current,
  };
}
