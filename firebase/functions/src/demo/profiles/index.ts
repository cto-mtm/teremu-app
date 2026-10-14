import type { DemoProfileName, ProfileSpec } from "../engine.js";
import { harborBistro } from "./harbor-bistro.js";
import { pastryStall } from "./pastry-stall.js";
import { taqueria } from "./taqueria.js";

/** Every demo profile, by name (the `--profile` argument). */
export const DEMO_PROFILES: Record<DemoProfileName, ProfileSpec> = {
  "harbor-bistro": harborBistro,
  taqueria,
  "pastry-stall": pastryStall,
};

export function isDemoProfileName(name: string): name is DemoProfileName {
  return Object.prototype.hasOwnProperty.call(DEMO_PROFILES, name);
}
