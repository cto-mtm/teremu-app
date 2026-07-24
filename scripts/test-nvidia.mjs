#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_LOCAL_PATH = join(ROOT, 'firebase', 'functions', '.secret.local');

function getApiKey() {
  if (process.env.NVIDIA_API_KEY) return process.env.NVIDIA_API_KEY;
  if (!existsSync(SECRET_LOCAL_PATH)) return null;

  const content = readFileSync(SECRET_LOCAL_PATH, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('NVIDIA_API_KEY=')) {
      const val = trimmed.slice('NVIDIA_API_KEY='.length).trim();
      return val.length > 0 ? val : null;
    }
  }
  return null;
}

const apiKey = getApiKey();
const model = process.env.NVIDIA_MODEL || 'meta/llama-4-maverick-17b-128e-instruct';

console.log('--- NVIDIA API Key Verification ---');

if (!apiKey) {
  console.log('ℹ NVIDIA_API_KEY is currently empty/unset in firebase/functions/.secret.local.');
  console.log('  -> Backend will use deterministic Mock OCR mode for local development.');
  console.log('  -> Once you add your nvapi-... key to .secret.local, run this script again to test it!');
  process.exit(0);
}

console.log(`Key found: ${apiKey.slice(0, 10)}... (length: ${apiKey.length})`);
console.log(`Target Model: ${model}`);
console.log('Sending test completion request to integrate.api.nvidia.com...');

try {
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 64,
      temperature: 0.1,
      messages: [
        { role: 'user', content: 'Say "NVIDIA API connection successful!" in 5 words or less.' }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`\n❌ NVIDIA API Request Failed (HTTP ${res.status}):`);
    console.error(errText);
    process.exit(1);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content ?? '';
  console.log('\n✅ NVIDIA API test successful!');
  console.log(`Model Response: "${reply.trim()}"`);
} catch (err) {
  console.error('\n❌ Network or fetch error while reaching NVIDIA API:');
  console.error(err);
  process.exit(1);
}
