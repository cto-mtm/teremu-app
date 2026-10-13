// Vite's `?raw` suffix, honoured by esbuild through the assistant-local
// plugin in esbuild.mjs and by vitest natively: the assistant prompt is
// imported as text (`import prompt from "./assistant/prompt.md?raw"`).
declare module "*.md?raw" {
  const text: string;
  export default text;
}
