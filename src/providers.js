// Data sources: DataForSEO (primary) and the Google Ads API (backup). Both return Google Ads Keyword Planner data.
import { log } from 'apify';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * Number(process.env.HTTP_BACKOFF_SCALE ?? 1))));

export class ProviderError extends Error {
    /** @param kind 'down' (auth, balance, config: stop using this source), 'retry' (temporary), 'bad_keywords', 'other' */
    constructor(message, kind = 'other', extra = {}) {
        super(message);
        this.kind = kind;
        Object.assign(this, extra);
    }
}

/** Sliding-window limiter: at most `max` calls per `windowMs` (DataForSEO: 12 Google Ads Live calls per minute). */
class WindowLimiter {
    constructor(max, windowMs) {
        this.max = max;
        this.windowMs = windowMs;
        this.calls = [];
        this.chain = Promise.resolve();
    }

    take() {
        const p = this.chain.then(async () => {
            for (;;) {
                const now = Date.now();
                this.calls = this.calls.filter((t) => now - t < this.windowMs);
                if (this.calls.length < this.max) {
                    this.calls.push(now);
                    return;
                }
                await sleep(this.windowMs - (now - this.calls[0]) + 50);
            }
        });
        this.chain = p.catch(() => {});
        return p;
    }
}

const monthsAgo = (n) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - n);
    return d;
};
const ymd = (d) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------
export class DataForSeo {
    constructor({ login, password, base, stats }) {
        this.base = (base ?? 'https://api.dataforseo.com').replace(/\/$/, '');
        this.auth = login && password ? `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}` : null;
        this.stats = stats;
        const perMinute = Number(process.env.DATAFORSEO_LIVE_PER_MINUTE ?? 12);
        this.adsLimiter = new WindowLimiter(perMinute, Number(process.env.DATAFORSEO_WINDOW_MS ?? 60000));
        this.down = null;
    }

    get configured() {
        return Boolean(this.auth);
    }

    /** One Live task. Returns the task's `result` array. */
    async task(path, task, { ads = true } = {}) {
        if (this.down) throw new ProviderError(this.down, 'down');
        let last;
        for (let attempt = 0; attempt < 6; attempt++) {
            if (ads) await this.adsLimiter.take();
            this.stats.dataforseoCalls += 1;
            let res;
            let body;
            try {
                res = await fetch(`${this.base}${path}`, { method: 'POST', headers: { authorization: this.auth, 'content-type': 'application/json' }, body: JSON.stringify([task]), signal: AbortSignal.timeout(90000) });
                body = await res.json().catch(() => null);
            } catch (err) {
                last = new ProviderError(`DataForSEO network error: ${err.message}`, 'retry');
                await sleep(2000 * (attempt + 1));
                continue;
            }
            const top = body?.status_code;
            const t = body?.tasks?.[0];
            const code = t?.status_code ?? top;
            const msg = `${t?.status_message ?? body?.status_message ?? `HTTP ${res.status}`} (${code ?? res.status})`;
            if (res.status === 401 || [40100, 40101, 40102, 40103, 40104].includes(top)) {
                this.down = `DataForSEO login rejected: ${msg}`;
                throw new ProviderError(this.down, 'down');
            }
            if (res.status === 402 || [40200, 40201, 40210].includes(top) || [40200, 40201, 40210].includes(code)) {
                this.down = `DataForSEO account balance is empty: ${msg}`;
                throw new ProviderError(this.down, 'down');
            }
            if (res.status === 429 || [40202, 40209, 50301].includes(code) || [40202, 40209].includes(top)) {
                this.stats.dataforseoRateLimited += 1;
                last = new ProviderError(`DataForSEO rate limit: ${msg}`, 'retry');
                await sleep(Math.min(60000, 5000 * 2 ** attempt) + Math.random() * 1000);
                continue;
            }
            if (res.status >= 500 || (code >= 50000 && code < 60000)) {
                last = new ProviderError(`DataForSEO server error: ${msg}`, 'retry');
                await sleep(3000 * (attempt + 1));
                continue;
            }
            if (code === 20000) {
                this.stats.dataforseoCost += Number(t?.cost ?? body?.cost ?? 0);
                return t.result ?? [];
            }
            if ([40501, 40503].includes(code) && /keyword/i.test(msg)) throw new ProviderError(`DataForSEO rejected a keyword: ${msg}`, 'bad_keywords');
            throw new ProviderError(`DataForSEO error: ${msg}`, 'other');
        }
        throw last ?? new ProviderError('DataForSEO did not answer', 'retry');
    }

    locationParams({ location, language }) {
        return {
            ...(location ? { location_code: location.code } : {}),
            ...(language ? (language.id ? { language_name: language.name } : { language_code: language.iso }) : {}),
        };
    }

    static metrics(it) {
        return {
            search_volume: it.search_volume,
            cpc: it.cpc,
            competition: it.competition,
            competition_index: it.competition_index,
            low_top_of_page_bid: it.low_top_of_page_bid,
            high_top_of_page_bid: it.high_top_of_page_bid,
            monthly: (it.monthly_searches ?? []).map((x) => ({ year: x.year, month: x.month, searches: x.search_volume })),
            spell: it.spell ?? null,
        };
    }

    dateRange(months) {
        return months > 12 ? { date_from: ymd(monthsAgo(months)), date_to: ymd(new Date(Date.now() - 86400000)) } : {};
    }

    /** Metrics for up to 1,000 keywords -> Map(keyword -> metrics). */
    async searchVolume(keywords, o) {
        const result = await this.task('/v3/keywords_data/google_ads/search_volume/live', {
            keywords, ...this.locationParams(o), search_partners: Boolean(o.searchPartners), ...this.dateRange(o.months),
        });
        const map = new Map();
        for (const it of result ?? []) if (it?.keyword) map.set(it.keyword.toLowerCase(), DataForSeo.metrics(it));
        return map;
    }

    /** Related keyword ideas for up to 20 seeds -> [{keyword, metrics}] (DataForSEO returns up to 20,000). */
    async ideas(seeds, o) {
        const result = await this.task('/v3/keywords_data/google_ads/keywords_for_keywords/live', {
            keywords: seeds, ...this.locationParams(o), search_partners: Boolean(o.searchPartners), sort_by: o.sortBy === 'relevance' ? 'relevance' : 'search_volume',
            include_adult_keywords: Boolean(o.includeAdult), ...this.dateRange(o.months),
        });
        return (result ?? []).filter((it) => it?.keyword).map((it) => ({ keyword: it.keyword.toLowerCase(), metrics: DataForSeo.metrics(it) }));
    }

    /** AI-assistant search volume for up to 1,000 keywords -> Map(keyword -> {ai_search_volume, ai_monthly}). */
    async aiVolume(keywords, { location, language }) {
        const result = await this.task('/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live', {
            keywords, location_code: location.code, ...(language.id ? { language_name: language.name } : { language_code: language.iso }),
        }, { ads: false });
        const map = new Map();
        for (const r of result ?? []) {
            for (const it of r?.items ?? []) {
                if (!it?.keyword) continue;
                map.set(it.keyword.toLowerCase(), { ai_search_volume: it.ai_search_volume ?? null, ai_monthly: (it.ai_monthly_searches ?? []).map((x) => ({ year: x.year, month: x.month, value: x.ai_search_volume })) });
            }
        }
        return map;
    }
}

// ---------------------------------------------------------------------------------------------------------------
const GADS_VERSIONS = ['v26', 'v25', 'v24', 'v23', 'v22'];
const micros = (v) => (v === undefined || v === null || v === '' ? null : Number(v) / 1e6);

export class GoogleAds {
    constructor({ env, base, oauthUrl, stats }) {
        this.env = env;
        this.base = (base ?? 'https://googleads.googleapis.com').replace(/\/$/, '');
        this.oauthUrl = oauthUrl ?? 'https://oauth2.googleapis.com/token';
        this.stats = stats;
        this.version = env.GOOGLE_ADS_API_VERSION || null;
        this.customerId = String(env.GOOGLE_ADS_CUSTOMER_ID ?? '').replace(/-/g, '');
        this.loginCustomerId = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? '').replace(/-/g, '');
        this.down = null;
        this.languageIds = new Map();
    }

    get configured() {
        const e = this.env;
        return Boolean(e.GOOGLE_ADS_DEVELOPER_TOKEN && e.GOOGLE_ADS_CLIENT_ID && e.GOOGLE_ADS_CLIENT_SECRET && e.GOOGLE_ADS_REFRESH_TOKEN && this.customerId);
    }

    async token(force = false) {
        if (!force && this.accessToken && Date.now() < this.tokenExpires) return this.accessToken;
        const res = await fetch(this.oauthUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: this.env.GOOGLE_ADS_CLIENT_ID, client_secret: this.env.GOOGLE_ADS_CLIENT_SECRET, refresh_token: this.env.GOOGLE_ADS_REFRESH_TOKEN, grant_type: 'refresh_token' }),
            signal: AbortSignal.timeout(30000),
        }).catch((err) => {
            throw new ProviderError(`Google OAuth network error: ${err.message}`, 'retry');
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.access_token) {
            this.down = `Google OAuth refused the refresh token: ${j.error_description ?? j.error ?? res.status}`;
            throw new ProviderError(this.down, 'down');
        }
        this.accessToken = j.access_token;
        this.tokenExpires = Date.now() + (Number(j.expires_in ?? 3600) - 120) * 1000;
        return this.accessToken;
    }

    /** POST customers/{id}:{method}. Finds a supported API version on the first call. */
    async call(method, body) {
        if (this.down) throw new ProviderError(this.down, 'down');
        const versions = this.version ? [this.version] : GADS_VERSIONS;
        let last;
        for (const v of versions) {
            for (let attempt = 0; attempt < 5; attempt++) {
                this.stats.googleAdsCalls += 1;
                const headers = { authorization: `Bearer ${await this.token(attempt > 0 && last?.status === 401)}`, 'developer-token': this.env.GOOGLE_ADS_DEVELOPER_TOKEN, 'content-type': 'application/json' };
                if (this.loginCustomerId) headers['login-customer-id'] = this.loginCustomerId;
                let res;
                let j;
                try {
                    res = await fetch(`${this.base}/${v}/customers/${this.customerId}${method}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
                    j = await res.json().catch(() => ({}));
                } catch (err) {
                    last = new ProviderError(`Google Ads network error: ${err.message}`, 'retry');
                    await sleep(2000 * (attempt + 1));
                    continue;
                }
                if (res.ok) {
                    if (!this.version) {
                        this.version = v;
                        log.info(`Google Ads API ${v} in use.`);
                    }
                    return j;
                }
                const detail = JSON.stringify(j?.error ?? j).slice(0, 400);
                if (res.status === 404 && !this.version) {
                    last = new ProviderError(`Google Ads API ${v} not available`, 'other');
                    break; // try the next version
                }
                if (res.status === 401) {
                    last = Object.assign(new ProviderError(`Google Ads auth error: ${detail}`, 'retry'), { status: 401 });
                    if (attempt >= 1) {
                        this.down = last.message;
                        throw new ProviderError(this.down, 'down');
                    }
                    continue;
                }
                if (res.status === 403) {
                    this.down = `Google Ads refused access (developer token, account or permissions): ${detail}`;
                    throw new ProviderError(this.down, 'down');
                }
                if (res.status === 429 || /RESOURCE_(TEMPORARILY_)?EXHAUSTED|RATE_EXCEEDED/.test(detail) || res.status >= 500) {
                    this.stats.googleAdsRateLimited += 1;
                    last = new ProviderError(`Google Ads temporary error ${res.status}: ${detail}`, 'retry');
                    await sleep(Math.min(60000, (Number(res.headers.get('retry-after')) * 1000) || 4000 * 2 ** attempt));
                    continue;
                }
                throw new ProviderError(`Google Ads error ${res.status}: ${detail}`, 'other');
            }
            if (this.version) break;
        }
        throw last ?? new ProviderError('Google Ads did not answer', 'retry');
    }

    async languageConstant(language) {
        if (!language) return undefined;
        if (language.id) return `languageConstants/${language.id}`;
        if (!this.languageIds.has(language.iso)) {
            const j = await this.call('/googleAds:search', { query: `SELECT language_constant.id FROM language_constant WHERE language_constant.code = '${language.iso.replace(/[^a-zA-Z_-]/g, '')}'` }).catch(() => null);
            this.languageIds.set(language.iso, j?.results?.[0]?.languageConstant?.id ?? null);
        }
        const id = this.languageIds.get(language.iso);
        return id ? `languageConstants/${id}` : undefined;
    }

    async common(o) {
        const opts = {
            geoTargetConstants: o.location ? [`geoTargetConstants/${o.location.code}`] : [],
            keywordPlanNetwork: o.searchPartners ? 'GOOGLE_SEARCH_AND_PARTNERS' : 'GOOGLE_SEARCH',
            includeAdultKeywords: Boolean(o.includeAdult),
            historicalMetricsOptions: { includeAverageCpc: true },
        };
        const lang = await this.languageConstant(o.language);
        if (lang) opts.language = lang;
        if (o.months > 12) {
            const s = monthsAgo(o.months);
            const e = monthsAgo(1);
            const M = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
            opts.historicalMetricsOptions.yearMonthRange = { start: { year: s.getUTCFullYear(), month: M[s.getUTCMonth()] }, end: { year: e.getUTCFullYear(), month: M[e.getUTCMonth()] } };
        }
        return opts;
    }

    static metrics(km, extra = {}) {
        if (!km) return { search_volume: null, ...extra };
        return {
            search_volume: km.avgMonthlySearches === undefined ? null : Number(km.avgMonthlySearches),
            cpc: micros(km.averageCpcMicros),
            competition: km.competition,
            competition_index: km.competitionIndex === undefined ? null : Number(km.competitionIndex),
            low_top_of_page_bid: micros(km.lowTopOfPageBidMicros),
            high_top_of_page_bid: micros(km.highTopOfPageBidMicros),
            monthly: (km.monthlySearchVolumes ?? []).map((x) => ({ year: x.year, month: x.month, searches: x.monthlySearches ?? 0 })),
            ...extra,
        };
    }

    /** Metrics for a keyword list -> Map(keyword -> metrics). Close variants merged by Google map back to every input. */
    async searchVolume(keywords, o) {
        const j = await this.call(':generateKeywordHistoricalMetrics', { keywords, ...(await this.common(o)) });
        const map = new Map();
        for (const r of j.results ?? []) {
            const variants = (r.closeVariants ?? []).map((x) => x.toLowerCase());
            const m = GoogleAds.metrics(r.keywordMetrics, { close_variants: variants.length ? variants : undefined });
            for (const k of [r.text?.toLowerCase(), ...variants]) if (k && !map.has(k)) map.set(k, m);
        }
        return map;
    }

    async ideas(seeds, o) {
        const out = [];
        let pageToken;
        const base = await this.common(o);
        for (let page = 0; page < 20 && out.length < o.max; page++) {
            const j = await this.call(':generateKeywordIdeas', { ...base, keywordSeed: { keywords: seeds }, pageSize: Math.min(10000, Math.max(100, o.max)), ...(pageToken ? { pageToken } : {}) });
            for (const r of j.results ?? []) if (r.text) out.push({ keyword: r.text.toLowerCase(), metrics: GoogleAds.metrics(r.keywordIdeaMetrics, { close_variants: r.closeVariants?.length ? r.closeVariants : undefined }) });
            pageToken = j.nextPageToken;
            if (!pageToken) break;
        }
        if (o.sortBy !== 'relevance') out.sort((a, b) => (b.metrics.search_volume ?? -1) - (a.metrics.search_volume ?? -1));
        return out;
    }
}
