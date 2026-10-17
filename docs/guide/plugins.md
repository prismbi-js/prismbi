# Plugins: signed visuals, themes and connectors

`@prismbi/prismbi/plugins` loads extensions at runtime, from your own server or a catalog. Code only runs after two checks pass:
- **Integrity:** the code's SHA-256 hash must match the hash in its manifest.
- **Signature:** the manifest must be signed (ECDSA P-256) by a key you trust.

Both checks use WebCrypto, so they work in browsers, workers and Node 20+.

```ts
import { loadPlugin } from '@prismbi/prismbi/plugins';

const plugin = await loadPlugin('https://plugins.example.com/sankey-pro/manifest.json', {
  trustedKeys: { acme: acmePublicJwk },
});
plugin.registered; // { visuals: ['sankeyPro'], themes: [], connectors: [] }
```

Failures throw before any plugin code runs:
- the integrity hash doesn't match
- the signature is invalid
- the key is untrusted
- the plugin is unsigned, unless you pass `allowUnsigned: true`

## Writing a plugin

A plugin is a **self-contained ES module**: bundle its dependencies, because it's imported from a blob or data URL where bare imports can't resolve. Its default export can contain:

```js
export default {
  visuals: [{ type: 'sankeyPro', displayName: 'Sankey Pro', category: 'chart', roles: [/* … */], render(ctx) { /* … */ } }],
  themes: [{ name: 'acme', /* Theme tokens */ }],
  connectors: { loadAcmeCrm: async (opts) => rows },
  register(api) { /* api.registerVisual, api.registerTheme */ },
};
```

Visuals follow the same contract as [custom visuals](custom-visuals.md). Write them as plain objects; `defineVisual` is only a typing helper.

## Manifest and signing

```json
{
  "name": "sankey-pro",
  "version": "1.2.0",
  "kind": "visual",
  "entry": "dist/index.js",
  "displayName": "Sankey Pro",
  "description": "Multi-level flows",
  "author": "Acme"
}
```

```bash
npx prismbi-sign-plugin keygen keys/                               # keys/private.jwk (secret), keys/public.jwk (share)
npx prismbi-sign-plugin sign manifest.json keys/private.jwk acme   # adds integrity, keyId and signature
```

- **What the signature covers:** the plugin's name, version, kind and integrity hash. Changing the code or relabelling the version invalidates it.
- **In code:** `generateSigningKeys`, `signPlugin`, `verifyPlugin` and `integrityOf` do the same steps programmatically.

## Catalogs (marketplace)

A catalog is a JSON file that lists plugins with their manifest URLs:

```json
{ "name": "Acme plugins", "plugins": [{ "name": "sankey-pro", "version": "1.2.0", "kind": "visual", "manifest": "sankey-pro/manifest.json", "description": "Multi-level flows", "author": "Acme" }] }
```

```ts
const catalog = await fetchCatalog('https://plugins.example.com/catalog.json');
renderPluginGallery(panel, catalog, { trustedKeys, onInstalled: (p) => console.log(p.registered) });
```

`renderPluginGallery` renders a list with **Install** buttons; installed plugins show as installed. `loadedPlugins()` lists everything loaded in the page.
