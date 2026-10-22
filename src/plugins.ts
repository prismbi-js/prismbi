/**
 * PrismBI plugins: load visuals, themes and connectors from signed packages, and browse a catalog.
 * Code is checked against its SHA-256 integrity hash and an ECDSA P-256 signature from a key you trust before
 * it runs (WebCrypto, so it works in browsers, workers and Node 20+).
 *
 * ```ts
 * import { loadPlugin } from '@prismbi/prismbi/plugins';
 * await loadPlugin('https://plugins.example.com/sankey-pro/manifest.json', { trustedKeys: { acme: acmePublicJwk } });
 * ```
 */
import { registerTheme, registerVisual } from '@prismbi/prismbi';
import type { Theme, VisualDefinition } from '@prismbi/prismbi';

export interface PluginManifest {
  name: string;
  version: string;
  kind: 'visual' | 'theme' | 'connector' | 'bundle';
  /** Code URL, relative to the manifest. */
  entry: string;
  /** `sha256-<base64>` of the entry's bytes. */
  integrity: string;
  /** Base64 ECDSA P-256 (SHA-256) signature over {@link signedPayload}. */
  signature?: string;
  /** Which trusted key signed it. */
  keyId?: string;
  displayName?: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Lowest PrismBI version it supports. */
  prismbi?: string;
}

/** What a plugin module exports (as `default` or named `plugin`). */
export interface PluginModule {
  visuals?: VisualDefinition[];
  themes?: Theme[];
  /** Connector functions, returned to the caller by name. */
  connectors?: Record<string, (...args: never[]) => unknown>;
  /** Free-form setup with access to the registration API. */
  register?: (api: PluginApi) => void | Promise<void>;
}

export interface PluginApi {
  registerVisual: typeof registerVisual;
  registerTheme: typeof registerTheme;
}

export interface LoadOptions {
  /** Public keys you trust, by key id: JWK objects or imported CryptoKeys. */
  trustedKeys?: Record<string, JsonWebKey | CryptoKey>;
  /** Load plugins without a valid signature (integrity is still checked). Default false. */
  allowUnsigned?: boolean;
  fetch?: typeof fetch;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  signed: boolean;
  /** Names of what was registered. */
  registered: { visuals: string[]; themes: string[]; connectors: string[] };
}

let subtleCache: SubtleCrypto | undefined;
/** WebCrypto, falling back to Node's `webcrypto` where there is no global `crypto` (Node 18). */
const subtle = async (): Promise<SubtleCrypto> => {
  if (subtleCache) return subtleCache;
  let s = (globalThis.crypto as Crypto | undefined)?.subtle;
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!s && proc?.versions?.node) {
    const spec = 'node:crypto';
    s = ((await import(/* @vite-ignore */ spec)) as { webcrypto?: Crypto }).webcrypto?.subtle;
  }
  if (!s) throw new Error('WebCrypto (crypto.subtle) is not available in this environment');
  return (subtleCache = s);
};

const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** The exact bytes a signature covers: identity, kind and the code hash. */
export function signedPayload(m: Pick<PluginManifest, 'name' | 'version' | 'kind' | 'integrity'>): string {
  return `prismbi-plugin:v1\n${m.name}\n${m.version}\n${m.kind}\n${m.integrity}`;
}

/** `sha256-<base64>` of some bytes. */
export async function integrityOf(code: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof code === 'string' ? utf8(code) : code instanceof Uint8Array ? code : new Uint8Array(code);
  return `sha256-${b64(await (await subtle()).digest('SHA-256', bytes))}`;
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIG = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function asKey(k: JsonWebKey | CryptoKey, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return typeof (k as CryptoKey).type === 'string' && 'algorithm' in (k as object) ? (k as CryptoKey) : (await subtle()).importKey('jwk', k as JsonWebKey, ALG, false, [usage]);
}

/** Generate a signing key pair (JWK); keep the private key secret and publish the public one. */
export async function generateSigningKeys(): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  const pair = await (await subtle()).generateKey(ALG, true, ['sign', 'verify']);
  return { publicKey: await (await subtle()).exportKey('jwk', pair.publicKey), privateKey: await (await subtle()).exportKey('jwk', pair.privateKey) };
}

/** Fill in `integrity` and `signature` for a manifest and its code. */
export async function signPlugin(manifest: Omit<PluginManifest, 'integrity' | 'signature'> & { integrity?: string }, code: ArrayBuffer | Uint8Array | string, privateKey: JsonWebKey | CryptoKey, keyId: string): Promise<PluginManifest> {
  const integrity = await integrityOf(code);
  const m = { ...manifest, integrity, keyId } as PluginManifest;
  const sig = await (await subtle()).sign(SIG, await asKey(privateKey, 'sign'), utf8(signedPayload(m)));
  return { ...m, signature: b64(sig) };
}

/** Check the code against the manifest's integrity and signature. Throws with the reason when it fails. */
export async function verifyPlugin(manifest: PluginManifest, code: ArrayBuffer | Uint8Array | string, opts: LoadOptions = {}): Promise<{ signed: boolean }> {
  const actual = await integrityOf(code);
  if (actual !== manifest.integrity) throw new Error(`Plugin ${manifest.name}: integrity mismatch (expected ${manifest.integrity}, got ${actual})`);
  const key = manifest.keyId ? opts.trustedKeys?.[manifest.keyId] : undefined;
  if (manifest.signature && key) {
    const ok = await (await subtle()).verify(SIG, await asKey(key, 'verify'), unb64(manifest.signature), utf8(signedPayload(manifest)));
    if (!ok) throw new Error(`Plugin ${manifest.name}: invalid signature for key "${manifest.keyId}"`);
    return { signed: true };
  }
  if (opts.allowUnsigned) return { signed: false };
  throw new Error(manifest.signature ? `Plugin ${manifest.name}: signed by untrusted key "${manifest.keyId}"` : `Plugin ${manifest.name}: not signed (pass allowUnsigned to load it anyway)`);
}

/** Import verified code: a blob URL in browsers, a data URL where blob imports are unsupported (Node). */
async function importCode(code: string): Promise<Record<string, unknown>> {
  const load = (url: string) => import(/* @vite-ignore */ /* webpackIgnore: true */ url) as Promise<Record<string, unknown>>;
  if (typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      return await load(url);
    } catch {
      // fall back to a data URL below
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return load(`data:text/javascript;base64,${b64(utf8(code))}`);
}

const loaded = new Map<string, LoadedPlugin>();

/** Plugins loaded in this page, by name. */
export const loadedPlugins = (): LoadedPlugin[] => [...loaded.values()];

/** Fetch, verify, import and register a plugin from its manifest URL (or a manifest object plus base URL). */
export async function loadPlugin(source: string | { manifest: PluginManifest; baseUrl: string }, opts: LoadOptions = {}): Promise<LoadedPlugin> {
  const f = opts.fetch ?? fetch;
  const manifestUrl = typeof source === 'string' ? source : source.baseUrl;
  const manifest: PluginManifest = typeof source === 'string' ? await (await f(source)).json() : source.manifest;
  for (const k of ['name', 'version', 'kind', 'entry', 'integrity'] as const) if (!manifest[k]) throw new Error(`Plugin manifest is missing "${k}"`);
  const prev = loaded.get(manifest.name);
  if (prev && prev.manifest.version === manifest.version) return prev;
  const entryUrl = new URL(manifest.entry, new URL(manifestUrl, (globalThis as { location?: { href: string } }).location?.href ?? 'http://localhost/')).toString();
  const res = await f(entryUrl);
  if (!res.ok) throw new Error(`Plugin ${manifest.name}: ${entryUrl} → ${res.status}`);
  const code = await res.text();
  const { signed } = await verifyPlugin(manifest, code, opts);
  const mod = await importCode(code);
  const plugin = ((mod.default ?? mod.plugin ?? mod) as PluginModule) || {};
  const registered = { visuals: [] as string[], themes: [] as string[], connectors: [] as string[] };
  for (const v of plugin.visuals ?? []) {
    registerVisual(v);
    registered.visuals.push(v.type);
  }
  for (const t of plugin.themes ?? []) {
    registerTheme(t);
    registered.themes.push(t.name);
  }
  registered.connectors.push(...Object.keys(plugin.connectors ?? {}));
  await plugin.register?.({ registerVisual, registerTheme });
  const result: LoadedPlugin = { manifest, module: plugin, signed, registered };
  loaded.set(manifest.name, result);
  return result;
}

// ---------------------------------------------------------------- catalog

export interface CatalogEntry extends Omit<PluginManifest, 'integrity' | 'entry'> {
  /** Manifest URL, relative to the catalog. */
  manifest: string;
  tags?: string[];
  /** Small preview image URL. */
  preview?: string;
}

export interface PluginCatalog {
  name: string;
  plugins: CatalogEntry[];
}

/** Fetch a catalog (`{ name, plugins: [{ name, version, kind, manifest, … }] }`), resolving manifest URLs. */
export async function fetchCatalog(url: string, opts: { fetch?: typeof fetch } = {}): Promise<PluginCatalog> {
  const cat = (await (await (opts.fetch ?? fetch)(url)).json()) as PluginCatalog;
  const base = new URL(url, (globalThis as { location?: { href: string } }).location?.href ?? 'http://localhost/');
  return { ...cat, plugins: (cat.plugins ?? []).map((p) => ({ ...p, manifest: new URL(p.manifest, base).toString() })) };
}

/** A simple gallery with Install buttons (for a Studio side panel or a settings page). */
export function renderPluginGallery(container: HTMLElement, catalog: PluginCatalog, opts: LoadOptions & { onInstalled?: (p: LoadedPlugin) => void; onError?: (e: Error, entry: CatalogEntry) => void } = {}): void {
  const list = document.createElement('div');
  list.className = 'pbi-plugin-gallery';
  list.style.cssText = 'display:grid;gap:8px;font:12px/1.45 var(--pbi-font, system-ui)';
  for (const p of catalog.plugins) {
    const card = document.createElement('div');
    card.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center;padding:8px 10px;border:1px solid var(--pbi-border, #ddd);border-radius:8px';
    const title = document.createElement('b');
    title.textContent = `${p.displayName ?? p.name} ${p.version}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'grid-row:span 2;font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--pbi-accent, #2a78d6);background:transparent;color:var(--pbi-accent, #2a78d6);cursor:pointer';
    const installed = loaded.get(p.name)?.manifest.version === p.version;
    btn.textContent = installed ? 'Installed' : 'Install';
    btn.disabled = installed;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Installing…';
      try {
        const r = await loadPlugin(p.manifest, opts);
        btn.textContent = r.signed ? 'Installed ✓' : 'Installed (unsigned)';
        opts.onInstalled?.(r);
      } catch (e) {
        btn.textContent = 'Failed';
        btn.title = (e as Error).message;
        btn.disabled = false;
        opts.onError?.(e as Error, p);
      }
    });
    const desc = document.createElement('span');
    desc.style.cssText = 'color:var(--pbi-fg-2, #555)';
    desc.textContent = `${p.description ?? ''}${p.author ? ` · ${p.author}` : ''}`;
    card.append(title, btn, desc);
    list.append(card);
  }
  container.replaceChildren(list);
}
