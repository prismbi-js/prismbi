import type { VisualDefinition } from './types';

const registry = new Map<string, VisualDefinition>();

/** Register a visual type (built-in or custom). Re-registering replaces it. */
export function registerVisual(def: VisualDefinition, aliases: string[] = []): void {
  registry.set(def.type, def);
  for (const a of aliases) registry.set(a, def);
}

export function getVisual(type: string): VisualDefinition {
  const d = registry.get(type);
  if (!d) throw new Error(`Unknown visual type "${type}". Registered: ${listVisuals().join(', ')}`);
  return d;
}

export function hasVisual(type: string): boolean {
  return registry.has(type);
}

export function listVisuals(): string[] {
  return [...registry.keys()];
}

/** Typed helper for authoring visuals. */
export function defineVisual(def: VisualDefinition): VisualDefinition {
  return def;
}
