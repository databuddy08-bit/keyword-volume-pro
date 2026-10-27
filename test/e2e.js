// End-to-end tests: the real actor against fake DataForSEO / Google Ads APIs. `npm run test:e2e [scenario...]`
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock-apis.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PRICING = JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { 'keyword-result': { eventPriceUsd: 0.006, eventTitle: 'k' }, 'ai-volume': { eventPriceUsd: 0.002, eventTitle: 'a' } } } });
const readDir = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []);
const mock = await startMock();
const ENV = (extra = {}) => ({
    ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '',
    DATAFORSEO_BASE: mock.base, DATAFORSEO_LOGIN: 'good', DATAFORSEO_PASSWORD: 'creds', DATAFORSEO_WINDOW_MS: '2000', HTTP_BACKOFF_SCALE: '0.01',
    GOOGLE_ADS_BASE: mock.base, GOOGLE_OAUTH_URL: `${mock.base}/oauth/token`, GOOGLE_ADS_DEVELOPER_TOKEN: 'devtok', GOOGLE_ADS_CLIENT_ID: 'cid', GOOGLE_ADS_CLIENT_SECRET: 'sec', GOOGLE_ADS_REFRESH_TOKEN: 'good-refresh', GOOGLE_ADS_CUSTOMER_ID: '123-456-7890',
    ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_USE_CHARGING_LOG_DATASET: 'true', APIFY_ACTOR_PRICING_INFO: PRICING, APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
    ...extra,
});

async function run(name, input, extraEnv = {}) {
    const dir = join(ROOT, 'storage-test', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify(input));
    const t0 = Date.now();
    const child = spawn('node', ['src/main.js'], { cwd: ROOT, env: ENV({ CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, CRAWLEE_PURGE_ON_START: '0', ...extraEnv }) });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const code = await new Promise((r) => child.on('close', r));
    writeFileSync(join(dir, 'run.log'), logs);
    const rows = readDir(join(dir, 'datasets', 'default'));
    const charges = readDir(join(dir, 'datasets', 'charging_log'));
    const cnt = (e) => charges.filter((c) => c.eventName === e).reduce((s, c) => s + (c.chargedCount ?? c.count ?? 1), 0);
    const sumFile = join(dir, 'key_value_stores', 'default', 'RUN_SUMMARY.json');
    return { code, rows, data: rows.filter((r) => r.has_data), empty: rows.filter((r) => r.has_data === false && !r.errorCode), errors: rows.filter((r) => r.errorCode), kCharged: cnt('keyword-result'), aiCharged: cnt('ai-volume'), summary: existsSync(sumFile) ? JSON.parse(readFileSync(sumFile, 'utf8')) : null, logs, secs: (Date.now() - t0) / 1000 };
}

const results = [];
const check = (label, pass, detail = '') => {
    results.push(Boolean(pass));
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);

if (want('metrics')) {
    console.log('\n=== 1. METRICS: fields, order, trend, clean-up, free rows ===');
    const r = await run('metrics', { keywords: ['Event Ticketing', 'sell tickets online', 'event ticketing', '  SELL tickets   online ', 'zzz nothing here', 'best 🎟️ tickets!', 'iphnoe', 'x'.repeat(90), 'a b c d e f g h i j k l'], geo: 'us', language: 'en' });
    const row = r.data.find((x) => x.keyword === 'event ticketing');
    check('one row per unique keyword (duplicates by case/spaces removed)', r.rows.filter((x) => x.keyword === 'event ticketing').length === 1 && r.summary.duplicatesRemoved === 2, JSON.stringify(r.summary?.duplicatesRemoved));
    check('original field set: search_volume, cpc, competition, index, bids, monthly_searches, search_partners, language_code 1000, location_code 2840, source google_ads', row && ['search_volume', 'cpc', 'competition', 'competition_index', 'low_top_of_page_bid', 'high_top_of_page_bid', 'monthly_searches', 'search_partners'].every((k) => k in row) && row.language_code === '1000' && row.location_code === '2840' && row.source === 'google_ads', JSON.stringify(row)?.slice(0, 300));
    check('monthly_searches oldest -> newest, month names, {year, month, monthly_searches}', row.monthly_searches.length === 12 && row.monthly_searches[0].year <= row.monthly_searches[11].year && /^[A-Z]+$/.test(row.monthly_searches[0].month) && 'monthly_searches' in row.monthly_searches[0], JSON.stringify(row.monthly_searches.slice(0, 2)));
    check('trend summary (direction, change %, peak month)', row.trend && ['rising', 'falling', 'stable'].includes(row.trend.direction) && /^\d{4}-\d{2}$/.test(row.trend.peak_month), JSON.stringify(row.trend));
    check('emoji/symbols removed (input_keyword kept); spelling fix surfaced', r.data.some((x) => x.keyword === 'best tickets' && x.input_keyword === 'best 🎟️ tickets!') && r.data.find((x) => x.keyword === 'iphnoe')?.spell === 'iphone');
    check('no-data keyword saved with nulls (never fake zeros) and NOT charged', r.empty.length === 1 && r.empty[0].search_volume === null && r.kCharged === r.data.length, `charged ${r.kCharged}, data rows ${r.data.length}`);
    check('too long / too many words -> free INVALID_KEYWORD rows', r.errors.filter((x) => x.errorCode === 'INVALID_KEYWORD').length === 2);
    check('one API call for all keywords', mock.hits.dfs.filter((h) => h.path.endsWith('search_volume/live')).length >= 1 && r.summary.calls.dataforseoCalls === 1, JSON.stringify(r.summary.calls));
}

if (want('bulk')) {
    console.log('\n=== 2. BULK: 2,500 keywords, batches of 1,000, rate limit respected, a bad keyword isolated ===');
    const kws = Array.from({ length: 2500 }, (_, i) => `keyword number ${i}`);
    kws[1700] = 'badword example';
    const r = await run('bulk', { keywords: kws, geo: 'germany', language: 'german' }, { DATAFORSEO_LIVE_PER_MINUTE: '2' });
    check('2,499 rows + 1 rejected keyword reported free', r.rows.filter((x) => x.keyword && !x.errorCode).length === 2499 && r.errors.some((x) => x.input_keyword === 'badword example'), `${r.rows.length} rows`);
    check('geo "germany" -> 2276, language "german" -> 1001', r.data[0].location_code === '2276' && r.data[0].language_code === '1001' && r.data[0].location_name === 'Germany');
    check('batches split around the rejected keyword (no keyword lost)', r.summary.calls.dataforseoCalls >= 3 && r.summary.calls.dataforseoCalls <= 25, JSON.stringify(r.summary.calls));
    check('rate limiter: 2 calls per 2 s window -> took > 2 s', r.secs > 2, `${r.secs}s`);
}

if (want('fallback')) {
    console.log('\n=== 3. FALLBACK: primary down -> Google Ads API (version auto-detect, close variants, micros) ===');
    const r = await run('fallback', { keywords: ['running shoe', 'running shoes', 'trail runners', 'zzz none'], geo: 'us', language: 'en' }, { DATAFORSEO_LOGIN: 'bad' });
    const a = r.data.find((x) => x.keyword === 'running shoe');
    const b = r.data.find((x) => x.keyword === 'running shoes');
    check('rows served by the backup, source "fallback"', r.data.length === 3 && r.data.every((x) => x.source === 'fallback'), JSON.stringify(r.summary?.rowsBySource));
    check('close variants: both inputs get the merged metrics + close_variants listed', a && b && a.search_volume === b.search_volume && a.close_variants?.includes('running shoe'));
    check('CPC and bids converted from micros; month names kept', typeof a.cpc === 'number' && a.cpc < 100 && /^[A-Z]+$/.test(a.monthly_searches[0].month));
    check('API version auto-detected (v26 missing -> v25 used)', mock.hits.gads.some((h) => h.ver === 'v25') && r.logs.includes('Google Ads API v25 in use'));
    const both = await run('both-down', { keywords: ['test'] }, { DATAFORSEO_LOGIN: 'bad', GOOGLE_ADS_REFRESH_TOKEN: 'expired' });
    check('both sources down -> run fails with a clear reason', both.code !== 0 && /No data source answered/.test(both.logs));
    const broke = await run('broke', { keywords: ['test keyword'] }, { DATAFORSEO_LOGIN: 'broke' });
    check('primary out of balance -> backup used', broke.data[0]?.source === 'fallback');
}

if (want('ideas')) {
    console.log('\n=== 4. IDEAS: cap, filters, seeds, >20 seeds ===');
    const r = await run('ideas', { keywords: ['web scraping', 'data extraction'], mode: 'ideas', maxIdeas: 50, minSearchVolume: 100, negativeKeywords: ['idea 1'], geo: 'us', language: 'en' });
    check('capped at maxIdeas (50), all charged', r.data.length === 50 && r.kCharged === 50, `${r.data.length} rows, ${r.kCharged} charged`);
    check('sorted by volume, minSearchVolume respected, negative keyword excluded', r.data.every((x, i, a) => !i || a[i - 1].search_volume >= x.search_volume) && r.data.every((x) => x.search_volume >= 100) && !r.data.some((x) => x.keyword.includes('idea 1')));
    check('each idea lists its seed keywords', r.data.every((x) => x.seed_keywords?.length));
    const many = await run('ideas-many', { keywords: Array.from({ length: 25 }, (_, i) => `seed ${i}`), mode: 'ideas', maxIdeas: 2000 });
    check('25 seeds -> 2 tasks (20 per task), worldwide rows have null codes', many.summary.calls.dataforseoCalls === 2 && many.data.length === 2000 && many.data[0].location_code === null && many.data[0].location_name === 'Worldwide', JSON.stringify(many.summary.calls));
    const fb = await run('ideas-fallback', { keywords: ['yoga mats'], mode: 'ideas', maxIdeas: 30 }, { DATAFORSEO_LOGIN: 'bad' });
    check('ideas via the backup (paged), source fallback', fb.data.length === 30 && fb.data.every((x) => x.source === 'fallback'));
}

if (want('ai')) {
    console.log('\n=== 5. AI VOLUME add-on ===');
    const r = await run('ai', { keywords: ['web scraping', 'noai keyword', 'zzz nada'], aiVolume: true, geo: 'us', language: 'en' });
    const w = r.data.find((x) => x.keyword === 'web scraping');
    check('ai_search_volume + ai_monthly_searches (oldest -> newest, month names)', Number.isInteger(w.ai_search_volume) && w.ai_monthly_searches.length === 12 && w.ai_monthly_searches[0].month === 'JANUARY');
    check('AI event charged only for keywords with an AI number', r.aiCharged === 1, `ai charged ${r.aiCharged}`);
    const ww = await run('ai-world', { keywords: ['web scraping'], aiVolume: true });
    check('worldwide run: AI volume uses United States / English and says so', ww.data[0].ai_market === 'United States / English');
}

if (want('budget')) {
    console.log('\n=== 6. MAX COST + INPUT ERRORS ===');
    const r = await run('budget', { keywords: Array.from({ length: 10 }, (_, i) => `budget kw ${i}`) }, { ACTOR_MAX_TOTAL_CHARGE_USD: '4' }); // locally every event costs $1
    check('stops at Maximum cost per run (4 rows), stop reason recorded', r.kCharged === 4 && r.summary.stopReason === 'max_cost_per_run_reached', `${r.kCharged} charged`);
    const bad = await run('bad-geo', { keywords: ['x'], geo: 'atlantis' });
    check('unknown country -> INVALID_INPUT row + clear failure', bad.code !== 0 && bad.errors[0]?.errorCode === 'INVALID_INPUT');
    const none = await run('no-sources', { keywords: ['x'] }, { DATAFORSEO_LOGIN: '', GOOGLE_ADS_DEVELOPER_TOKEN: '' });
    check('no credentials configured -> clear failure', none.code !== 0 && /no data source configured/i.test(none.logs));
}

if (want('standby')) {
    console.log('\n=== 7. STANDBY HTTP API ===');
    const port = 4790 + Math.floor(Math.random() * 100);
    const dir = join(ROOT, 'storage-test', 'standby');
    rmSync(dir, { recursive: true, force: true });
    const child = spawn('node', ['src/main.js'], { cwd: ROOT, env: ENV({ APIFY_META_ORIGIN: 'STANDBY', ACTOR_WEB_SERVER_PORT: String(port), APIFY_CONTAINER_PORT: String(port), CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir }) });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50 && !logs.includes('listening'); i++) await new Promise((r) => setTimeout(r, 200));
    const get = async (p, init) => { const res = await fetch(base + p, init); return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }; };
    const probe = await fetch(base, { headers: { 'x-apify-container-server-readiness-probe': '1' } });
    check('readiness probe answered', probe.status === 200);
    const t0 = Date.now();
    const v = await get('/volume?keywords=web%20scraping,event%20ticketing,zzz%20none&geo=us&language=en');
    check('/volume returns rows in the response, quickly; charges only rows with data', v.status === 200 && v.body.count === 3 && v.body.charged.keyword_results === 2 && Date.now() - t0 < 3000, JSON.stringify(v.body?.charged));
    const i = await get('/ideas?seeds=web%20scraping&geo=es&language=es&maxIdeas=20');
    check('/ideas maxIdeas respected; geo es -> 2724, language es -> 1003', i.status === 200 && i.body.count === 20 && i.body.rows[0].location_code === '2724' && i.body.rows[0].language_code === '1003');
    const post = await get('/volume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keywords: ['a b', 'c d'], includeTrend: false }) });
    check('POST JSON works; includeTrend=false drops monthly_searches', post.status === 200 && post.body.rows.every((r) => !('monthly_searches' in r)));
    const e1 = await get('/volume?geo=us');
    const e2 = await get(`/volume?keywords=${Array.from({ length: 1001 }, (_, n) => `k${n}`).join(',')}`);
    const e3 = await get('/volume?keywords=x&geo=atlantis');
    check('errors as {"error":{"code","message"}} with 400s', e1.status === 400 && e1.body.error.code === 'missing_parameter' && e2.status === 400 && e2.body.error.code === 'too_many_keywords' && e3.body.error.code === 'invalid_parameter');
    child.kill();
}

mock.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
