import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyUpdates, describeProfile, emptyProfile } from '../src/memory/profile.ts';
import { SqliteProfileStore } from '../src/memory/store.ts';

describe('applyUpdates', () => {
  it('adds list items once, ignoring case', () => {
    const { profile, applied } = applyUpdates(emptyProfile(), [
      { op: 'add', field: 'interests', value: 'Hiking' },
      { op: 'add', field: 'interests', value: 'hiking ' },
      { op: 'add', field: 'interests', value: 'food markets' },
    ]);
    assert.deepEqual(profile.interests, ['Hiking', 'food markets']);
    assert.equal(applied.length, 2);
  });

  it('sets single-value fields and treats "add" on them as "set"', () => {
    const { profile, applied } = applyUpdates(emptyProfile(), [
      { op: 'set', field: 'homeBase', value: 'Lisbon' },
      { op: 'add', field: 'homeBase', value: 'Porto' },
    ]);
    assert.equal(profile.homeBase, 'Porto');
    assert.deepEqual(applied.map((u) => u.op), ['set', 'set']);
  });

  it('removes items and clears fields, reporting only real changes', () => {
    const start = applyUpdates(emptyProfile(), [
      { op: 'add', field: 'dietary', value: 'vegetarian' },
      { op: 'set', field: 'budget', value: 'mid-range' },
    ]).profile;
    const { profile, applied } = applyUpdates(start, [
      { op: 'remove', field: 'dietary', value: 'Vegetarian' },
      { op: 'remove', field: 'dietary', value: 'vegan' }, // not there: no-op
      { op: 'clear', field: 'budget', value: null },
      { op: 'clear', field: 'pace', value: null }, // already empty: no-op
    ]);
    assert.deepEqual(profile.dietary, []);
    assert.equal(profile.budget, null);
    assert.equal(applied.length, 2);
  });

  it('ignores empty values and does not mutate the input', () => {
    const original = emptyProfile();
    const { applied } = applyUpdates(original, [{ op: 'add', field: 'visited', value: '  ' }]);
    assert.equal(applied.length, 0);
    assert.deepEqual(original, emptyProfile());
  });

  it('describes only known fields', () => {
    assert.equal(describeProfile(emptyProfile()), '(nothing known yet)');
    const { profile } = applyUpdates(emptyProfile(), [
      { op: 'set', field: 'name', value: 'Maya' },
      { op: 'add', field: 'wishlist', value: 'Japan' },
    ]);
    assert.equal(describeProfile(profile), '- name: Maya\n- wishlist: Japan');
  });
});

describe('SqliteProfileStore', () => {
  it('persists profiles across store instances and keeps users apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wayfarer-'));
    const path = join(dir, 'memory.db');
    try {
      const first = new SqliteProfileStore(path);
      first.update('ana', [{ op: 'add', field: 'interests', value: 'surfing' }]);
      first.close();

      const second = new SqliteProfileStore(path);
      assert.deepEqual(second.get('ana').interests, ['surfing']);
      assert.deepEqual(second.get('bo').interests, []);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs every applied change with a timestamp', () => {
    const store = new SqliteProfileStore(':memory:', () => new Date('2026-10-14T09:00:00Z'));
    store.update('ana', [
      { op: 'set', field: 'name', value: 'Ana' },
      { op: 'set', field: 'name', value: 'Ana' }, // no change: not logged
    ]);
    store.update('ana', [{ op: 'clear', field: 'name', value: null }]);
    assert.deepEqual(store.history('ana'), [
      { op: 'set', field: 'name', value: 'Ana', at: '2026-10-14T09:00:00.000Z' },
      { op: 'clear', field: 'name', value: null, at: '2026-10-14T09:00:00.000Z' },
    ]);
  });

  it('forget erases the profile and its history', () => {
    const store = new SqliteProfileStore(':memory:');
    store.update('ana', [{ op: 'add', field: 'dislikes', value: 'crowds' }]);
    store.forget('ana');
    assert.deepEqual(store.get('ana'), emptyProfile());
    assert.deepEqual(store.history('ana'), []);
  });
});
