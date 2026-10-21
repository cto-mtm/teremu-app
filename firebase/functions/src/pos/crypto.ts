import { makeSealer } from "../helpers/sealer.js";

/**
 * POS tokens at rest (docs/pos.md §Identity): the shared sealer
 * (helpers/sealer.ts) on the POS_TOKEN_ENC_KEY key ring.
 */
const sealer = makeSealer("POS_TOKEN_ENC_KEY", "POS token", "teremu-dev-pos-key");

export const encryptionConfigured = (): boolean => sealer.configured();
export const encrypt = (plaintext: string): string => sealer.encrypt(plaintext);
export const decrypt = (sealed: string): string => sealer.decrypt(sealed);
export const sealedWithOldKey = (sealed: string): boolean => sealer.sealedWithOldKey(sealed);
