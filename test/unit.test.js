import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanKeyword, prepareKeywords, buildRow, trendOf } from '../src/rows.js';
import { resolveLocation, resolveLanguage, COUNTRIES } from '../src/geo.js';

test('keyword clean-up: symbols/emoji removed, limits enforced', () => {
    assert.equal(cleanKeyword('Best 🎟️ Tickets!').keyword, 'best tickets');
    assert.equal(cleanKeyword('c++ (tutorial), 2026').keyword, 'c++ tutorial 2026');
    assert.equal(cleanKeyword("men's shoes & boots").keyword, "men's shoes & boots");
    assert.match(cleanKeyword('x'.repeat(81)).error, /80/);
    assert.match(cleanKeyword('a b c d e f g h i j k').error, /10 words/);
    assert.match(cleanKeyword('!!!').error, /empty/);
    const p = prepareKeywords(['A b', 'a  B', 'c', '', '🎉']);
    assert.deepEqual(p.ok.map((x) => x.keyword), ['a b', 'c']);
    assert.equal(p.duplicates, 1);
    assert.equal(p.invalid.length, 1);
});

test('locations and languages', () => {
    assert.equal(resolveLocation('us').code, 2840);
    assert.equal(resolveLocation('Germany').code, 2276);
    assert.equal(resolveLocation('uk').code, 2826);
    assert.equal(resolveLocation('india').code, 2356);
    assert.equal(resolveLocation('1023191').code, 1023191);
    assert.equal(resolveLocation(''), null);
    assert.throws(() => resolveLocation('atlantis'), /Unknown location/);
    assert.ok(COUNTRIES.length > 230);
    assert.equal(resolveLanguage('en').id, 1000);
    assert.equal(resolveLanguage('Spanish').id, 1003);
    assert.equal(resolveLanguage('zh-cn').id, 1017);
    assert.equal(resolveLanguage('1031').name, 'Russian');
    assert.equal(resolveLanguage('fa').id, null); // passed through by ISO code
    assert.equal(resolveLanguage(''), null);
});

test('rows: month names, order, nulls stay null, trend', () => {
    const r = buildRow({ search_volume: 2900, cpc: 40.371, competition: 'LOW', competition_index: 33, low_top_of_page_bid: 8.761, high_top_of_page_bid: 48.06, monthly: [{ year: 2025, month: 8, searches: 12100 }, { year: 2025, month: 7, searches: 3600 }] }, { keyword: 'event organizer software', location: { code: 2840, name: 'United States' }, language: { id: 1000, iso: 'en', name: 'English' }, source: 'google_ads' });
    assert.equal(r.cpc, 40.37);
    assert.deepEqual(r.monthly_searches, [{ year: 2025, month: 'JULY', monthly_searches: 3600 }, { year: 2025, month: 'AUGUST', monthly_searches: 12100 }]);
    assert.equal(r.location_code, '2840');
    assert.equal(r.language_code, '1000');
    const empty = buildRow(null, { keyword: 'zzz', source: 'google_ads' });
    assert.equal(empty.search_volume, null);
    assert.equal(empty.cpc, null);
    assert.equal(empty.has_data, false);
    assert.equal(empty.location_name, 'Worldwide');
    const t = trendOf(Array.from({ length: 12 }, (_, i) => ({ year: 2025, month: 'JANUARY', monthly_searches: 100 + i * 20 })));
    assert.equal(t.direction, 'rising');
});
