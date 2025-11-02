import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
let keywords = input.keyword;
if (!keywords) {
    log.error('❌ No keyword provided - exiting.');
    await Actor.setValue('ERROR', { message: 'keyword is required' });
    await Actor.exit({ exitCode: 1 });
}

// Garantir que keywords seja array
if (!Array.isArray(keywords)) keywords = [keywords];

const country = (input.country || 'ALL').toUpperCase();
const maxResults = parseInt(input.maxResults || 50, 10);
const adType = (input.adType || 'ACTIVE').toUpperCase();
const language = (input.language || 'en').toLowerCase();
const startDate = input.startDate || '2018-01-01';
const endDate = input.endDate || new Date().toISOString().split('T')[0];
const maxKeywordTries = parseInt(input.maxKeywordTries || 5, 10);

// Abre fila de requests
const requestQueue = await RequestQueue.open();

for (let k = 0; k < Math.min(keywords.length, maxKeywordTries); k++) {
    const keyword = keywords[k].trim();
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=${adType}&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all&language=${language}&start_date=${startDate}&end_date=${endDate}`;
    await requestQueue.addRequest({ url: searchUrl, userData: { keyword } });
    log.info(`🔍 Added search request for keyword "${keyword}"`);
}

// Função principal
const handlePage = async ({ page, request }) => {
    const keyword = request.userData.keyword;
    log.info(`Processing ${request.url} (keyword="${keyword}")`);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // Seletor múltiplo para anúncios
    const adSelectors = [
        'div[role="article"]',
        'div[data-testid*="ad"]',
        'div[aria-label*="Ad"]',
        'div.x1lliihq'
    ];

    let collected = [];
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);
    const maxScrollAttempts = 20;

    for (let scroll = 0; scroll < maxScrollAttempts && collected.length < maxResults; scroll++) {
        const ads = await page.evaluate((selectors) => {
            const items = [];
            const seenKeys = new Set();

            selectors.forEach(sel => {
                const nodes = document.querySelectorAll(sel);
                nodes.forEach((el) => {
                    try {
                        const text = el.innerText?.trim() || null;

                        const mediaEls = el.querySelectorAll('img[src]');
                        const media = Array.from(mediaEls).map(i => i.src);

                        let pageName = null;
                        const pageEl = el.querySelector('a[href*="/pages/"], a[href*="/pg/"], [aria-label*="Page"]');
                        if (pageEl) pageName = pageEl.innerText?.trim() || null;

                        const snapshot = el.querySelector('a[href*="facebook.com/ads/library/"]')?.href || null;

                        const key = snapshot || text || (media[0] || '');
                        if (key && !seenKeys.has(key)) {
                            seenKeys.add(key);
                            items.push({ text, media, pageName, snapshot });
                        }
                    } catch (err) {}
                });
            });

            return items;
        }, adSelectors);

        // Deduplicar resultados
        for (const ad of ads) {
            if (!collected.find(a => a.snapshot === ad.snapshot)) {
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
};

// Configuração do crawler
const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 600,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        }
    },
    requestHandler: handlePage,
    failedRequestHandler: async ({ request, error }) => {
        log.error(`❌ Request failed for ${request.url}: ${error.message}`);
    }
});

await crawler.run();

log.info('🏁 Actor finished successfully.');
await Actor.exit();
