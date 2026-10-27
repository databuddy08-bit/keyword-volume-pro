// Keyword clean-up and output rows (one stable shape for both data sources).

export const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
// Characters Google Ads rejects in keywords (one bad keyword makes the whole request fail).
const DISALLOWED = /[!@%,*();=^~<>?[\]{}\\|`" ]/g;

/** Google Ads-safe keyword: symbols and emojis removed, spaces collapsed. Returns {keyword, error?}. */
export function cleanKeyword(raw) {
    const input = String(raw ?? '');
    const keyword = input.normalize('NFKC').replace(DISALLOWED, ' ').replace(/[\p{So}\p{Cs}\p{Co}\p{Cc}‍️]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!keyword) return { input, keyword: '', error: 'empty after removing characters Google Ads does not accept' };
    if (keyword.length > 80) return { input, keyword, error: 'longer than 80 characters (Google Ads limit)' };
    if (keyword.split(' ').length > 10) return { input, keyword, error: 'more than 10 words (Google Ads limit)' };
    return { input, keyword };
}

/** Deduplicates (case/space-insensitive) and validates a keyword list. */
export function prepareKeywords(list) {
    const ok = [];
    const invalid = [];
    const seen = new Set();
    let duplicates = 0;
    for (const raw of list) {
        if (String(raw ?? '').trim() === '') continue;
        const c = cleanKeyword(raw);
        if (c.error) {
            invalid.push(c);
            continue;
        }
        if (seen.has(c.keyword)) {
            duplicates += 1;
            continue;
        }
        seen.add(c.keyword);
        ok.push(c);
    }
    return { ok, invalid, duplicates };
}

const round2 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const int = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

/** Trend over the monthly series: last 3 months vs the first 3, direction, peak month. */
export function trendOf(monthly) {
    const m = (monthly ?? []).filter((x) => Number.isFinite(x.monthly_searches));
    if (m.length < 6) return null;
    const avg = (a) => a.reduce((s, x) => s + x.monthly_searches, 0) / a.length;
    const first = avg(m.slice(0, 3));
    const last = avg(m.slice(-3));
    const change = first > 0 ? Math.round(((last - first) / first) * 100) : last > 0 ? 100 : 0;
    const peak = m.reduce((p, x) => (x.monthly_searches > p.monthly_searches ? x : p), m[0]);
    const yoyPair = m.length >= 13 ? [m.at(-13), m.at(-1)] : null;
    return {
        direction: change >= 15 ? 'rising' : change <= -15 ? 'falling' : 'stable',
        change_pct: change,
        yoy_change_pct: yoyPair && yoyPair[0].monthly_searches > 0 ? Math.round(((yoyPair[1].monthly_searches - yoyPair[0].monthly_searches) / yoyPair[0].monthly_searches) * 100) : null,
        peak_month: `${peak.year}-${String(MONTHS.indexOf(peak.month) + 1).padStart(2, '0')}`,
        months: m.length,
    };
}

/**
 * Normalised metrics -> output row. `m` fields: search_volume, cpc, competition, competition_index, low/high bids,
 * monthly [{year, month (1-12 or name), searches}], spell, close_variants.
 */
export function buildRow(m, { keyword, input, location, language, searchPartners, source, includeTrend = true, extra = {} }) {
    const monthly = (m?.monthly ?? [])
        .map((x) => ({ year: int(x.year), month: typeof x.month === 'string' && Number.isNaN(Number(x.month)) ? x.month.toUpperCase() : MONTHS[Number(x.month) - 1], monthly_searches: int(x.searches) }))
        .filter((x) => x.year && x.month)
        .sort((a, b) => a.year - b.year || MONTHS.indexOf(a.month) - MONTHS.indexOf(b.month));
    const comp = typeof m?.competition === 'string' && ['LOW', 'MEDIUM', 'HIGH'].includes(m.competition.toUpperCase()) ? m.competition.toUpperCase() : null;
    const row = {
        keyword,
        search_volume: int(m?.search_volume),
        cpc: round2(m?.cpc),
        competition: comp,
        competition_index: int(m?.competition_index),
        low_top_of_page_bid: round2(m?.low_top_of_page_bid),
        high_top_of_page_bid: round2(m?.high_top_of_page_bid),
        monthly_searches: includeTrend ? (monthly.length ? monthly : null) : undefined,
        search_partners: Boolean(searchPartners),
        language_code: language ? String(language.id ?? language.iso) : null,
        location_code: location ? String(location.code) : null,
        source,
        location_name: location?.name ?? 'Worldwide',
        language_name: language?.name ?? 'All languages',
        has_data: m?.search_volume !== null && m?.search_volume !== undefined,
        trend: includeTrend ? trendOf(monthly) : undefined,
        ...(m?.spell ? { spell: m.spell } : {}),
        ...(m?.close_variants?.length ? { close_variants: m.close_variants } : {}),
        ...(input !== undefined && input.trim().toLowerCase() !== keyword ? { input_keyword: input } : {}),
        ...extra,
    };
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    return row;
}
