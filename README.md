# Keyword Search Volume Pro — Bulk Google Volume, CPC, Trends & Ideas

Check Google keyword **search volume, CPC, competition, top-of-page bids and up to 4 years of monthly trend** for thousands of keywords at once. The data comes from Google Ads Keyword Planner, and you don't need a Google Ads account. Switch to **Ideas mode** to expand seed keywords into hundreds of related keywords with full metrics. Add **AI search volume** to see how often each keyword is used inside AI assistants.

**From $3 per 1,000 keywords. Keywords that come back without data are never charged.**

## What you get per keyword

```json
{
  "keyword": "event organizer software",
  "search_volume": 2900,
  "cpc": 40.37,
  "competition": "LOW",
  "competition_index": 33,
  "low_top_of_page_bid": 8.76,
  "high_top_of_page_bid": 48.06,
  "monthly_searches": [
    { "year": 2025, "month": "JULY", "monthly_searches": 3600 },
    { "year": 2025, "month": "AUGUST", "monthly_searches": 12100 }
  ],
  "search_partners": false,
  "language_code": "1000",
  "location_code": "2840",
  "source": "google_ads",
  "location_name": "United States",
  "language_name": "English",
  "has_data": true,
  "trend": { "direction": "rising", "change_pct": 42, "yoy_change_pct": null, "peak_month": "2025-08", "months": 12 }
}
```

| Field | Meaning |
|---|---|
| `search_volume` | Average monthly Google searches |
| `cpc` | Average cost per click (USD) |
| `competition` / `competition_index` | LOW / MEDIUM / HIGH, and a 0–100 score |
| `low_top_of_page_bid` / `high_top_of_page_bid` | Top-of-page bid range advertisers pay (USD) |
| `monthly_searches` | Month-by-month volume, oldest first (12 to 48 months) |
| `trend` | Rising, falling or stable, with the % change (last 3 months vs first 3), year-over-year change and peak month |
| `language_code` / `location_code` | Google Ads IDs of the market, plus readable `language_name` / `location_name` |
| `source` | `google_ads` (primary path) or `fallback` (backup path, same fields and metrics) |
| `spell`, `close_variants`, `input_keyword` | Google's spelling fix, the variants Google merged, and your keyword as typed when it was cleaned |
| `ai_search_volume`, `ai_monthly_searches` | AI-assistant usage (add-on) |

**Unknown values stay `null`.** We never fake zeros.

## Two modes

- **Metrics** (default): one row per keyword you give. There is no input limit: lists are deduplicated (case and spacing ignored) and processed in batches of 1,000.
- **Ideas:** your keywords become seeds, expanded into related keyword ideas with full metrics.
  - `maxIdeas` (default 100) caps the rows, so one seed never surprises you with a huge bill. The best ideas are kept first.
  - Refine with `minSearchVolume`, `negativeKeywords` (e.g. "free", "jobs") and `sortBy` (volume or relevance).
  - Each idea lists the `seed_keywords` that produced it.

## Location and language

- **`geo`:** `us`, `germany`, `uk`, or a Google Ads location ID such as `2840` (cities and regions work too, e.g. `1023191` for New York).
- **`language`:** `en`, `es`, `zh-cn`, `spanish` or `1000`.
- Leave both empty for worldwide and all languages.

## Input example

```json
{
  "keywords": ["event ticketing", "sell tickets online"],
  "mode": "metrics",
  "geo": "us",
  "language": "en",
  "trendMonths": "24"
}
```

## Real-time HTTP API (Standby)

The Actor also runs as a warm HTTP API that answers in a second or two, with the rows in the response itself. There's no run to start and no dataset to fetch.

```bash
# Metrics for up to 1,000 keywords
curl -H "Authorization: Bearer $APIFY_TOKEN" \
  "https://<standby-url>/volume?keywords=web%20scraping,event%20ticketing&geo=us&language=en"

# Related ideas for up to 20 seeds (maxIdeas 1–1,000, default 50)
curl -H "Authorization: Bearer $APIFY_TOKEN" \
  "https://<standby-url>/ideas?seeds=web%20scraping&geo=es&language=es&maxIdeas=20"
```

- **Optional parameters:** `network`, `includeTrend` (default true), `trendMonths`, `aiVolume`, and for ideas `minSearchVolume`, `negativeKeywords` and `sortBy`.
- **POST** a JSON body for long lists.
- **Errors** come back as `{"error":{"code","message"}}`. A `503` with `Retry-After` means the service is briefly unavailable, so retry.
- **Pricing:** the same events as a batch run.

Copy the real `<standby-url>` from the Actor's **Endpoints** tab.

## Pricing (pay per event)

| Event | When | Free / Starter | Scale | Business |
|---|---|---|---|---|
| `keyword-result` | One keyword row **with metrics** | $6.00 / 1,000 | $4.50 / 1,000 | $3.00 / 1,000 |
| `ai-volume` | Add-on: one keyword that comes back with an AI search volume number | $2.00 / 1,000 | $1.50 / 1,000 | $1.00 / 1,000 |

Rows without data, duplicates and keywords Google Ads doesn't accept are **free**. The run stops cleanly at your **Maximum cost per run**.

## AI search volume (optional)

Google search volume counts what people type into Google. `ai_search_volume` estimates how often the same keyword is used **inside AI assistants**, with a month-by-month series. Use it to spot keywords whose demand is moving to AI answers before your Google traffic shows it.

## Reliability

- **Primary and backup data paths:** if the primary path is briefly unavailable, the run switches to the backup instead of failing (`source: "fallback"`). Scheduled jobs keep producing rows through an outage.
- **Cleaned keywords:** symbols and emojis Google Ads rejects are removed automatically. If Google still rejects a keyword, it is isolated and reported as a free `INVALID_KEYWORD` row, and the rest of the batch is still measured.
- **Run summary:** each run's `RUN_SUMMARY` contains:
  - keywords given, unique keywords and duplicates removed;
  - rows with and without data;
  - the market (location, language, network);
  - fill rates and the data path used.

## FAQ

- **Is this real Google data?** Yes. The metrics are Google Ads Keyword Planner data, the same numbers advertisers use to plan campaigns.
- **Why are some keywords null?** Google returns no metrics for negligible-volume keywords, and it merges close variants (e.g. "running shoe" and "running shoes"). Both of your inputs get the merged numbers, and the variants are listed in `close_variants`.
- **How many keywords can I check?** As many as you like. 10,000 keywords take about a minute.
