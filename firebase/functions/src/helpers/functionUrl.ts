import { REGION } from "../region.js";

/** The functions emulator's own host:port, for self-referential URLs
 * (OAuth callbacks). Deployed code must NOT import the repo-root
 * ports.json (the functions dir deploys on its own), and the emulator
 * exposes no standard env var for its OWN port — so this mirrors
 * ports.json's emulators.functions as a last resort. If that port ever
 * moves in ports.json, update this literal too — check-ports.mjs cannot
 * see into function source. */
function emulatorFunctionsHost(): string {
  return process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:10404";
}

/** This project's URL for an HTTP function (emulator or deployed). */
export function functionUrl(name: string): string {
  const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "demo-app";
  return process.env.FUNCTIONS_EMULATOR === "true"
    ? `http://${emulatorFunctionsHost()}/${project}/${REGION}/${name}`
    : `https://${REGION}-${project}.cloudfunctions.net/${name}`;
}
