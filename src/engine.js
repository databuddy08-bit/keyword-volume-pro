// Keyword metrics and ideas with automatic fallback (DataForSEO -> Google Ads API). Used by batch runs and the HTTP API.
import { log } from 'apify';
import { ProviderError } from './providers.js';
import { buildRow, MONTHS } from './rows.js';

export const VOLUME_BATCH = 1000;
export const IDEA_SEEDS_PER_TASK = 20;

export function makeEngine({ dfs, gads, stats }) {
    const sources = () => [dfs.configured && !dfs.down ? dfs : null, gads.configured && !gads.down ? gads : null].filter(Boolean);
    const label = (p) => (p === dfs ? 'google_ads' : 'fallback');

    /** Runs fn on the first source that answers; a failed primary hands over to the backup. */
    async function withFallback(what, fn) {
        let lastErr;
        const list = sources();
        if (!list.length) throw new ProviderError(dfs.down || gads.down || 'No data source is configured (DataForSEO or Google Ads credentials).', 'down');
        for (const p of list) {
            try {
                const r = await fn(p);
                return { result: r, source: label(p) };
            } catch (err) {
                if (err.kind === 'bad_keywords') throw err;
                lastErr = err;
                if (p === dfs && gads.configured && !gads.down) {
                    stats.fallbackUsed += 1;
                    log.warning(`${what}: primary source failed (${err.message}). Using the backup source.`);
                }
            }
        }
        throw lastErr;
    }

    /** Metrics for ≤1,000 keywords; a keyword Google Ads rejects is isolated by splitting the batch. */
    async function volumeBatch(items, o, invalid) {
        try {
            const { result, source } = await withFallback(`${items.length} keywords`, (p) => p.searchVolume(items.map((x) => x.keyword), o));
            return items.map((x) => ({ ...x, metrics: result.get(x.keyword) ?? null, source }));
        } catch (err) {
            if (err.kind !== 'bad_keywords') throw err;
            if (items.length === 1) {
                invalid.push({ ...items[0], error: `Google Ads rejected this keyword (${err.message})` });
                return [];
            }
            const mid = Math.ceil(items.length / 2);
            return [...await volumeBatch(items.slice(0, mid), o, invalid), ...await volumeBatch(items.slice(mid), o, invalid)];
        }
    }

    /** All keywords, in parallel batches; onRows gets each finished batch. */
    async function metrics(items, o, onRows, { concurrency = 3, shouldStop = () => false } = {}) {
        const batches = [];
        for (let i = 0; i < items.length; i += VOLUME_BATCH) batches.push(items.slice(i, i + VOLUME_BATCH));
        const invalid = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
            while (next < batches.length && !shouldStop()) {
                const b = batches[next++];
                const res = await volumeBatch(b, o, invalid);
                let rows = res.map((x) => buildRow(x.metrics, { keyword: x.keyword, input: x.input, location: o.location, language: o.language, searchPartners: o.searchPartners, source: x.source, includeTrend: o.includeTrend }));
                if (o.aiVolume) rows = await addAiVolume(rows, o);
                await onRows(rows);
            }
        }));
        return { invalid };
    }

    /** Related ideas for the seeds, best first (by volume unless relevance), capped at maxIdeas. */
    async function ideas(seeds, o) {
        const chunks = [];
        for (let i = 0; i < seeds.length; i += IDEA_SEEDS_PER_TASK) chunks.push(seeds.slice(i, i + IDEA_SEEDS_PER_TASK));
        const byKeyword = new Map();
        const neg = (o.negativeKeywords ?? []).map((n) => n.toLowerCase()).filter(Boolean);
        let source = null;
        for (const c of chunks) {
            const seedWords = c.map((x) => x.keyword);
            const { result, source: s } = await withFallback(`ideas for ${seedWords.length} seeds`, (p) => p.ideas(seedWords, { ...o, max: Math.max(o.maxIdeas, 100) }));
            source = source ?? s;
            for (const idea of result) {
                if (neg.some((n) => idea.keyword.includes(n))) continue;
                if (o.minSearchVolume && (idea.metrics.search_volume ?? 0) < o.minSearchVolume) continue;
                const prev = byKeyword.get(idea.keyword);
                if (prev) prev.seeds = [...new Set([...prev.seeds, ...seedWords])];
                else byKeyword.set(idea.keyword, { ...idea, seeds: seedWords, source: s });
            }
        }
        let list = [...byKeyword.values()];
        if (o.sortBy !== 'relevance') list.sort((a, b) => (b.metrics.search_volume ?? -1) - (a.metrics.search_volume ?? -1));
        list = list.slice(0, o.maxIdeas);
        let rows = list.map((x) => buildRow(x.metrics, { keyword: x.keyword, location: o.location, language: o.language, searchPartners: o.searchPartners, source: x.source, includeTrend: o.includeTrend, extra: { seed_keywords: x.seeds } }));
        if (o.aiVolume) rows = await addAiVolume(rows, o);
        return { rows, found: byKeyword.size, source };
    }

    /** Adds ai_search_volume / ai_monthly_searches (DataForSEO AI Optimization; needs a country + language). */
    async function addAiVolume(rows, o) {
        if (!dfs.configured || dfs.down) {
            stats.aiUnavailable += rows.length;
            return rows.map((r) => ({ ...r, ai_search_volume: null, ai_monthly_searches: null }));
        }
        const location = o.location ?? { code: 2840, name: 'United States' };
        const language = o.language ?? { iso: 'en', id: 1000, name: 'English' };
        const out = [];
        for (let i = 0; i < rows.length; i += VOLUME_BATCH) {
            const part = rows.slice(i, i + VOLUME_BATCH);
            let map = new Map();
            try {
                map = await dfs.aiVolume(part.map((r) => r.keyword), { location, language });
            } catch (err) {
                stats.aiErrors += 1;
                log.warning(`AI search volume unavailable for ${part.length} keywords: ${err.message}`);
            }
            for (const r of part) {
                const a = map.get(r.keyword);
                out.push({
                    ...r,
                    ai_search_volume: a?.ai_search_volume ?? null,
                    ai_monthly_searches: a?.ai_monthly?.length ? a.ai_monthly.map((x) => ({ year: x.year, month: MONTHS[Number(x.month) - 1] ?? x.month, ai_search_volume: x.value })).sort((p, q) => p.year - q.year || MONTHS.indexOf(p.month) - MONTHS.indexOf(q.month)) : null,
                    ...(!o.location || !o.language ? { ai_market: `${location.name} / ${language.name}` } : {}),
                });
            }
        }
        return out;
    }

    return { metrics, ideas, sources };
}
