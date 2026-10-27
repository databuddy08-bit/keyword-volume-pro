// Fake DataForSEO + Google Ads API + Google OAuth, shaped after the official docs, for end-to-end tests.
import http from 'node:http';

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
/** Deterministic metrics per keyword; keywords starting with "zzz" have no data. */
export function fake(keyword) {
    if (keyword.startsWith('zzz')) return null;
    const h = hash(keyword);
    const vol = [10, 90, 320, 1300, 2900, 9900, 40500][h % 7];
    const monthly = Array.from({ length: 12 }, (_, i) => ({ year: 2025 + Math.floor((i + 9) / 12), month: ((i + 9) % 12) + 1, search_volume: Math.round(vol * (0.6 + ((h >> i) % 9) / 10)) }));
    return { search_volume: vol, cpc: (h % 5000) / 100, competition: ['LOW', 'MEDIUM', 'HIGH'][h % 3], competition_index: h % 101, low: (h % 900) / 100, high: (h % 9000) / 100, monthly };
}

export async function startMock({ dfsRateLimitEvery = 0 } = {}) {
    const hits = { dfs: [], gads: [], oauth: 0 };
    let dfsCalls = 0;
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        const url = new URL(req.url, 'http://x');

        // ---------- Google OAuth ----------
        if (url.pathname === '/oauth/token') {
            hits.oauth += 1;
            const p = new URLSearchParams(body);
            if (p.get('refresh_token') !== 'good-refresh') return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
            return json(200, { access_token: 'tok123', expires_in: 3599, token_type: 'Bearer' });
        }

        // ---------- DataForSEO ----------
        if (url.pathname.startsWith('/v3/')) {
            dfsCalls += 1;
            const auth = Buffer.from(String(req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString();
            const [task] = JSON.parse(body || '[{}]');
            hits.dfs.push({ path: url.pathname, task });
            const envelope = (code, msg, result, cost = 0.09) => json(200, { version: '0.1.20261001', status_code: code >= 40000 && code < 40300 && code !== 40202 && code !== 40209 ? code : 20000, status_message: code === 20000 ? 'Ok.' : msg, time: '0.5 sec.', cost, tasks_count: 1, tasks_error: code === 20000 ? 0 : 1, tasks: [{ id: 'abc', status_code: code, status_message: msg, time: '0.4 sec.', cost: code === 20000 ? cost : 0, result_count: result ? 1 : 0, path: url.pathname.split('/').filter(Boolean), data: task, result: result ?? null }] });
            if (auth === 'bad:creds') return envelope(40100, 'You are not authorized to access this resource.');
            if (auth === 'broke:creds') return envelope(40210, 'Insufficient funds. Please top up your balance.');
            if (dfsRateLimitEvery && dfsCalls % dfsRateLimitEvery === 0) return envelope(40202, 'Rate limit per minute exceeded.');
            const kws = task.keywords ?? [];
            if (url.pathname.endsWith('/search_volume/live')) {
                if (kws.length > 1000) return envelope(40501, "Invalid Field: 'keywords'. Max 1000.");
                if (kws.some((k) => k.includes('badword'))) return envelope(40501, "Invalid Field: 'keywords'.");
                return envelope(20000, 'Ok.', kws.map((k) => {
                    const f = fake(k.toLowerCase());
                    return { keyword: k.toLowerCase(), spell: k === 'iphnoe' ? 'iphone' : null, location_code: task.location_code ?? null, language_code: task.language_name ? 'en' : null, search_partners: Boolean(task.search_partners), competition: f?.competition ?? null, competition_index: f?.competition_index ?? null, search_volume: f?.search_volume ?? null, low_top_of_page_bid: f?.low ?? null, high_top_of_page_bid: f?.high ?? null, cpc: f?.cpc ?? null, monthly_searches: f ? [...f.monthly].reverse() : null };
                }));
            }
            if (url.pathname.endsWith('/keywords_for_keywords/live')) {
                if (kws.length > 20) return envelope(40501, "Invalid Field: 'keywords'. Max 20.");
                const ideas = kws.flatMap((s) => Array.from({ length: 150 }, (_, i) => `${s} idea ${i}`)).concat(kws);
                const items = ideas.map((k) => {
                    const f = fake(k);
                    return { keyword: k, location_code: task.location_code ?? null, language_code: 'en', search_partners: false, competition: f?.competition ?? null, competition_index: f?.competition_index ?? null, search_volume: f?.search_volume ?? null, low_top_of_page_bid: f?.low ?? null, high_top_of_page_bid: f?.high ?? null, cpc: f?.cpc ?? null, monthly_searches: f ? f.monthly : null };
                }).sort((a, b) => (b.search_volume ?? -1) - (a.search_volume ?? -1));
                return envelope(20000, 'Ok.', items);
            }
            if (url.pathname.endsWith('/ai_keyword_data/keywords_search_volume/live')) {
                if (!task.location_code || !(task.language_code || task.language_name)) return envelope(40501, "Invalid Field: 'location_code'.");
                return envelope(20000, 'Ok.', [{ location_code: task.location_code, language_code: 'en', items_count: kws.length, items: kws.filter((k) => !k.includes('noai')).map((k) => ({ keyword: k, ai_search_volume: hash(k) % 2000, ai_monthly_searches: Array.from({ length: 12 }, (_, i) => ({ year: 2026, month: 12 - i, ai_search_volume: (hash(k) >> i) % 2000 })) })) }], 0.01 + kws.length * 0.0001);
            }
            return envelope(40400, 'Not Found.');
        }

        // ---------- Google Ads API ----------
        const m = url.pathname.match(/^\/(v\d+)\/customers\/(\d+)(:\w+|\/googleAds:search)$/);
        if (m) {
            const [, ver, cid, method] = m;
            hits.gads.push({ ver, method, body: body ? JSON.parse(body) : null });
            if (ver === 'v26') return json(404, { error: { code: 404, message: 'Not Found', status: 'NOT_FOUND' } });
            if (req.headers.authorization !== 'Bearer tok123') return json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
            if (req.headers['developer-token'] !== 'devtok') return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Developer token not approved' } });
            if (cid !== '1234567890') return json(403, { error: { code: 403, status: 'PERMISSION_DENIED' } });
            const b = JSON.parse(body);
            const km = (k) => {
                const f = fake(k);
                if (!f) return undefined;
                return { avgMonthlySearches: String(f.search_volume), competition: f.competition, competitionIndex: String(f.competition_index), lowTopOfPageBidMicros: String(Math.round(f.low * 1e6)), highTopOfPageBidMicros: String(Math.round(f.high * 1e6)), averageCpcMicros: String(Math.round(f.cpc * 1e6)), monthlySearchVolumes: f.monthly.map((x) => ({ month: MONTHS[x.month - 1], year: String(x.year), monthlySearches: String(x.search_volume) })) };
            };
            if (method === ':generateKeywordHistoricalMetrics') {
                const results = [];
                const done = new Set();
                for (const k of b.keywords) {
                    if (done.has(k)) continue;
                    if (k === 'running shoe' || k === 'running shoes') { // Google merges close variants
                        done.add('running shoe');
                        done.add('running shoes');
                        results.push({ text: 'running shoes', closeVariants: ['running shoe'], keywordMetrics: km('running shoes') });
                        continue;
                    }
                    done.add(k);
                    results.push({ text: k, keywordMetrics: km(k) });
                }
                return json(200, { results, aggregateMetricResults: {} });
            }
            if (method === ':generateKeywordIdeas') {
                const seeds = b.keywordSeed.keywords;
                const all = seeds.flatMap((s) => Array.from({ length: 120 }, (_, i) => `${s} gads idea ${i}`));
                const start = Number(b.pageToken ?? 0);
                const page = all.slice(start, start + Math.min(b.pageSize ?? 100, 100));
                return json(200, { results: page.map((t) => ({ text: t, keywordIdeaMetrics: km(t) })), nextPageToken: start + 100 < all.length ? String(start + 100) : undefined, totalSize: String(all.length) });
            }
            if (method === '/googleAds:search') return json(200, { results: [{ languageConstant: { resourceName: 'languageConstants/1064', id: '1064' } }] });
        }
        json(404, { error: 'unknown path' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, hits, close: () => server.close() };
}
