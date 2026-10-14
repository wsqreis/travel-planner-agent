import { z } from 'zod';

/** Long-term facts about a traveller. Only what they said themselves ends up here. */
export type Profile = {
  name: string | null;
  homeBase: string | null;
  budget: string | null;
  pace: string | null;
  companions: string | null;
  interests: string[];
  dietary: string[];
  dislikes: string[];
  visited: string[];
  wishlist: string[];
};

export const SCALAR_FIELDS = ['name', 'homeBase', 'budget', 'pace', 'companions'] as const;
export const LIST_FIELDS = ['interests', 'dietary', 'dislikes', 'visited', 'wishlist'] as const;
export const FIELDS = [...SCALAR_FIELDS, ...LIST_FIELDS] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_DESCRIPTIONS: Record<Field, string> = {
  name: "the traveller's name",
  homeBase: 'city or airport they usually travel from',
  budget: 'budget level or amount, e.g. "mid-range", "under 1500 EUR per trip"',
  pace: 'preferred travel pace, e.g. "relaxed", "packed itineraries"',
  companions: 'who they usually travel with, e.g. "partner and two kids aged 5 and 8"',
  interests: 'things they enjoy on trips: food markets, hiking, museums, beaches...',
  dietary: 'dietary restrictions or allergies',
  dislikes: 'things to avoid: crowds, long flights, cold weather...',
  visited: 'places they have already been',
  wishlist: 'places they want to visit one day',
};

export const emptyProfile = (): Profile => ({
  name: null,
  homeBase: null,
  budget: null,
  pace: null,
  companions: null,
  interests: [],
  dietary: [],
  dislikes: [],
  visited: [],
  wishlist: [],
});

/**
 * One change to the profile. Kept flat (no unions) so small models can produce it reliably;
 * `applyUpdates` rejects combinations that make no sense, e.g. "add" to a single-value field.
 */
export const memoryUpdate = z.object({
  op: z
    .enum(['set', 'add', 'remove', 'clear'])
    .describe('set: replace a single-value field. add/remove: one item of a list field. clear: forget a field entirely'),
  field: z.enum(FIELDS),
  value: z.string().nullable().describe('The value to set, add or remove, in a few words. null for clear'),
});
export type MemoryUpdate = z.infer<typeof memoryUpdate>;

const isList = (field: Field): field is (typeof LIST_FIELDS)[number] =>
  (LIST_FIELDS as readonly string[]).includes(field);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Applies updates to a copy of the profile. Returns the new profile and the updates that changed something. */
export function applyUpdates(profile: Profile, updates: MemoryUpdate[]): { profile: Profile; applied: MemoryUpdate[] } {
  const next: Profile = structuredClone(profile);
  const applied: MemoryUpdate[] = [];

  for (const update of updates) {
    const value = update.value?.trim() || null;
    const { field, op } = update;

    if (op === 'clear') {
      if (isList(field) ? next[field].length === 0 : next[field] === null) continue;
      if (isList(field)) next[field] = [];
      else next[field] = null;
      applied.push({ op, field, value: null });
      continue;
    }
    if (!value) continue;

    if (isList(field)) {
      const list = next[field];
      if (op === 'add' || op === 'set') {
        if (list.some((item) => same(item, value))) continue;
        list.push(value);
        applied.push({ op: 'add', field, value });
      } else if (op === 'remove') {
        const kept = list.filter((item) => !same(item, value));
        if (kept.length === list.length) continue;
        next[field] = kept;
        applied.push({ op, field, value });
      }
    } else {
      if (op === 'set' || op === 'add') {
        if (next[field] !== null && same(next[field], value)) continue;
        next[field] = value;
        applied.push({ op: 'set', field, value });
      } else if (op === 'remove' && next[field] !== null && same(next[field], value)) {
        next[field] = null;
        applied.push({ op, field, value });
      }
    }
  }
  return { profile: next, applied };
}

export const isEmpty = (profile: Profile): boolean =>
  FIELDS.every((field) => (isList(field) ? profile[field].length === 0 : profile[field] === null));

/** Compact text form for prompts and the CLI; empty fields are left out. */
export function describeProfile(profile: Profile): string {
  if (isEmpty(profile)) return '(nothing known yet)';
  return FIELDS.flatMap((field) => {
    const value = profile[field];
    if (Array.isArray(value)) return value.length ? [`- ${field}: ${value.join(', ')}`] : [];
    return value ? [`- ${field}: ${value}`] : [];
  }).join('\n');
}
