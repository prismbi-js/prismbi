import type { DataModel } from '../data/model';
import type { FieldSpec } from '../data/query';
import { isColumnRefString, parseColumnRef } from '../data/types';
import { getVisual } from '../visuals/registry';
import type { RoleDef, VisualDefinition, VisualSpec } from '../visuals/types';

export type FieldKind = 'measure' | 'column' | 'numericColumn' | 'hierarchy' | 'parameter';

const asArray = (f: FieldSpec | FieldSpec[] | undefined): FieldSpec[] => (f === undefined ? [] : Array.isArray(f) ? f : [f]);
export const fieldRefOf = (f: FieldSpec): string => (typeof f === 'string' ? f : (f.field ?? f.expression ?? ''));

/** What kind of field a ref is (drives where it lands). */
export function fieldKind(model: DataModel, ref: string): FieldKind {
  if (model.hasMeasure(ref.replace(/^\[|\]$/g, ''))) return 'measure';
  if (!isColumnRefString(ref)) return 'measure';
  if (model.resolveHierarchy(ref)) return 'hierarchy';
  if (model.resolveFieldParameter(ref)) return 'parameter';
  const c = parseColumnRef(ref);
  return model.table(c.table).column(c.column).type === 'number' ? 'numericColumn' : 'column';
}

const accepts = (role: RoleDef, kind: FieldKind): boolean => {
  if (role.kind === 'any') return true;
  if (kind === 'measure' || kind === 'parameter') return role.kind === 'measure' || (kind === 'parameter' && role.kind === 'grouping');
  if (kind === 'hierarchy' || kind === 'column') return role.kind === 'grouping';
  return true; // numeric columns can group or be aggregated
};

/** Preferred landing role for a kind of field. */
function pickRole(def: VisualDefinition, spec: VisualSpec, kind: FieldKind): RoleDef | undefined {
  const roles = def.roles.filter((r) => accepts(r, kind));
  const filled = (r: RoleDef) => asArray(spec.fields?.[r.name]).length;
  const measureFirst = kind === 'measure' || kind === 'parameter';
  const order = [...roles].sort((a, b) => {
    const pa = measureFirst ? (a.kind === 'measure' ? 0 : 1) : a.kind === 'grouping' ? 0 : a.kind === 'any' ? 1 : 2;
    const pb = measureFirst ? (b.kind === 'measure' ? 0 : 1) : b.kind === 'grouping' ? 0 : b.kind === 'any' ? 1 : 2;
    return pa - pb;
  });
  // an empty role first, then one that takes several fields, then replace the first candidate
  return order.find((r) => filled(r) === 0) ?? order.find((r) => r.multiple) ?? order[0];
}

/** Put a field into a visual's wells (into `role`, or the best one). Returns the new `fields` object. */
export function assignField(model: DataModel, spec: VisualSpec, ref: string, roleName?: string, index?: number): VisualSpec['fields'] {
  const def = getVisual(spec.type);
  const kind = fieldKind(model, ref);
  const role = roleName ? def.roles.find((r) => r.name === roleName) : pickRole(def, spec, kind);
  if (!role) return spec.fields;
  const fields = { ...(spec.fields ?? {}) };
  let field: FieldSpec = ref;
  // a numeric column in a measure well becomes an implicit aggregation
  if (kind === 'numericColumn' && role.kind === 'measure') field = { field: ref, aggregation: 'sum' };
  const current = asArray(fields[role.name]).filter((f) => fieldRefOf(f) !== ref);
  if (role.multiple || role.kind === 'any') {
    current.splice(index ?? current.length, 0, field);
    fields[role.name] = current;
  } else fields[role.name] = field;
  return fields;
}

/** Remove the field at `index` of a role. */
export function removeField(spec: VisualSpec, roleName: string, index: number): VisualSpec['fields'] {
  const fields = { ...(spec.fields ?? {}) };
  const list = asArray(fields[roleName]);
  list.splice(index, 1);
  if (list.length) fields[roleName] = list;
  else delete fields[roleName];
  return fields;
}

/** Move fields over when a visual changes type: same role names first, then by kind. */
export function retargetFields(model: DataModel, spec: VisualSpec, toType: string): VisualSpec['fields'] {
  const from = getVisual(spec.type);
  const to = getVisual(toType);
  const draft: VisualSpec = { ...spec, type: toType, fields: {} };
  const leftovers: string[] = [];
  for (const r of from.roles)
    for (const f of asArray(spec.fields?.[r.name])) {
      const same = to.roles.find((x) => x.name === r.name);
      if (same) draft.fields = assignField(model, draft, fieldRefOf(f), same.name);
      else leftovers.push(fieldRefOf(f));
    }
  for (const ref of leftovers) draft.fields = assignField(model, draft, ref);
  return draft.fields;
}

/** A sensible new visual for a single field clicked or dropped on an empty canvas. */
export function autoVisualFor(model: DataModel, ref: string): Pick<VisualSpec, 'type' | 'fields'> & { w: number; h: number } {
  const kind = fieldKind(model, ref);
  if (kind === 'measure') return { type: 'card', fields: { value: ref }, w: 3, h: 3 };
  if (kind === 'parameter') return { type: 'clusteredColumn', fields: { values: ref }, w: 6, h: 6 };
  if (kind === 'hierarchy') return { type: 'slicer', fields: { field: ref }, w: 3, h: 6 };
  const c = parseColumnRef(ref);
  const col = model.table(c.table).column(c.column);
  if (col.type === 'date') return { type: 'slicer', fields: { field: ref }, w: 4, h: 3 };
  if (kind === 'numericColumn') return { type: 'card', fields: { value: { field: ref, aggregation: 'sum' } }, w: 3, h: 3 };
  return { type: 'table', fields: { columns: [ref] }, w: 5, h: 6 };
}

/** Default size for a newly added visual type. */
export function defaultSize(type: string): { w: number; h: number } {
  const d = getVisual(type);
  if (d.category === 'card') return type === 'multiRowCard' ? { w: 4, h: 5 } : { w: 3, h: 3 };
  if (d.isSlicer) return { w: 3, h: 5 };
  if (type === 'text') return { w: 6, h: 2 };
  if (d.category === 'table') return { w: 6, h: 7 };
  return { w: 6, h: 7 };
}
