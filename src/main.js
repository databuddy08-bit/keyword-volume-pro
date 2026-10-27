// Keyword Search Volume Pro — bulk Google Keyword Planner metrics (volume, CPC, competition, bids, trend) and ideas.
// Batch runs write to the dataset; Standby runs serve the same data over HTTP (/volume, /ideas).
import http from 'node:http';
import { Actor, log } from 'apify';
import { DataForSeo, GoogleAds } from './providers.js';
import { makeEngine } from './engine.js';
import { prepareKeywords } from './rows.js';
import { resolveLocation, resolveLanguage } from './geo.js';

// Pay-per-event names — must match the Monetization settings exactly.
export const EVENT_KEYWORD = 'keyword-result'; // one keyword row WITH metrics (rows without data are free)
export const EVENT_AI = 'ai-volume'; // add-on: one keyword with an AI search volume number

const STOP_BEFORE_TIMEOUT_MS = 30000;
const API_MAX_KEYWORDS = 1000;
const API_MAX_SEEDS = 20;

await Actor.init();
const env = process.env;
const stats = { dataforseoCalls: 0, dataforseoRateLimited: 0, dataforseoCost: 0, googleAdsCalls: 0, googleAdsRateLimited: 0, fallbackUsed: 0, aiErrors: 0, aiUnavailable: 0 };
const dfs = new DataForSeo({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD, base: env.DATAFORSEO_BASE, stats });
const gads = new GoogleAds({ env, base: env.GOOGLE_ADS_BASE, oauthUrl: env.GOOGLE_OAUTH_URL, stats });
const engine = makeEngine({ dfs, gads, stats });
const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();

const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]/) : []).map((x) => String(x ?? '')).filter((x) => x.trim());
const bool = (v, d) => (v === undefined || v === null || v === '' ? d : v === true || v === 'true' || v === '1' || v === 1);
const int = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.floor(Number(v)) : d));

/** Shared option parsing (batch input and HTTP query/body). Throws a clear message on bad geo/language. */
function parseOptions(i) {
    const network = String(i.network ?? 'google_search').toLowerCase();
    return {
        mode: i.mode === 'ideas' ? 'ideas' : 'metrics',
        location: resolveLocation(i.geo ?? i.location),
        language: resolveLanguage(i.language),
        searchPartners: /partner/.test(network),
        includeTrend: bool(i.includeTrend, true),
        aiVolume: bool(i.aiVolume, false),
        months: [12, 24, 36, 48].includes(Number(i.trendMonths)) ? Number(i.trendMonths) : 12,
        maxIdeas: int(i.maxIdeas, 100, 1, 20000),
        minSearchVolume: int(i.minSearchVolume, 0, 0, 1e9),
        negativeKeywords: list(i.negativeKeywords).map((x) => x.trim()),
        sortBy: i.sortBy === 'relevance' ? 'relevance' : 'search_volume',
        includeAdult: bool(i.includeAdultKeywords, false),
    };
}

/** How many of these rows still fit under "Maximum cost per run" (keyword + AI events together). */
function rowsWithinBudget(rows) {
    if (!pricing.isPayPerEvent) return rows.length;
    const maxK = charging.calculateMaxEventChargeCountWithinLimit(EVENT_KEYWORD);
    const maxA = charging.calculateMaxEventChargeCountWithinLimit(EVENT_AI);
    let k = 0;
    let a = 0;
    let n = 0;
    for (const r of rows) {
        const nk = k + 1;
        const na = a + (r.ai_search_volume !== null && r.ai_search_volume !== undefined ? 1 : 0);
        const share = (Number.isFinite(maxK) ? nk / maxK : 0) + (Number.isFinite(maxA) ? na / maxA : 0);
        if (share > 1 + 1e-9) break;
        k = nk;
        a = na;
        n += 1;
    }
    return n;
}

if (Actor.config.get('metaOrigin') === 'STANDBY') {
    await runStandby();
} else {
    await runBatch();
}

// ================================================================================================================
async function runBatch() {
    const input = (await Actor.getInput()) ?? {};
    const startedAt = Date.now();
    const { timeoutAt } = Actor.getEnv();
    const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
    let stopReason = null;
    const stop = (r) => {
        if (!stopReason) {
            stopReason = r;
            log.info(`Stopping: ${r}`);
        }
    };

    let o;
    try {
        o = parseOptions(input);
    } catch (err) {
        await Actor.pushData({ errorCode: 'INVALID_INPUT', error: err.message });
        await Actor.fail(err.message);
    }
    const raw = list(input.keywords);
    if (!raw.length) await Actor.fail('Add at least one keyword in "Keywords".');
    if (!engine.sources().length) await Actor.fail('This Actor has no data source configured (developer setting). Please report it in the Issues tab.');
    const prepared = prepareKeywords(raw);
    log.info(`${o.mode === 'ideas' ? 'Ideas' : 'Metrics'} mode: ${prepared.ok.length} unique keyword(s)${prepared.duplicates ? ` (${prepared.duplicates} duplicates removed)` : ''}${prepared.invalid.length ? `, ${prepared.invalid.length} not accepted by Google Ads` : ''}. Market: ${o.location?.name ?? 'Worldwide'} / ${o.language?.name ?? 'all languages'}${o.searchPartners ? ' (incl. search partners)' : ''}.`);

    const summary = {
        mode: o.mode, startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationSec: null, stopReason: null,
        keywordsGiven: raw.length, uniqueKeywords: prepared.ok.length, duplicatesRemoved: prepared.duplicates, invalidKeywords: 0,
        rowsSaved: 0, rowsWithData: 0, rowsWithoutData: 0, ideasFound: null, chargedEvents: { [EVENT_KEYWORD]: 0, [EVENT_AI]: 0 },
        rowsBySource: {}, market: { location: o.location?.name ?? 'Worldwide', location_code: o.location?.code ?? null, language: o.language?.name ?? 'All languages', language_code: o.language?.id ?? o.language?.iso ?? null, network: o.searchPartners ? 'google_search_and_partners' : 'google_search' },
        aiVolume: o.aiVolume ? { rowsWithAiVolume: 0 } : undefined, fillRates: null, calls: stats,
    };
    const fills = {};
    let chain = Promise.resolve();

    /** Saves rows in order: rows with data are charged, rows without data are free. */
    const saveRows = (rows) => {
        chain = chain.then(async () => {
            if (stopReason) return;
            if (Date.now() >= deadline) stop('timeout_approaching');
            const withData = rows.filter((r) => r.has_data);
            const empty = rows.filter((r) => !r.has_data);
            const fit = rowsWithinBudget(withData);
            const charged = withData.slice(0, fit);
            if (charged.length) {
                const res = await Actor.pushData(charged, EVENT_KEYWORD);
                summary.chargedEvents[EVENT_KEYWORD] += res?.chargedCount ?? 0;
                const ai = charged.filter((r) => r.ai_search_volume !== null && r.ai_search_volume !== undefined).length;
                if (ai) {
                    const r2 = await charging.charge({ eventName: EVENT_AI, count: ai });
                    summary.chargedEvents[EVENT_AI] += r2?.chargedCount ?? 0;
                }
            }
            if (empty.length) await Actor.pushData(empty);
            for (const r of [...charged, ...empty]) {
                summary.rowsSaved += 1;
                summary[r.has_data ? 'rowsWithData' : 'rowsWithoutData'] += 1;
                summary.rowsBySource[r.source] = (summary.rowsBySource[r.source] ?? 0) + 1;
                for (const f of ['search_volume', 'cpc', 'competition', 'low_top_of_page_bid', 'monthly_searches', ...(o.aiVolume ? ['ai_search_volume'] : [])]) if (r[f] !== null && r[f] !== undefined) fills[f] = (fills[f] ?? 0) + 1;
                if (summary.aiVolume && r.ai_search_volume !== null && r.ai_search_volume !== undefined) summary.aiVolume.rowsWithAiVolume += 1;
            }
            if (fit < withData.length) stop('max_cost_per_run_reached');
            log.info(`Saved ${summary.rowsSaved} rows (${summary.rowsWithData} with metrics).`);
        });
        return chain;
    };

    const invalidRows = (items) => items.map((x) => ({ keyword: x.keyword || null, input_keyword: x.input, has_data: false, errorCode: 'INVALID_KEYWORD', error: x.error }));
    try {
        if (o.mode === 'ideas') {
            const res = await engine.ideas(prepared.ok, o);
            summary.ideasFound = res.found;
            await saveRows(res.rows);
            if (!res.rows.length) await Actor.pushData({ keyword: null, has_data: false, errorCode: 'NO_IDEAS', error: `No keyword ideas found for: ${prepared.ok.map((x) => x.keyword).join(', ')}${o.minSearchVolume ? ` (minimum volume ${o.minSearchVolume})` : ''}` });
        } else {
            const { invalid } = await engine.metrics(prepared.ok, o, saveRows, { shouldStop: () => Boolean(stopReason) || Date.now() >= deadline });
            prepared.invalid.push(...invalid);
        }
    } catch (err) {
        await chain;
        log.error(`Run failed: ${err.message}`);
        summary.error = err.message;
        await Actor.setValue('RUN_SUMMARY', summary);
        await Actor.fail(`No data source answered: ${err.message}`);
    }
    await chain;
    if (prepared.invalid.length) await Actor.pushData(invalidRows(prepared.invalid)); // free
    summary.invalidKeywords = prepared.invalid.length;
    summary.stopReason = stopReason ?? 'completed';
    summary.finishedAt = new Date().toISOString();
    summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
    summary.fillRates = summary.rowsSaved ? Object.fromEntries(Object.entries(fills).map(([k, v]) => [k, `${Math.round((v / summary.rowsSaved) * 100)}%`])) : null;
    const { dataforseoCost, ...calls } = stats;
    summary.calls = calls;
    log.debug(`Primary source cost this run: $${dataforseoCost.toFixed(4)}`);
    await Actor.setValue('RUN_SUMMARY', summary);
    const msg = `Saved ${summary.rowsSaved} keyword rows (${summary.rowsWithData} with metrics, ${summary.rowsWithoutData} without data — not charged)${summary.invalidKeywords ? `, ${summary.invalidKeywords} keywords not accepted by Google Ads` : ''}. Stop reason: ${summary.stopReason}.`;
    log.info(msg);
    await Actor.exit({ statusMessage: msg });
}

// ================================================================================================================
async function runStandby() {
    const port = Actor.config.get('containerPort') ?? Number(env.ACTOR_WEB_SERVER_PORT ?? 4321);
    const send = (res, status, obj, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
        res.end(JSON.stringify(obj));
    };
    const fail = (res, status, code, message, headers) => send(res, status, { error: { code, message } }, headers);
    const readBody = (req) => new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch {
                resolve(null);
            }
        });
    });

    const charge = async (rows) => {
        const withData = rows.filter((r) => r.has_data);
        const ai = withData.filter((r) => r.ai_search_volume !== null && r.ai_search_volume !== undefined).length;
        if (withData.length) await charging.charge({ eventName: EVENT_KEYWORD, count: withData.length }).catch((e) => log.warning(`charge failed: ${e.message}`));
        if (ai) await charging.charge({ eventName: EVENT_AI, count: ai }).catch((e) => log.warning(`charge failed: ${e.message}`));
        return { keyword_results: withData.length, ai_volume: ai };
    };

    const server = http.createServer(async (req, res) => {
        if (req.headers['x-apify-container-server-readiness-probe']) {
            res.writeHead(200).end('ready');
            return;
        }
        const url = new URL(req.url, 'http://localhost');
        const t0 = Date.now();
        try {
            const params = Object.fromEntries(url.searchParams);
            if (req.method === 'POST') {
                const body = await readBody(req);
                if (body === null) return fail(res, 400, 'invalid_json', 'The request body is not valid JSON.');
                Object.assign(params, body);
            }
            const path = url.pathname.replace(/\/+$/, '') || '/';
            if (path === '/') {
                return send(res, 200, {
                    name: 'Keyword Search Volume Pro API',
                    endpoints: {
                        'GET /volume': { keywords: `comma-separated, up to ${API_MAX_KEYWORDS}`, geo: 'us | germany | 2840', language: 'en | es | 1000', network: 'google_search | google_search_and_partners', includeTrend: 'true', aiVolume: 'false', trendMonths: '12 | 24 | 36 | 48' },
                        'GET /ideas': { seeds: `comma-separated, up to ${API_MAX_SEEDS}`, maxIdeas: '1-1000 (default 50)', minSearchVolume: '0', negativeKeywords: 'comma-separated', sortBy: 'search_volume | relevance', geo: '…', language: '…', network: '…', includeTrend: 'true', aiVolume: 'false' },
                    },
                    note: 'POST with a JSON body works too (keywords / seeds as arrays).',
                });
            }
            if (!['/volume', '/ideas'].includes(path)) return fail(res, 404, 'not_found', 'Use /volume or /ideas.');
            if (!engine.sources().length) return fail(res, 503, 'unavailable', 'The data service is unavailable. Retry later.', { 'retry-after': '60' });
            let o;
            try {
                o = parseOptions({ ...params, mode: path === '/ideas' ? 'ideas' : 'metrics', maxIdeas: params.maxIdeas ?? 50 });
            } catch (err) {
                return fail(res, 400, 'invalid_parameter', err.message);
            }
            const words = list(path === '/ideas' ? params.seeds ?? params.keywords : params.keywords);
            const limit = path === '/ideas' ? API_MAX_SEEDS : API_MAX_KEYWORDS;
            if (!words.length) return fail(res, 400, 'missing_parameter', path === '/ideas' ? 'Add seeds=keyword1,keyword2' : 'Add keywords=keyword1,keyword2');
            if (words.length > limit) return fail(res, 400, 'too_many_keywords', `Up to ${limit} ${path === '/ideas' ? 'seeds' : 'keywords'} per request. Use a batch run for bigger lists.`);
            if (path === '/ideas') o.maxIdeas = Math.min(o.maxIdeas, 1000);
            const prepared = prepareKeywords(words);
            let rows = [];
            if (path === '/ideas') {
                if (prepared.ok.length) rows = (await engine.ideas(prepared.ok, o)).rows;
            } else if (prepared.ok.length) {
                const r = await engine.metrics(prepared.ok, o, async (batch) => { rows.push(...batch); }, { concurrency: 1 });
                prepared.invalid.push(...r.invalid);
            }
            const charged = await charge(rows);
            return send(res, 200, {
                rows,
                count: rows.length,
                invalid: prepared.invalid.map((x) => ({ input_keyword: x.input, error: x.error })),
                charged,
                market: { location: o.location?.name ?? 'Worldwide', language: o.language?.name ?? 'All languages' },
                ms: Date.now() - t0,
            });
        } catch (err) {
            log.warning(`${req.method} ${req.url}: ${err.message}`);
            if (err.kind === 'down' || err.kind === 'retry') return fail(res, 503, 'unavailable', 'The data service is briefly unavailable. Retry shortly.', { 'retry-after': '30' });
            return fail(res, 500, 'internal_error', 'Unexpected error. Retry; if it repeats, report it in the Issues tab.');
        }
    });
    server.listen(port, () => log.info(`Standby API listening on port ${port}.`));
}
