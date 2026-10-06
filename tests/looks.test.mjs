import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOOKS, getLook, mergeFilmParams, lookPatch, isLookModified, hashJson,
  loadCustomLooks, saveCustomLook, deleteCustomLook, nextLookName, CUSTOM_MAX, LOOKS_KEY,
} from '../js/looks.js';
import { FILMS, getFilm } from '../js/films.js';
import { CAMERAS } from '../js/cameras.js';
import { makeFilm } from '../js/film-transform.js';

// minimal localStorage for Node
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

test('built-in looks: schema, real films/cameras, unique ids, Warm Haze first', () => {
  assert.ok(LOOKS.length >= 4 && LOOKS.length <= 8);
  assert.equal(LOOKS[0].id, 'warm-haze');
  const filmIds = new Set(FILMS.map((f) => f.id)), camIds = new Set(CAMERAS.map((c) => c.id));
  const ids = new Set();
  for (const l of LOOKS) {
    assert.ok(!ids.has(l.id)); ids.add(l.id);
    assert.equal(typeof l.name, 'string'); assert.ok(l.name.length > 1);
    assert.equal(typeof l.description, 'string');
    assert.equal(l.custom, false);
    assert.ok(filmIds.has(l.filmId), `${l.id} film ${l.filmId}`);
    assert.ok(camIds.has(l.cameraId), `${l.id} camera ${l.cameraId}`);
    assert.ok(Array.isArray(l.swatch) && l.swatch.length >= 2);
    assert.ok(l.film === null || typeof l.film === 'object');
    if (l.effects.leakStyle) assert.ok(['warm', 'prism', 'edge', 'holga'].includes(l.effects.leakStyle));
    assert.equal(getLook(l.id), l);
    // the effective film compiles and maps mid grey sensibly
    const fn = makeFilm(mergeFilmParams(getFilm(l.filmId).params, l.film));
    const out = [0, 0, 0];
    fn(0.18, 0.18, 0.18, out);
    for (const v of out) assert.ok(Number.isFinite(v) && v > 0.15 && v < 0.85, `${l.id} grey → ${out}`);
  }
  assert.equal(getLook('nope', []), null);
  assert.equal(getLook(null), null);
});

test('mergeFilmParams: shallow replace, deep grain/halation, no mutation', () => {
  const base = { contrast: 0.1, hsl: { red: [0, 1, 0] }, grain: { amount: 0.3, size: 0.8, color: 0.4 }, halation: { amount: 0.05, color: [1, 0.3, 0.1] } };
  const snap = JSON.stringify(base);
  const over = { contrast: -0.2, hsl: { blue: [5, 0.5, 0] }, grain: { color: 0 }, halation: { amount: 0.2 } };
  const m = mergeFilmParams(base, over);
  assert.equal(m.contrast, -0.2);
  assert.deepEqual(m.hsl, { blue: [5, 0.5, 0] });
  assert.deepEqual(m.grain, { amount: 0.3, size: 0.8, color: 0 });
  assert.deepEqual(m.halation, { amount: 0.2, color: [1, 0.3, 0.1] });
  assert.equal(JSON.stringify(base), snap);
  m.hsl.blue[0] = 99;
  assert.equal(over.hsl.blue[0], 5, 'override objects are copied');
  assert.deepEqual(mergeFilmParams(base, null), base);
});

test('lookPatch / isLookModified', () => {
  const l = getLook('warm-haze');
  const p = lookPatch(l);
  assert.equal(p.filmId, 'kodak-gold-200');
  assert.equal(p.leakStyle, 'prism');
  assert.equal(p.exposure, 0);           // unspecified → default
  assert.equal(p.dust, 0);
  assert.deepEqual(p.lookFilm, l.film);
  assert.notEqual(p.lookFilm, l.film);    // copy
  const state = { ...p, dateOn: true, leakSeed: 3 };
  assert.equal(isLookModified(l, state), false);
  assert.equal(isLookModified(l, { ...state, grain: 1.5 }), true);
  assert.equal(isLookModified(l, { ...state, lookFilm: null }), true, 'film switched → modified');
  assert.equal(isLookModified(l, { ...state, filmId: 'kodak-portra-400' }), true);
  const toy = getLook('toy-camera');
  assert.equal(lookPatch(toy).leakSeed, 7);
  assert.equal('leakSeed' in lookPatch(l), false, 'seed kept when the look does not set one');
  assert.equal(hashJson({ a: 1 }), hashJson({ a: 1 }));
  assert.notEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
});

test('custom looks: save / load / rename / delete / cap / bad data', () => {
  globalThis.localStorage = memStorage();
  try {
    assert.deepEqual(loadCustomLooks(), []);
    assert.equal(nextLookName([]), 'My look 1');
    const a = saveCustomLook({ id: 'custom-1', name: 'A', filmId: 'kodak-portra-400', film: { fade: 0.1 }, effects: { leak: 0.5, leakStyle: 'prism' } });
    assert.ok(a && a.custom === true);
    const b = saveCustomLook({ name: '  B  ', filmId: 'kodak-portra-400' });
    assert.ok(b.id.startsWith('custom-'));
    assert.equal(b.name, 'B');
    let list = loadCustomLooks();
    assert.deepEqual(list.map((l) => l.id), [b.id, 'custom-1'], 'newest first');
    assert.equal(getLook('custom-1').film.fade, 0.1);
    saveCustomLook({ ...a, name: 'Renamed' });
    list = loadCustomLooks();
    assert.equal(list.length, 2);
    assert.equal(list.find((l) => l.id === 'custom-1').name, 'Renamed');
    assert.equal(nextLookName(list), 'My look 3');
    assert.equal(deleteCustomLook('custom-1'), true);
    assert.equal(deleteCustomLook('custom-1'), false);
    assert.equal(loadCustomLooks().length, 1);
    for (let i = 0; i < 30; i++) saveCustomLook({ id: `custom-x${i}`, name: `L${i}`, filmId: 'kodak-portra-400' });
    assert.equal(loadCustomLooks().length, CUSTOM_MAX);
    assert.equal(loadCustomLooks()[0].id, 'custom-x29');
    localStorage.setItem(LOOKS_KEY, '{corrupt');
    assert.deepEqual(loadCustomLooks(), []);
    localStorage.setItem(LOOKS_KEY, JSON.stringify([null, 5, { id: 'custom-ok', name: 'ok' }, { name: 'no id' }]));
    assert.deepEqual(loadCustomLooks().map((l) => l.id), ['custom-ok']);
    // storage that throws
    globalThis.localStorage = { getItem() { throw new Error('x'); }, setItem() { throw new Error('quota'); } };
    assert.deepEqual(loadCustomLooks(), []);
    assert.equal(saveCustomLook({ name: 'x' }), null);
  } finally {
    delete globalThis.localStorage;
  }
});
