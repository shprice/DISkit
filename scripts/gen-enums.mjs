#!/usr/bin/env node
// Fetches SISO-STD-010 enumeration XML and generates public/dis-enums.json
// Usage: node scripts/gen-enums.mjs
//
// The output file is used by the browser UI to enrich entity type descriptions
// in the Details panel. Run this once to get full entity type coverage.
// The package ships a minimal dis-enums.json with kind/domain/country data only.

import { writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../public/dis-enums.json');
const SRC = 'https://raw.githubusercontent.com/open-dis/dis-enumerations/master/data/siso-std-010.xml';

function attr(tagStr, name) {
  const m = tagStr.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

console.log(`Fetching ${SRC} …`);
let xml;
try {
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  xml = await res.text();
} catch (err) {
  console.error('Fetch failed:', err.message);
  process.exit(1);
}
console.log(`Downloaded ${(xml.length / 1024).toFixed(0)} KB`);

// ---- Country codes from <enum name="Country" …> ----------------------------
const countries = {};
for (const [, enumAttrs, enumBody] of xml.matchAll(/<enum\b([^>]*)>([\s\S]*?)<\/enum>/g)) {
  const name = attr(enumAttrs, 'name') || '';
  if (!/country/i.test(name)) continue;
  for (const [, rowAttrs] of enumBody.matchAll(/<enumrow\b([^>]*)/g)) {
    const v = attr(rowAttrs, 'value');
    const d = attr(rowAttrs, 'description');
    if (v !== null && d) countries[v] = d;
  }
}
console.log(`  Countries: ${Object.keys(countries).length}`);

// ---- Entity types from <cet> -----------------------------------------------
const et = {};
const cetMatch = xml.match(/<cet\b[^>]*>([\s\S]*?)<\/cet>/);
if (!cetMatch) {
  console.error('Could not find <cet> element');
  process.exit(1);
}

let specCount = 0;
for (const [, eA, eBody] of cetMatch[1].matchAll(/<entity\b([^>]*)>([\s\S]*?)<\/entity>/g)) {
  const k = attr(eA, 'kind'), d = attr(eA, 'domain'), c = attr(eA, 'country');
  if (!k || !d || !c) continue;
  const base = `${k}.${d}.${c}`;

  for (const [, cA, cBody] of eBody.matchAll(/<category\b([^>]*)>([\s\S]*?)<\/category>/g)) {
    const ci = attr(cA, 'id'), cd = attr(cA, 'description');
    if (!ci) continue;
    et[`${base}.${ci}`] = cd || '';

    for (const [, sA, sBody] of cBody.matchAll(/<subcategory\b([^>]*)>([\s\S]*?)<\/subcategory>/g)) {
      const si = attr(sA, 'id'), sd = attr(sA, 'description');
      if (!si) continue;
      et[`${base}.${ci}.${si}`] = sd || '';

      for (const [, pA] of (sBody || '').matchAll(/<specific\b([^>]*)/g)) {
        const pi = attr(pA, 'id'), pd = attr(pA, 'description');
        if (!pi) continue;
        et[`${base}.${ci}.${si}.${pi}`] = pd || '';
        specCount++;
      }
    }
  }
}
console.log(`  Entity type specifics: ${specCount}`);

// ---- Merge with existing hardcoded kinds/domains ---------------------------
let existing = {};
try { existing = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}

const out = {
  kinds:     existing.kinds     || {},
  domains:   existing.domains   || {},
  countries: Object.keys(countries).length ? countries : (existing.countries || {}),
  et,
};

writeFileSync(OUT, JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`Written: ${OUT} (${kb} KB)`);
