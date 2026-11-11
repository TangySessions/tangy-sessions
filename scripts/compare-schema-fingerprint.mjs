// Compares two outputs of supabase/ops/schema_fingerprint.readonly.sql
// (CSV with a header row: kind,name,fingerprint — the SQL editor's
// "Download CSV", or psql --csv). Reads local files only; no network.
//
//   node scripts/compare-schema-fingerprint.mjs <expected.csv> <actual.csv>
//
// Exit 0 when every function, trigger, policy, table, grant, RLS flag, enum
// and bucket matches. Views and indexes print with pg_get_*def, which can
// differ cosmetically between PostgreSQL major versions, so a mismatch there
// is reported as "check by hand" and does not fail the comparison on its own.
import { readFileSync } from 'node:fs';
import process from 'node:process';

const [expectedPath, actualPath] = process.argv.slice(2);
if (!expectedPath || !actualPath) {
  console.error('usage: node scripts/compare-schema-fingerprint.mjs <expected.csv> <actual.csv>');
  process.exit(2);
}

// Minimal RFC 4180 parser (quoted fields may contain commas, quotes and newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

function load(path) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const [k, n, f] = ['kind', 'name', 'fingerprint'].map((c) => header.indexOf(c));
  if (k < 0 || n < 0 || f < 0) throw new Error(`${path}: expected a header with kind,name,fingerprint`);
  const map = new Map();
  for (const r of rows) if (r[k] !== 'summary') map.set(`${r[k]}\t${r[n]}`, r[f]);
  return map;
}

const expected = load(expectedPath);
const actual = load(actualPath);
const COSMETIC = new Set(['view', 'index']);
const missing = [];
const extra = [];
const changed = [];
const cosmetic = [];
for (const [key, fp] of expected) {
  if (!actual.has(key)) missing.push(key);
  else if (actual.get(key) !== fp) (COSMETIC.has(key.split('\t')[0]) ? cosmetic : changed).push(key);
}
for (const key of actual.keys()) if (!expected.has(key)) extra.push(key);

const show = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length}):`);
  for (const key of list.sort()) console.log(`  ${key.replace('\t', '  ')}`);
};
console.log(`expected objects: ${expected.size}   actual objects: ${actual.size}`);
show('MISSING in actual (in the repository, not in the database)', missing);
show('EXTRA in actual (in the database, not in the repository)', extra);
show('DIFFERENT definition', changed);
show('View/index text differs — check by hand (may be a PostgreSQL version difference)', cosmetic);

const ok = !missing.length && !extra.length && !changed.length;
console.log(ok ? '\nSCHEMA MATCHES' : '\nSCHEMA DIFFERS');
process.exit(ok ? 0 : 1);
