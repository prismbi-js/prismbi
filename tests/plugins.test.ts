// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fetchCatalog, generateSigningKeys, integrityOf, loadPlugin, signPlugin, verifyPlugin, type PluginManifest } from '@prismbi/prismbi/plugins';
import { getVisual, hasVisual } from '@prismbi/prismbi';

// a self-contained plugin module: plain-object visual, a theme-free bundle, a connector, and a register hook
const code = (name: string) => `export default {
  visuals: [{ type: '${name}', displayName: 'Hello', roles: [], render(ctx) { ctx.root.textContent = 'hi'; } }],
  connectors: { ping: () => 'pong' },
  register(api) { globalThis.__registered = (globalThis.__registered ?? 0) + 1; },
};`;

function host(files: Record<string, string>) {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    return path in files ? new Response(files[path]) : new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('signed plugins', () => {
  it('signs, verifies and rejects tampering or unknown keys', async () => {
    const { publicKey, privateKey } = await generateSigningKeys();
    const other = await generateSigningKeys();
    const m = await signPlugin({ name: 'hello', version: '1.0.0', kind: 'visual', entry: 'index.js' }, code('helloA'), privateKey, 'acme');
    expect(m.integrity).toBe(await integrityOf(code('helloA')));
    await expect(verifyPlugin(m, code('helloA'), { trustedKeys: { acme: publicKey } })).resolves.toEqual({ signed: true });
    await expect(verifyPlugin(m, code('helloA') + ' ', { trustedKeys: { acme: publicKey } })).rejects.toThrow(/integrity mismatch/);
    await expect(verifyPlugin(m, code('helloA'), { trustedKeys: { acme: other.publicKey } })).rejects.toThrow(/invalid signature/);
    await expect(verifyPlugin(m, code('helloA'), { trustedKeys: {} })).rejects.toThrow(/untrusted key/);
    // re-labelling the version breaks the signature
    await expect(verifyPlugin({ ...m, version: '9.9.9' }, code('helloA'), { trustedKeys: { acme: publicKey } })).rejects.toThrow(/invalid signature/);
    const unsigned: PluginManifest = { name: 'raw', version: '1.0.0', kind: 'visual', entry: 'index.js', integrity: await integrityOf('x') };
    await expect(verifyPlugin(unsigned, 'x')).rejects.toThrow(/not signed/);
    await expect(verifyPlugin(unsigned, 'x', { allowUnsigned: true })).resolves.toEqual({ signed: false });
  });

  it('loads a signed plugin from a manifest URL and registers what it exports', async () => {
    const { publicKey, privateKey } = await generateSigningKeys();
    const manifest = await signPlugin({ name: 'hello-b', version: '1.2.0', kind: 'bundle', entry: 'dist/index.js', description: 'Says hi' }, code('helloB'), privateKey, 'acme');
    const f = host({ '/p/hello/manifest.json': JSON.stringify(manifest), '/p/hello/dist/index.js': code('helloB') });
    const r = await loadPlugin('https://cdn.test/p/hello/manifest.json', { trustedKeys: { acme: publicKey }, fetch: f });
    expect(r.signed).toBe(true);
    expect(r.registered).toEqual({ visuals: ['helloB'], themes: [], connectors: ['ping'] });
    expect(hasVisual('helloB')).toBe(true);
    expect(getVisual('helloB').displayName).toBe('Hello');
    expect((r.module.connectors!.ping as () => string)()).toBe('pong');
    expect((globalThis as { __registered?: number }).__registered).toBe(1);
    // loading the same version again is a no-op
    expect(await loadPlugin('https://cdn.test/p/hello/manifest.json', { trustedKeys: { acme: publicKey }, fetch: f })).toBe(r);
    // tampered code on the server is refused before it runs
    const bad = host({ '/q/manifest.json': JSON.stringify({ ...manifest, name: 'evil', version: '1.0.0' }), '/q/dist/index.js': code('evil') });
    await expect(loadPlugin('https://cdn.test/q/manifest.json', { trustedKeys: { acme: publicKey }, fetch: bad })).rejects.toThrow();
    expect(hasVisual('evil')).toBe(false);
  });

  it('reads catalogs with manifest URLs resolved', async () => {
    const f = host({ '/market/catalog.json': JSON.stringify({ name: 'Acme', plugins: [{ name: 'hello', version: '1.0.0', kind: 'visual', manifest: 'hello/manifest.json', description: 'Says hi' }] }) });
    const cat = await fetchCatalog('https://cdn.test/market/catalog.json', { fetch: f });
    expect(cat.plugins[0].manifest).toBe('https://cdn.test/market/hello/manifest.json');
  });
});
