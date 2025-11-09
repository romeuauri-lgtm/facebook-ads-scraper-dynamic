import { Actor, Dataset } from 'apify';
import { PlaywrightCrawler, RequestQueue, log } from 'crawlee';

await Actor.init();

// === INPUT HANDLING ===
let input = await Actor.getInput();
if (!input || Object.keys(input).length === 0) {
    try {
        const raw = process.env.APIFY_INPUT;
        if (raw) input = JSON.parse(raw);
    } catch {}
}

if (!input || !input.keyword) {
    log.error('❌ Missing required field: "keyword"');
    await Actor.setValue('ERROR', { message: 'keyword is required' });
    await Actor.exit({ exitCode: 1 });
}

// Normalize keywords
let keywords = input.keyword;
if (typeof keywords === 'string') keywords = [keywords];
const maxKeywordTries = parseInt(input.maxKeywordTries || 5, 10);
keywords = keywords.slice(0, maxKeywordTries);

// Normalize params
const country = (input.country || 'ALL').toUpperCase();
const maxResults = parseInt(input.maxResults || 50, 10);
const adType = (input.adType || 'ACTIVE').toUpperCase();
const language = (input.language || 'en').toLowerCase();
const startDate = input.startDate || '2018-01-01';
const endDate = input.endDate || new Date().toISOString().split('T')[0];

// Initialize queue
const requestQueue = await RequestQueue.open();

for (const keyword of keywords) {
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=${adType}&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all&language=${language}&start_date=${startDate}&end_date=${endDate}`;
    log.info(`🔍 Added search request for keyword "${keyword}"`);
    await requestQueue.addRequest({ url: searchUrl, userData: { keyword } });
}

// === PAGE HANDLER ===
const handlePage = async ({ page, request }) => {
    const keyword = request.userData.keyword;
    log.info(`Processing ${request.url} (keyword="${keyword}")`);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4000);

    const adSelectors = [
        'div[role="article"]',
        'div[data-testid*="ad"]',
        'div[aria-label*="Ad"]',
        'div.x1lliihq'
    ];

    let collected = [];
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);

    for (let scroll = 0; scroll < 15 && collected.length < maxResults; scroll++) {
        const ads = await page.evaluate((selectors) => {
            const items = [];
            const seenKeys = new Set();

            selectors.forEach(sel => {
                const nodes = Array.from(document.querySelectorAll(sel));
                nodes.forEach(n => {
                    try {
                        const textEl = n.querySelector('div[dir="auto"], p, span');
                        const text = textEl ? textEl.innerText.trim() : '';

                        const mediaEls = Array.from(n.querySelectorAll('img[src], video[src]'));
                        const media = mediaEls.map(m => m.src).filter(Boolean);

                        let pageName = null;
                        const pageSelectors = [
                            'a[href*="/pages/"]',
                            'a[href*="/pg/"]',
                            '[aria-label*="Page"]',
                            'div[role="link"] > span',
                            'strong'
                        ];
                        for (const ps of pageSelectors) {
                            const el = n.querySelector(ps);
                            if (el && el.innerText.trim()) {
                                pageName = el.innerText.trim();
                                break;
                            }
                        }

                        const snapshotEl = n.querySelector('a[href*="/ads/library/"]');
                        const snapshot = snapshotEl ? snapshotEl.href : null;

                        const key = text || snapshot || (media[0] || '');
                        if (!key || seenKeys.has(key)) return;
                        seenKeys.add(key);

                        if (text || media.length) {
                            items.push({ text, media, pageName, snapshot });
                        }
                    } catch {}
                });
            });
            return items;
        }, adSelectors);

        for (const ad of ads) {
            if (!collected.find(a => a.text === ad.text && a.pageName === ad.pageName)) {
                collected.push(ad);
            }
        }

        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
        await page.waitForTimeout(1500);

        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === lastHeight) break;
        lastHeight = newHeight;
    }

    collected = collected.slice(0, maxResults);

    for (const [index, ad] of collected.entries()) {
        await Actor.pushData({
            keyword,
            country,
            adType,
            language,
            startDate,
            endDate,
            rank: index + 1,
            page_name: ad.pageName,
            text: ad.text,
            media: ad.media,
            snapshot_url: ad.snapshot,
            scraped_at: new Date().toISOString(),
            source_url: request.url
        });
    }

    log.info(`✅ Pushed ${collected.length} ads for keyword "${keyword}".`);
    return collected;
};

// === RUN ===
let allResults = [];
try {
    const crawler = new PlaywrightCrawler({
        requestQueue,
        maxConcurrency: 1,
        launchContext: {
            launchOptions: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            }
        },
        requestHandler: async (context) => {
            const data = await handlePage(context);
            allResults.push(...data);
        },
        failedRequestHandler: async ({ request, error }) => {
            log.error(`❌ Request failed for ${request.url}: ${error?.message || error}`);
        }
    });

    await crawler.run();

    // ✅ CORREÇÃO: garante que o OUTPUT do n8n é idêntico ao dataset completo
    const dataset = await Dataset.open();
    const { items } = await dataset.getData();

    await Actor.setValue('OUTPUT', items);
    log.info(`🏁 Actor finished successfully with ${items.length} ads.`);

} catch (err) {
    log.error(`💥 Fatal error: ${err.message}`);
    await Actor.setValue('ERROR', { message: err.message });
} finally {
    await Actor.exit();
}
