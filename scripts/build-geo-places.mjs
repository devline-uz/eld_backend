#!/usr/bin/env node
/**
 * Builds `src/common/geo-location/data/places-na.tsv` — the offline geo-location database used by
 * `LocationDescriptionService` (49 CFR 395 Subpart B Appendix A §4.4.2 / §7.29).
 *
 * Source: GeoNames `cities1000` + `admin1CodesASCII` (https://www.geonames.org/, CC BY 4.0).
 * Reproduce (download into a fresh EMPTY directory, run this script from the repo):
 *
 *   D=$(mktemp -d) && curl -sSfL -o "$D/cities1000.zip" https://download.geonames.org/export/dump/cities1000.zip \
 *     && curl -sSfL -o "$D/admin1CodesASCII.txt" https://download.geonames.org/export/dump/admin1CodesASCII.txt \
 *     && unzip -o "$D/cities1000.zip" -d "$D" \
 *     && node scripts/build-geo-places.mjs "$D/cities1000.txt" "$D/admin1CodesASCII.txt" src/common/geo-location/data/places-na.tsv
 *
 * Kept: US / CA / MX populated places (feature class P) except sections of places (PPLX),
 * historical/abandoned/destroyed ones (PPLH/PPLQ/PPLW/PPLCH). Name = GeoNames `asciiname`.
 * admin1 -> Appendix A Table 5 two-letter State/Province abbreviation (maps below).
 * Coordinates kept to 3 decimals (~110 m) — far finer than the 1-mile event precision.
 * Node built-ins only; output is deterministic (sorted).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [citiesPath, admin1Path, outPath] = process.argv.slice(2);
if (!citiesPath || !admin1Path || !outPath) {
  console.error('usage: node scripts/build-geo-places.mjs <cities1000.txt> <admin1CodesASCII.txt> <out.tsv>');
  process.exit(2);
}

/** GeoNames admin1 code -> Appendix A Table 5 abbreviation (Canada). */
const CA = {
  '01': 'AB', '02': 'BC', '03': 'MB', '04': 'NB', '05': 'NL', '07': 'NS', '08': 'ON',
  '09': 'PE', '10': 'QC', '11': 'SK', '12': 'YT', '13': 'NT', '14': 'NU',
};
/** GeoNames admin1 code -> Appendix A Table 5 abbreviation (Mexico). */
const MX = {
  '01': 'AG', '02': 'BN', '03': 'BS', '04': 'CP', '05': 'CS', '06': 'CI', '07': 'CH',
  '08': 'CL', '09': 'DF', '10': 'DG', '11': 'GJ', '12': 'GE', '13': 'HD', '14': 'JA',
  '15': 'MX', '16': 'MC', '17': 'MR', '18': 'NA', '19': 'NL', '20': 'OA', '21': 'PU',
  '22': 'QE', '23': 'QI', '24': 'SL', '25': 'SI', '26': 'SO', '27': 'TB', '28': 'TA',
  '29': 'TL', '30': 'VC', '31': 'YU', '32': 'ZA',
};
const US = new Set(
  ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY ' +
    'NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '),
);
const EXCLUDED_FEATURES = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);

// Every mapped admin1 code must exist in the GeoNames admin1 list (guards against a renumbering).
const admin1 = new Set(
  readFileSync(admin1Path, 'utf8')
    .split('\n')
    .map((line) => line.split('\t')[0])
    .filter(Boolean),
);
for (const [country, map] of [['CA', CA], ['MX', MX]]) {
  for (const code of Object.keys(map)) {
    if (!admin1.has(`${country}.${code}`)) throw new Error(`admin1 ${country}.${code} missing from ${admin1Path}`);
  }
}

function stateOf(country, code) {
  if (country === 'US') return US.has(code) ? code : null;
  if (country === 'CA') return CA[code] ?? null;
  if (country === 'MX') return MX[code] ?? null;
  return null;
}

const rows = new Map();
let skipped = 0;
for (const line of readFileSync(citiesPath, 'utf8').split('\n')) {
  if (!line) continue;
  const f = line.split('\t');
  const [, , asciiName, , lat, lon, featureClass, featureCode, country, , admin1Code] = f;
  if (country !== 'US' && country !== 'CA' && country !== 'MX') continue;
  if (featureClass !== 'P' || EXCLUDED_FEATURES.has(featureCode)) continue;
  const st = stateOf(country, admin1Code);
  const name = (asciiName ?? '').replace(/[\t\r\n]/g, ' ').trim();
  if (!st || !name) {
    skipped += 1;
    continue;
  }
  const row = `${name}\t${st}\t${Number(lat).toFixed(3)}\t${Number(lon).toFixed(3)}`;
  rows.set(row, row);
}

const sorted = [...rows.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const header = [
  '# OneBook ELD geo-location database (49 CFR 395 Subpart B Appendix A 4.4.2 / 7.29).',
  '# Data: GeoNames cities1000 (https://www.geonames.org/), licensed CC BY 4.0 — attribution required.',
  '# Built by scripts/build-geo-places.mjs. Columns: name<TAB>state<TAB>lat<TAB>lon',
];
writeFileSync(outPath, `${header.join('\n')}\n${sorted.join('\n')}\n`);
console.log(`wrote ${sorted.length} places to ${outPath} (skipped ${skipped} without a Table 5 state)`);
