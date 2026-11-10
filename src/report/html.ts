/**
 * Standalone, autonomous single-file HTML dashboard exporter.
 * Packages data model, report layout, theme styles and interactive runtime into a single portable .html file.
 * Opens offline in any browser without external scripts, CDNs or network connections.
 * Supports AES-GCM (256-bit) client-side encryption with PBKDF2 key derivation for confidential offline sharing.
 */
import type { DataModel } from '../data/model';
import type { ReportDefinition } from './report';
import { CSS } from './styles';

export interface StandaloneHtmlOptions {
  title?: string;
  theme?: 'light' | 'dark' | 'high-contrast';
  /** Optional custom inline CSS to append. */
  extraCss?: string;
  /** Optional password to encrypt the embedded data model and report layout using AES-GCM + PBKDF2. */
  password?: string;
  /** Optional password hint displayed to the user on the offline password prompt screen. */
  hint?: string;
}

export interface EncryptedPayload {
  ciphertext: string;
  salt: string;
  iv: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function u8ToBase64(u8: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function getCrypto(): Promise<Crypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  try {
    const spec = 'node:crypto';
    const mod = (await import(/* @vite-ignore */ spec)) as { webcrypto?: Crypto };
    if (mod.webcrypto?.subtle) return mod.webcrypto;
  } catch {
    // fallback
  }
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto API is not available in the current environment');
  return globalThis.crypto;
}

/** Encrypt arbitrary UTF-8 text with a password using PBKDF2 (100,000 iterations, SHA-256) + AES-GCM (256-bit). */
export async function encryptPayload(plainText: string, password: string): Promise<EncryptedPayload> {
  const cr = await getCrypto();
  const subtle = cr.subtle;

  const salt = cr.getRandomValues(new Uint8Array(16));
  const iv = cr.getRandomValues(new Uint8Array(12));

  const keyMaterial = await subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const ciphertextBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plainText));
  return {
    ciphertext: u8ToBase64(new Uint8Array(ciphertextBuf)),
    salt: u8ToBase64(salt),
    iv: u8ToBase64(iv),
  };
}

/** Decrypt payload encrypted with `encryptPayload`. Throws if password is incorrect. */
export async function decryptPayload(payload: EncryptedPayload, password: string): Promise<string> {
  const cr = await getCrypto();
  const subtle = cr.subtle;

  const salt = base64ToU8(payload.salt);
  const iv = base64ToU8(payload.iv);
  const ciphertext = base64ToU8(payload.ciphertext);

  const keyMaterial = await subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return dec.decode(plainBuf);
}

/** Build an autonomous, portable HTML dashboard string containing data and visual definitions. */
export function buildStandaloneHtml(
  model: DataModel,
  definition: ReportDefinition,
  opts?: StandaloneHtmlOptions & { password?: undefined },
): string;
export function buildStandaloneHtml(
  model: DataModel,
  definition: ReportDefinition,
  opts: StandaloneHtmlOptions & { password: string },
): Promise<string>;
export function buildStandaloneHtml(
  model: DataModel,
  definition: ReportDefinition,
  opts?: StandaloneHtmlOptions,
): string | Promise<string>;
export function buildStandaloneHtml(
  model: DataModel,
  definition: ReportDefinition,
  opts: StandaloneHtmlOptions = {},
): string | Promise<string> {
  if (opts.password) {
    return buildEncryptedHtml(model, definition, opts);
  }
  return buildPlainHtml(model, definition, opts);
}

function buildPlainHtml(
  model: DataModel,
  definition: ReportDefinition,
  opts: StandaloneHtmlOptions,
): string {
  const title = opts.title ?? definition.name ?? 'PrismBI Report';
  const modelJson = JSON.stringify(model.toJSON());
  const reportJson = JSON.stringify(definition);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    #app { width: 100vw; height: 100vh; overflow: hidden; }
    ${CSS}
    ${opts.extraCss ?? ''}
  </style>
</head>
<body class="pbi-theme-${opts.theme ?? 'light'}">
  <div id="app"></div>
  <script type="application/json" id="pbi-model">${modelJson}</script>
  <script type="application/json" id="pbi-report">${reportJson}</script>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      const modelData = JSON.parse(document.getElementById('pbi-model').textContent);
      const reportSpec = JSON.parse(document.getElementById('pbi-report').textContent);
      window.__PRISMBI_EMBED__ = { model: modelData, report: reportSpec };
    });
  </script>
</body>
</html>`;
}

async function buildEncryptedHtml(
  model: DataModel,
  definition: ReportDefinition,
  opts: StandaloneHtmlOptions,
): Promise<string> {
  const title = opts.title ?? definition.name ?? 'PrismBI Report';
  const rawPayload = JSON.stringify({
    model: model.toJSON(),
    report: definition,
  });

  const encrypted = await encryptPayload(rawPayload, opts.password!);
  const encryptedJson = JSON.stringify(encrypted);
  const hintHtml = opts.hint
    ? `<div class="pbi-hint">Password Hint: <span>${escapeHtml(opts.hint)}</span></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🔒 ${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    #app { width: 100vw; height: 100vh; overflow: hidden; }
    .pbi-auth-overlay {
      position: fixed; inset: 0; background: #0f172a; display: flex; align-items: center; justify-content: center; z-index: 99999;
      font-family: inherit; color: #f8fafc; padding: 20px;
    }
    .pbi-auth-card {
      background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 420px; width: 100%;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .pbi-auth-card h2 { margin: 0 0 8px; font-size: 20px; display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .pbi-auth-card p { margin: 0 0 20px; color: #94a3b8; font-size: 14px; line-height: 1.5; }
    .pbi-hint { margin: -10px 0 16px; font-size: 13px; color: #38bdf8; background: rgba(56, 189, 248, 0.1); padding: 8px 12px; border-radius: 6px; }
    .pbi-auth-form { display: flex; flex-direction: column; gap: 12px; }
    .pbi-auth-input {
      padding: 10px 14px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; font-size: 14px; outline: none; transition: border-color 0.2s;
    }
    .pbi-auth-input:focus { border-color: #38bdf8; }
    .pbi-auth-btn {
      padding: 10px 16px; border-radius: 6px; border: none; background: #2563eb; color: #ffffff; font-weight: 500; font-size: 14px; cursor: pointer; transition: background 0.2s;
    }
    .pbi-auth-btn:hover { background: #1d4ed8; }
    .pbi-auth-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .pbi-auth-error {
      color: #f87171; font-size: 13px; background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.2); padding: 8px 12px; border-radius: 6px; display: none;
    }
    ${CSS}
    ${opts.extraCss ?? ''}
  </style>
</head>
<body class="pbi-theme-${opts.theme ?? 'light'}">
  <div id="pbi-auth-overlay" class="pbi-auth-overlay">
    <div class="pbi-auth-card">
      <h2>🔒 Protected Report</h2>
      <p>This standalone dashboard is encrypted with AES-256. Enter the password to decrypt and view the analysis.</p>
      ${hintHtml}
      <form id="pbi-form" class="pbi-auth-form" onsubmit="return false;">
        <input type="password" id="pbi-pwd" class="pbi-auth-input" placeholder="Enter password" autofocus required />
        <div id="pbi-error" class="pbi-auth-error"></div>
        <button type="submit" id="pbi-submit" class="pbi-auth-btn">Decrypt & View Report</button>
      </form>
    </div>
  </div>
  <div id="app" style="display:none"></div>
  <script type="application/json" id="pbi-encrypted">${encryptedJson}</script>
  <script>
    (function() {
      const b64ToU8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const enc = new TextEncoder();
      const dec = new TextDecoder();

      async function decryptData(payload, pwd) {
        const subtle = window.crypto.subtle;
        const salt = b64ToU8(payload.salt);
        const iv = b64ToU8(payload.iv);
        const ciphertext = b64ToU8(payload.ciphertext);

        const keyMaterial = await subtle.importKey('raw', enc.encode(pwd), { name: 'PBKDF2' }, false, ['deriveKey']);
        const key = await subtle.deriveKey(
          { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
        const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return JSON.parse(dec.decode(plainBuf));
      }

      window.addEventListener('DOMContentLoaded', () => {
        const form = document.getElementById('pbi-form');
        const pwdInput = document.getElementById('pbi-pwd');
        const submitBtn = document.getElementById('pbi-submit');
        const errEl = document.getElementById('pbi-error');
        const overlay = document.getElementById('pbi-auth-overlay');
        const app = document.getElementById('app');
        const payload = JSON.parse(document.getElementById('pbi-encrypted').textContent);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const pwd = pwdInput.value;
          if (!pwd) return;

          submitBtn.disabled = true;
          submitBtn.textContent = 'Decrypting...';
          errEl.style.display = 'none';

          try {
            const data = await decryptData(payload, pwd);
            window.__PRISMBI_EMBED__ = data;
            overlay.remove();
            app.style.display = '';
            document.title = data.report.name || '${escapeHtml(title)}';
          } catch (err) {
            errEl.textContent = 'Incorrect password. Decryption failed.';
            errEl.style.display = 'block';
            pwdInput.value = '';
            pwdInput.focus();
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Decrypt & View Report';
          }
        });
      });
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

