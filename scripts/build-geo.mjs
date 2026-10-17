#!/usr/bin/env node
// Builds src/geo/world.ts and src/geo/usStates.ts from Natural Earth 1:110m GeoJSON (public domain):
//   curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
//   curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_1_states_provinces.geojson
//   node scripts/build-geo.mjs <folder with both files> src/geo
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const [, , dir, outDir] = process.argv;
const round = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] : c.map(round));
// drop consecutive duplicate points created by rounding
const dedupe = (c) => (Array.isArray(c[0]) && typeof c[0][0] === 'number' ? c.filter((p, i) => !i || p[0] !== c[i - 1][0] || p[1] !== c[i - 1][1]) : c.map(dedupe));
const code = (a, b) => (a && a !== '-99' ? a : b && b !== '-99' ? b : undefined);
const conv = (file, props) => {
  const fc = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  return { type: 'FeatureCollection', features: fc.features.map((f) => ({ type: 'Feature', properties: props(f.properties), geometry: { type: f.geometry.type, coordinates: dedupe(round(f.geometry.coordinates)) } })) };
};
const world = conv('ne_110m_admin_0_countries.geojson', (p) => Object.fromEntries(Object.entries({ name: p.NAME, name_long: p.NAME_LONG, iso_a2: code(p.ISO_A2, p.ISO_A2_EH), iso_a3: code(p.ISO_A3, p.ISO_A3_EH), continent: p.CONTINENT }).filter(([, v]) => v !== undefined)));
const states = conv('ne_110m_admin_1_states_provinces.geojson', (p) => ({ name: p.name, postal: p.postal, iso_3166_2: p.iso_3166_2 }));
const usStates = { type: 'FeatureCollection', features: states.features.filter((f) => f.properties.iso_3166_2?.startsWith('US-')) };
mkdirSync(outDir, { recursive: true });
const header = '// Generated from Natural Earth 1:110m (public domain, naturalearthdata.com); coordinates rounded to 0.01°.\n// Regenerate with scripts/build-geo.mjs. Do not edit by hand.\n';
writeFileSync(`${outDir}/world.ts`, `${header}import type { GeoFeatureCollection } from '../visuals/map';\n\n/** World countries (Natural Earth 1:110m): properties name, name_long, iso_a2, iso_a3, continent. */\nexport const worldCountries: GeoFeatureCollection = ${JSON.stringify(world)};\n`);
writeFileSync(`${outDir}/usStates.ts`, `${header}import type { GeoFeatureCollection } from '../visuals/map';\n\n/** US states (Natural Earth 1:110m): properties name, postal, iso_3166_2. */\nexport const usStates: GeoFeatureCollection = ${JSON.stringify(usStates)};\n`);
console.log(world.features.length, 'countries;', usStates.features.length, 'US states');
