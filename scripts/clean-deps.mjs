import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const targets = [
  'node_modules',
  'shared/node_modules',
  'shared/dist',
  'shared/package-lock.json',
  'app/node_modules',
  'app/package-lock.json',
  'firebase/functions/node_modules',
  'firebase/functions/lib',
  'firebase/functions/package-lock.json'
];

console.log('🧹 Cleaning node_modules and build artifacts...');
for (const relPath of targets) {
  const fullPath = path.join(rootDir, relPath);
  if (fs.existsSync(fullPath)) {
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`  ✓ Removed ${relPath}`);
    } catch (err) {
      console.warn(`  ⚠️ Could not remove ${relPath}: ${err.message}`);
    }
  }
}
console.log('✨ Cleanup complete.\n');
