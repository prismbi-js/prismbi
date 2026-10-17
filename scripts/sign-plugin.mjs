#!/usr/bin/env node
// Sign PrismBI plugins.
//   node scripts/sign-plugin.mjs keygen <dir>                         → <dir>/private.jwk, <dir>/public.jwk
//   node scripts/sign-plugin.mjs sign <manifest.json> <private.jwk> <keyId>   → fills integrity + signature in place
// The manifest's "entry" is read relative to the manifest file.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateSigningKeys, signPlugin } from '../dist/plugins.js';

const [cmd, a, b, c] = process.argv.slice(2);
try {
  if (cmd === 'keygen' && a) {
    mkdirSync(a, { recursive: true });
    const { publicKey, privateKey } = await generateSigningKeys();
    writeFileSync(join(a, 'private.jwk'), JSON.stringify(privateKey, null, 2));
    writeFileSync(join(a, 'public.jwk'), JSON.stringify(publicKey, null, 2));
    console.log(`Wrote ${join(a, 'private.jwk')} (keep secret) and ${join(a, 'public.jwk')} (share with users)`);
  } else if (cmd === 'sign' && a && b && c) {
    const manifest = JSON.parse(readFileSync(a, 'utf8'));
    const code = readFileSync(resolve(dirname(a), manifest.entry));
    const signed = await signPlugin(manifest, code, JSON.parse(readFileSync(b, 'utf8')), c);
    writeFileSync(a, JSON.stringify(signed, null, 2) + '\n');
    console.log(`Signed ${signed.name}@${signed.version} (${signed.integrity}) with key "${c}"`);
  } else {
    console.log('Usage:\n  sign-plugin keygen <dir>\n  sign-plugin sign <manifest.json> <private.jwk> <keyId>');
    process.exitCode = cmd ? 2 : 0;
  }
} catch (e) {
  console.error(`sign-plugin: ${e.message}`);
  process.exitCode = 2;
}
