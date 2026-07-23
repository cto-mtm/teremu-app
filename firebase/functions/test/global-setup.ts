/**
 * Vitest globalSetup — runs once before any test file, outside the
 * worker pool. Its only job is to fail fast with a clear message if the
 * emulators aren't up yet, so "forgot to start the emulators" never
 * looks like a wall of cryptic connection-refused test failures.
 */

const EMULATOR_HOSTS: Record<string, string> = {
  Firestore: "127.0.0.1:8080",
  Auth: "127.0.0.1:9099",
  Storage: "127.0.0.1:9199",
  Functions: "127.0.0.1:5001",
};

async function checkReachable(name: string, hostPort: string): Promise<void> {
  try {
    // Any HTTP response (even 404) means something is listening; we only
    // care about connection failures here.
    await fetch(`http://${hostPort}/`);
  } catch (err) {
    throw new Error(
      `[global-setup] ${name} emulator not reachable at ${hostPort}. ` +
        `Run the suite via "firebase emulators:exec" (see package.json "test" script) ` +
        `rather than "vitest" directly.\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function setup(): Promise<void> {
  await Promise.all(
    Object.entries(EMULATOR_HOSTS).map(([name, hostPort]) => checkReachable(name, hostPort)),
  );
}
