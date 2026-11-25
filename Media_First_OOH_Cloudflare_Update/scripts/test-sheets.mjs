import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isLargeDecrease, parseSpreadsheetSheets, stableKeyFromRecord } from '../src/sheets.js';

const seed = JSON.parse(fs.readFileSync(new URL('../data/inventory-seed.json', import.meta.url), 'utf8'));
const bySource = new Map();
for (const record of seed) {
  const source = record._source_sheet;
  if (!bySource.has(source)) bySource.set(source, []);
  bySource.get(source).push(record);
}

function cell(value, formula = null) {
  const userEnteredValue = formula ? { formulaValue: formula } : (typeof value === 'number' ? { numberValue: value } : value == null ? {} : { stringValue: String(value) });
  const effectiveValue = typeof value === 'number' ? { numberValue: value } : value == null ? {} : { stringValue: String(value) };
  return { userEnteredValue, effectiveValue, formattedValue: value == null ? '' : String(value) };
}
function makeSheet(title, records, hidden = false) {
  const keys = [...new Set(records.flatMap((r) => Object.keys(r).filter((k) => !k.startsWith('_'))))];
  const headers = keys;
  const rowData = [{ values: headers.map((h) => cell(h)) }];
  for (const r of records) rowData.push({ values: headers.map((h) => cell(r[h])) });
  return { properties: { title, hidden }, data: [{ rowData }] };
}

const sheets = [...bySource.entries()].map(([title, records]) => makeSheet(title, records));
// A hidden control tab must still configure styles for dynamically added layers.
sheets.push(makeSheet('Налаштування шарів', [{
  'Назва вкладки': 'Брендовані площини',
  'Назва шару': 'Брендовані площини',
  'Колір': '#8B5CF6',
  'Форма': 'квадрат',
  'Маркер': 'BF',
  'Тип шару': 'media',
  'Порядок': 40,
  'Активний': 'Так'
}], true));
sheets.push(makeSheet('Брендовані площини', [
  { 'Місто': 'Київ', 'ID площини': 'BR-001', 'Адреса': 'вул. Хрещатик, 1', 'Широта': 50.4501, 'Довгота': 30.5234, 'Фото': 'https://example.com/photo.jpg' },
  { 'Місто': 'Львів', 'ID площини': 'BR-002', 'Адреса': 'просп. Свободи, 1', 'Широта': 49.8397, 'Довгота': 24.0297, 'Фото': null }
], true));

const result = parseSpreadsheetSheets(sheets);
assert.equal(result.records.length, 338, 'all original records plus two added records');
const counts = Object.fromEntries(result.layers.map((l) => [l.key, l.count]));
assert.equal(counts.promo, 194);
assert.equal(counts.local, 70);
assert.equal(counts.restaurant, 72);
const custom = result.layers.find((l) => l.sourceSheet === 'Брендовані площини');
assert.ok(custom, 'hidden new tab becomes a layer');
assert.equal(custom.name, 'Брендовані площини');
assert.equal(custom.color, '#8B5CF6');
assert.equal(custom.shape, 'square');
assert.equal(custom.label, 'BF');
assert.equal(custom.count, 2);
assert.equal(new Set(result.records.map((r) => r._stable_key)).size, result.records.length, 'stable keys unique');
const originalSeedKeys = seed.map((record) => stableKeyFromRecord(record)).sort();
const parsedOriginalKeys = result.records.filter((record) => ['національна ООН', 'локальна', 'адреси ресторанів'].includes(record._source_sheet)).map((record) => record._stable_key).sort();
assert.deepEqual(parsedOriginalKeys, originalSeedKeys, 'initial seeded objects keep the same stable identities after first Google sync');
assert.ok(result.records.every((r) => r._id === ''), 'parser leaves runtime IDs to sync service');
assert.ok(result.records.every((r) => stableKeyFromRecord(r) === r._stable_key));

// Row order and insertion must not affect identities when a source ID exists.
const reversedSheets = [...bySource.entries()].map(([title, records]) => makeSheet(title, [...records].reverse()));
const reversedParsed = parseSpreadsheetSheets(reversedSheets);
const reorderedKeys = reversedParsed.records.map((record) => record._stable_key).sort();
assert.deepEqual(reorderedKeys, originalSeedKeys, 'sorting source rows preserves stable IDs');
const removedOne = parseSpreadsheetSheets([...bySource.entries()].map(([title, records]) =>
  makeSheet(title, title === 'локальна' ? records.slice(0, -1) : records)
));
assert.equal(removedOne.records.length, 335, 'monthly inventory decrease is reflected accurately');
assert.equal(isLargeDecrease(100, 50), true, 'exactly 50 percent decrease requires confirmation');
assert.equal(isLargeDecrease(101, 51), false, 'less than 50 percent decrease does not require confirmation');
assert.equal(isLargeDecrease(101, 50), true, 'more than 50 percent decrease requires confirmation');

const formulaSheet = {
  properties: { title: 'Фото-тест' },
  data: [{ rowData: [
    { values: ['Місто','Широта','Довгота','Фото'].map((x) => cell(x)) },
    { values: [cell('Київ'), cell(50.45), cell(30.52), { ...cell('Фото'), userEnteredValue: { formulaValue: '=HYPERLINK("https://example.com/a.jpg","Фото")' } }] }
  ] }]
};
const disabledSheet = makeSheet('Архів', [{ 'Місто': 'Київ', 'ID площини': 'OLD-1', 'Адреса': 'Архівна', 'Широта': 50.45, 'Довгота': 30.52 }]);
const disabledConfig = makeSheet('Налаштування шарів', [{ 'Назва вкладки': 'Архів', 'Активний': 'Ні' }], true);
assert.equal(parseSpreadsheetSheets([disabledSheet, disabledConfig]).records.length, 0, 'layer registry can explicitly disable coordinate-bearing tabs');
const formulaParsed = parseSpreadsheetSheets([formulaSheet]);
assert.equal(formulaParsed.records[0]._photo, 'https://example.com/a.jpg', 'HYPERLINK formula parsed to URL');

console.log('PASS: 336 original records parse correctly');
console.log('PASS: hidden data sheets and hidden layer registry are included');
console.log('PASS: new tabs become new dynamic layers');
console.log('PASS: custom layer configuration applies color/shape/marker');
console.log('PASS: layer registry can disable a source tab from map imports');
console.log('PASS: stable keys remain the same after sorting; monthly inventory growth/decrease is handled');
console.log('PASS: exactly 50% or greater inventory decrease requires confirmation');
console.log('PASS: keys reproduce the initial seed identities');
console.log('PASS: HYPERLINK() image URLs are extracted');
