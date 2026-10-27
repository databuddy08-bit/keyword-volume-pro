// Locations and languages in Google Ads terms. Country criterion IDs are 2000 + the ISO 3166 numeric code
// (US 840 -> 2840, Germany 276 -> 2276); DataForSEO uses the same location codes.

const ISO_NUMERIC = 'AF004 AL008 DZ012 AS016 AD020 AO024 AI660 AQ010 AG028 AR032 AM051 AW533 AU036 AT040 AZ031 BS044 BH048 BD050 BB052 BY112 BE056 BZ084 BJ204 BM060 BT064 BO068 BQ535 BA070 BW072 BR076 IO086 BN096 BG100 BF854 BI108 CV132 KH116 CM120 CA124 KY136 CF140 TD148 CL152 CN156 CX162 CC166 CO170 KM174 CG178 CD180 CK184 CR188 CI384 HR191 CU192 CW531 CY196 CZ203 DK208 DJ262 DM212 DO214 EC218 EG818 SV222 GQ226 ER232 EE233 SZ748 ET231 FK238 FO234 FJ242 FI246 FR250 GF254 PF258 TF260 GA266 GM270 GE268 DE276 GH288 GI292 GR300 GL304 GD308 GP312 GU316 GT320 GG831 GN324 GW624 GY328 HT332 VA336 HN340 HK344 HU348 IS352 IN356 ID360 IR364 IQ368 IE372 IM833 IL376 IT380 JM388 JP392 JE832 JO400 KZ398 KE404 KI296 KP408 KR410 KW414 KG417 LA418 LV428 LB422 LS426 LR430 LY434 LI438 LT440 LU442 MO446 MG450 MW454 MY458 MV462 ML466 MT470 MH584 MQ474 MR478 MU480 YT175 MX484 FM583 MD498 MC492 MN496 ME499 MS500 MA504 MZ508 MM104 NA516 NR520 NP524 NL528 NC540 NZ554 NI558 NE562 NG566 NU570 NF574 MK807 MP580 NO578 OM512 PK586 PW585 PS275 PA591 PG598 PY600 PE604 PH608 PN612 PL616 PT620 PR630 QA634 RE638 RO642 RU643 RW646 BL652 SH654 KN659 LC662 MF663 PM666 VC670 WS882 SM674 ST678 SA682 SN686 RS688 SC690 SL694 SG702 SX534 SK703 SI705 SB090 SO706 ZA710 GS239 SS728 ES724 LK144 SD729 SR740 SJ744 SE752 CH756 SY760 TW158 TJ762 TZ834 TH764 TL626 TG768 TK772 TO776 TT780 TN788 TR792 TM795 TC796 TV798 UG800 UA804 AE784 GB826 US840 UM581 UY858 UZ860 VU548 VE862 VN704 VG092 VI850 WF876 EH732 YE887 ZM894 ZW716';
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const COUNTRIES = ISO_NUMERIC.split(' ').map((s) => {
    const iso = s.slice(0, 2);
    return { iso, code: 2000 + Number(s.slice(2)), name: regionNames.of(iso) };
});
const COUNTRY_ALIASES = { uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', usa: 'US', 'united states of america': 'US', america: 'US', uae: 'AE', emirates: 'AE', 'south korea': 'KR', korea: 'KR', 'north korea': 'KP', russia: 'RU', 'czech republic': 'CZ', czechia: 'CZ', holland: 'NL', vietnam: 'VN', 'viet nam': 'VN', taiwan: 'TW', 'hong kong': 'HK', 'ivory coast': 'CI', turkey: 'TR', 'türkiye': 'TR', turkiye: 'TR', iran: 'IR', syria: 'SY', laos: 'LA', bolivia: 'BO', venezuela: 'VE', tanzania: 'TZ', moldova: 'MD', macedonia: 'MK', 'north macedonia': 'MK', brunei: 'BN', burma: 'MM', myanmar: 'MM', swaziland: 'SZ', eswatini: 'SZ', palestine: 'PS', 'cape verde': 'CV', 'congo (drc)': 'CD', drc: 'CD', 'congo - kinshasa': 'CD', 'congo - brazzaville': 'CG', congo: 'CG', 'east timor': 'TL' };

/** Google Ads language criterion IDs (stable) with ISO codes and the names DataForSEO accepts. */
export const LANGUAGES = [
    ['en', 1000, 'English'], ['de', 1001, 'German'], ['fr', 1002, 'French'], ['es', 1003, 'Spanish'], ['it', 1004, 'Italian'], ['ja', 1005, 'Japanese'],
    ['da', 1009, 'Danish'], ['nl', 1010, 'Dutch'], ['fi', 1011, 'Finnish'], ['ko', 1012, 'Korean'], ['no', 1013, 'Norwegian'], ['pt', 1014, 'Portuguese'],
    ['sv', 1015, 'Swedish'], ['zh_CN', 1017, 'Chinese (Simplified)'], ['zh_TW', 1018, 'Chinese (Traditional)'], ['ar', 1019, 'Arabic'], ['bg', 1020, 'Bulgarian'],
    ['cs', 1021, 'Czech'], ['el', 1022, 'Greek'], ['hi', 1023, 'Hindi'], ['hu', 1024, 'Hungarian'], ['id', 1025, 'Indonesian'], ['is', 1026, 'Icelandic'],
    ['he', 1027, 'Hebrew'], ['lv', 1028, 'Latvian'], ['lt', 1029, 'Lithuanian'], ['pl', 1030, 'Polish'], ['ru', 1031, 'Russian'], ['ro', 1032, 'Romanian'],
    ['sk', 1033, 'Slovak'], ['sl', 1034, 'Slovenian'], ['sr', 1035, 'Serbian'], ['uk', 1036, 'Ukrainian'], ['tr', 1037, 'Turkish'], ['ca', 1038, 'Catalan'],
    ['hr', 1039, 'Croatian'], ['vi', 1040, 'Vietnamese'], ['ur', 1041, 'Urdu'], ['tl', 1042, 'Filipino'], ['et', 1043, 'Estonian'], ['th', 1044, 'Thai'], ['bn', 1056, 'Bengali'],
].map(([iso, id, name]) => ({ iso, id, name }));
const LANGUAGE_ALIASES = { zh: 'zh_CN', 'zh-cn': 'zh_CN', 'zh-hans': 'zh_CN', chinese: 'zh_CN', 'simplified chinese': 'zh_CN', 'zh-tw': 'zh_TW', 'zh-hant': 'zh_TW', 'traditional chinese': 'zh_TW', iw: 'he', nb: 'no', nn: 'no', 'norwegian bokmål': 'no', fil: 'tl', tagalog: 'tl', 'pt-br': 'pt', 'pt-pt': 'pt', 'en-us': 'en', 'en-gb': 'en', 'es-mx': 'es', 'es-419': 'es', farsi: 'fa' };

/**
 * geo input -> {code, name, iso} | null (worldwide). Accepts ISO codes (us), names (germany), or numeric criterion IDs
 * (2840, or a city/region ID such as 1023191). Throws on unknown values.
 */
export function resolveLocation(raw) {
    const s = String(raw ?? '').trim();
    if (!s || /^(world|worldwide|global|all|any)$/i.test(s)) return null;
    if (/^\d{4,8}$/.test(s)) {
        const code = Number(s);
        const c = COUNTRIES.find((x) => x.code === code);
        return { code, name: c?.name ?? `Location ${code}`, iso: c?.iso ?? null };
    }
    const low = s.toLowerCase();
    const iso = COUNTRY_ALIASES[low] ?? (/^[a-z]{2}$/i.test(s) ? s.toUpperCase() : COUNTRIES.find((c) => c.name.toLowerCase() === low)?.iso);
    const c = COUNTRIES.find((x) => x.iso === iso);
    if (!c) throw new Error(`Unknown location "${s}". Use a country code (us, de, in), a country name (germany) or a Google Ads location ID (2840).`);
    return { ...c };
}

/** language input -> {iso, id, name} | null (all languages). Unknown ISO codes pass through (id resolved later). */
export function resolveLanguage(raw) {
    const s = String(raw ?? '').trim();
    if (!s || /^(all|any)$/i.test(s)) return null;
    if (/^\d{4}$/.test(s)) {
        const l = LANGUAGES.find((x) => x.id === Number(s));
        if (!l) throw new Error(`Unknown language ID "${s}". Use a language code such as en, de, es or a name such as spanish.`);
        return { ...l };
    }
    const low = s.toLowerCase().replace(/_/g, '-');
    const key = LANGUAGE_ALIASES[low] ?? low;
    const l = LANGUAGES.find((x) => x.iso.toLowerCase().replace(/_/g, '-') === key.toLowerCase().replace(/_/g, '-') || x.name.toLowerCase() === low);
    if (l) return { ...l };
    if (/^[a-z]{2,3}$/.test(key)) return { iso: key, id: null, name: new Intl.DisplayNames(['en'], { type: 'language' }).of(key) ?? key };
    throw new Error(`Unknown language "${s}". Use a language code such as en, de, es or a name such as spanish.`);
}
