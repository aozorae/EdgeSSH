import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continentOf, fitZoom, regionStats, regionView, type RegionKey } from '../frontend/src/continents.ts';
import type { CloudHost, HostLocation } from '../frontend/src/cloud-api.ts';

function place(countryCode: string, latitude: number, longitude: number): HostLocation {
  return { city: '', country: '', countryCode, latitude, longitude };
}

function host(location: HostLocation | null): CloudHost {
  return { id: String(Math.random()), name: 'box', group: '个人', host: '1.1.1.1', port: 22, username: 'root',
    authMethod: 'password', initialCommand: '', termType: 'xterm', encoding: 'utf-8', fingerprint: '',
    location, system: null, hasCredential: true, updatedAt: 0 };
}

test('country codes land on their own continent', () => {
  assert.equal(continentOf(place('CN', 39.9, 116.4)), 'asia');
  assert.equal(continentOf(place('JP', 35.7, 139.7)), 'asia');
  assert.equal(continentOf(place('DE', 52.5, 13.4)), 'europe');
  assert.equal(continentOf(place('GB', 51.5, -0.1)), 'europe');
  assert.equal(continentOf(place('ZA', -26.2, 28.0)), 'africa');
  assert.equal(continentOf(place('US', 37.8, -122.4)), 'north-america');
  assert.equal(continentOf(place('CA', 45.5, -73.6)), 'north-america');
  assert.equal(continentOf(place('BR', -23.5, -46.6)), 'south-america');
  assert.equal(continentOf(place('AU', -33.9, 151.2)), 'oceania');
});

test('countries straddling Europe and Asia follow their longitude', () => {
  assert.equal(continentOf(place('RU', 55.8, 37.6)), 'europe'); // Moscow
  assert.equal(continentOf(place('RU', 43.1, 131.9)), 'asia'); // Vladivostok
  assert.equal(continentOf(place('TR', 41.0, 28.9)), 'europe'); // Istanbul, west of the Bosphorus split
  assert.equal(continentOf(place('TR', 39.9, 32.9)), 'asia'); // Ankara
});

test('a place with an unlisted code falls back to the nearest continent', () => {
  const ids: RegionKey[] = ['asia', 'europe', 'africa', 'north-america', 'south-america', 'oceania'];
  const antarctic = continentOf(place('AQ', -80, 0));
  assert.ok(antarctic !== null && ids.includes(antarctic), `unlisted code should still be placed, got ${antarctic}`);
  assert.equal(continentOf(place('XX', 4.2, 18.0)), 'africa'); // dead centre of the continent
});

test('stats count each continent once, keep a fixed order and drop the empty ones', () => {
  const stats = regionStats([
    host(place('US', 37.8, -122.4)),
    host(place('CA', 45.5, -73.6)),
    host(place('JP', 35.7, 139.7)),
    host(null),
    host(null),
  ]);
  assert.deepEqual(stats.map((row) => row.key), ['asia', 'north-america', 'unknown'] satisfies RegionKey[]);
  assert.deepEqual(stats.map((row) => [row.label, row.count]), [['亚洲', 1], ['北美洲', 2], ['位置未知', 2]]);
});

test('no hosts means no chips at all', () => {
  assert.deepEqual(regionStats([]), []);
});

test('framing a region magnifies it and widens its bounds to every host inside', () => {
  const asia = regionView('asia', [host(place('ID', -8.6, 115.2))]);
  assert.equal(asia.centerLon, 95);
  // Default Asia stops at 11°S; Jakarta sits close, but any member below it has
  // to be pulled into frame rather than left off the paper.
  assert.equal(asia.bounds[2], -14.6);
  const zoom = fitZoom(asia.bounds);
  assert.ok(zoom > 1, `expected the map to magnify Asia, got ${zoom}`);
});

test('the whole world fits at exactly no magnification', () => {
  assert.equal(fitZoom([-180, 180, -90, 90]), 1);
  // South America is taller than it is wide, so its height sets the scale.
  assert.ok(Math.abs(fitZoom([-82, -34, -56, 13]) - 90 / 34.5) < 1e-9);
});
