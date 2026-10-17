/**
 * Built-in boundaries for maps (Natural Earth 1:110m, public domain): world countries and US states. Importing this
 * entry registers them, so maps can use `format.map.boundaries: 'world' | 'usStates'`:
 *
 * ```ts
 * import '@prismbi/prismbi/geo';
 * { type: 'filledMap', fields: { location: 'Region[Country]', values: 'Total Sales' }, format: { map: { boundaries: 'world' } } }
 * ```
 * Countries match on name, long name, ISO alpha-2 or alpha-3 code; states on name, postal code or ISO 3166-2 code.
 * @packageDocumentation
 */
import type { GeoFeatureCollection } from './visuals/map';
import { worldCountries } from './geo/world';
import { usStates } from './geo/usStates';

// the same registry the map visuals read (shared through globalThis, so no map code is bundled here)
const store = globalThis as unknown as Record<symbol, Map<string, { fc: GeoFeatureCollection; keys: string[] }> | undefined>;
const registry = (store[Symbol.for('prismbi.boundaries')] ??= new Map());
registry.set('world', { fc: worldCountries, keys: ['name', 'name_long', 'iso_a2', 'iso_a3'] });
registry.set('usStates', { fc: usStates, keys: ['name', 'postal', 'iso_3166_2'] });

export { worldCountries, usStates };
