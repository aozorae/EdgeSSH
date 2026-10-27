import type { CloudHost, HostLocation } from './cloud-api';

/** The continents the map can focus on, in the order they are offered. */
export type ContinentId = 'asia' | 'europe' | 'africa' | 'north-america' | 'south-america' | 'oceania';
/** Pseudo-entry for hosts whose address never resolved to a place. */
export type RegionKey = ContinentId | 'unknown';

export interface RegionStat {
  key: RegionKey;
  label: string;
  count: number;
}

/** Where the globe turns to, and what the unrolled map crops down to. */
export interface RegionView {
  /** Longitude/latitude the sphere rotates to face. */
  centerLon: number;
  centerLat: number;
  /** [west, east, south, north] in degrees — the crop used by the flat map. */
  bounds: [number, number, number, number];
}

interface ContinentDef extends RegionView {
  label: string;
  /** ISO 3166-1 alpha-2 members, space separated so the table stays readable. */
  codes: string;
}

const CONTINENTS: Record<ContinentId, ContinentDef> = {
  asia: {
    label: '亚洲',
    centerLon: 95, centerLat: 30, bounds: [26, 180, -11, 78],
    codes: 'AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE',
  },
  europe: {
    label: '欧洲',
    centerLon: 15, centerLat: 50, bounds: [-25, 50, 34, 72],
    codes: 'AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK',
  },
  africa: {
    label: '非洲',
    centerLon: 20, centerLat: 2, bounds: [-18, 52, -35, 37],
    codes: 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW',
  },
  'north-america': {
    label: '北美洲',
    centerLon: -100, centerLat: 40, bounds: [-168, -50, 7, 72],
    codes: 'AG AI AW BB BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI',
  },
  'south-america': {
    label: '南美洲',
    centerLon: -60, centerLat: -15, bounds: [-82, -34, -56, 13],
    codes: 'AR BO BR CL CO EC FK GF GY PE PY SR UY VE',
  },
  oceania: {
    label: '大洋洲',
    centerLon: 145, centerLat: -20, bounds: [110, 180, -48, 0],
    codes: 'AS AU CK FJ FM GU KI MH MP NC NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
  },
};

const ORDER = Object.keys(CONTINENTS) as ContinentId[];
/**
 * Countries that straddle a continental boundary: east of the given meridian
 * they read as Asian, west of it as European. A plain lookup would put a
 * Vladivostok or Istanbul box in the wrong half of the world.
 */
const SPLIT_MERIDIAN: Record<string, number> = { RU: 60, TR: 29 };

const CODE_LOOKUP = new Map<string, ContinentId>();
for (const key of ORDER) for (const code of CONTINENTS[key].codes.split(' ')) CODE_LOOKUP.set(code, key);

/** Great-circle distance in radians — only used to place codes the table misses. */
function angleBetween(lat: number, lon: number, def: ContinentDef): number {
  const a = lat * Math.PI / 180, b = lon * Math.PI / 180;
  const x = Math.cos(a) * Math.cos(b), y = Math.cos(a) * Math.sin(b), z = Math.sin(a);
  const c = def.centerLat * Math.PI / 180, d = def.centerLon * Math.PI / 180;
  const p = Math.cos(c) * Math.cos(d), q = Math.cos(c) * Math.sin(d), r = Math.sin(c);
  return Math.acos(Math.min(1, Math.max(-1, x * p + y * q + z * r)));
}

/** Which continent a resolved place belongs to, or null when it cannot be placed. */
export function continentOf(location: HostLocation): ContinentId | null {
  const code = location.countryCode.trim().toUpperCase();
  const split = SPLIT_MERIDIAN[code];
  if (split) return location.longitude >= split ? 'asia' : 'europe';
  const direct = CODE_LOOKUP.get(code);
  if (direct) return direct;
  let nearest: ContinentId | null = null;
  let best = Infinity;
  for (const key of ORDER) {
    const distance = angleBetween(location.latitude, location.longitude, CONTINENTS[key]);
    if (distance < best) { best = distance; nearest = key; }
  }
  return nearest;
}

/** Europe/*Asia is the only pair whose labels differ from the lookup key. */
export function regionLabel(key: RegionKey): string { return key === 'unknown' ? '位置未知' : CONTINENTS[key].label; }

/**
 * Per-continent host counts, and the trailing unknown bucket. Continents stay
 * in a fixed order so the row never reshuffles itself on refresh; anything with
 * zero hosts is left out entirely.
 */
export function regionStats(hosts: readonly CloudHost[]): RegionStat[] {
  const counts = new Map<RegionKey, number>();
  for (const host of hosts) {
    const key: RegionKey = host.location ? continentOf(host.location) ?? 'unknown' : 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows: RegionStat[] = [];
  for (const key of ORDER) {
    const count = counts.get(key) ?? 0;
    if (count) rows.push({ key, label: CONTINENTS[key].label, count });
  }
  const unknown = counts.get('unknown') ?? 0;
  if (unknown) rows.push({ key: 'unknown', label: regionLabel('unknown'), count: unknown });
  return rows;
}

/**
 * The view for a region: a rotation target for the sphere and a crop for the
 * unrolled map, widened to include every host of that region so a box sitting
 * just outside its continent's bounds is still framed.
 */
export function regionView(key: ContinentId, hosts: readonly CloudHost[], padding = 6): RegionView {
  const def = CONTINENTS[key];
  let [west, east, south, north] = def.bounds;
  for (const host of hosts) {
    const location = host.location;
    if (!location || continentOf(location) !== key) continue;
    west = Math.min(west, location.longitude - padding);
    east = Math.max(east, location.longitude + padding);
    south = Math.min(south, location.latitude - padding);
    north = Math.max(north, location.latitude + padding);
  }
  return { centerLon: def.centerLon, centerLat: def.centerLat, bounds: [west, east, south, north] };
}

/**
 * How far the unrolled map has to magnify to fill its paper with a crop:
 * x covers 180° of it and y covers 90°, so whichever half-extent is the wider
 * one relative to its edge sets the scale.
 */
export function fitZoom(bounds: readonly [number, number, number, number]): number {
  const [west, east, south, north] = bounds;
  return Math.min(180 / Math.max(1, (east - west) / 2), 90 / Math.max(1, (north - south) / 2));
}

export function isContinent(key: RegionKey): key is ContinentId { return key !== 'unknown'; }
