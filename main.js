import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
let keywords = input.keyword;
if (!keywords || (Array.isArray(keywords) && keywords.length === 0)) {
    log.error('❌ No keyword provided - exiting.');
    await Actor.setValue('ERROR', { message: 'keyword is required' });
    await Actor.exit({ exitCode: 1 });
}

// Normaliza keywords para array
if (typeof keywords === 'string') keywords = [keywords];
const maxKeywordTries = parseInt(input.maxKeywordTries || 5, 10);
keywords = keywords.slice(0, maxKeywordTries);

const country = (input.country || 'ALL').toUpperCase();
const maxResults = parseInt(input.maxResults || 50, 10);
const adType = (input.adType || 'ACTIVE').toUpperCase();
const language = (input.language || 'en').toLowerCase();
const startDate = input.startDate || '2018-01-01';
const endDate = input.endDate || new Date().toISOString().split('T')[0];

const requestQueue = await RequestQueue.open();

for (const keyword of keywords) {
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=${adType}&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all&language=${language}&start_date=${startDate}&end_date=${endDate}`;
    log.info(`🔍 Added search request for keyword "${keyword}"`);
    await requestQueue.addRequest({ url: searchUrl, userData: { keyword } });
}

// Função de tratamento da página
const handlePage = async ({ page, request }) => {
    const keyword = request.userData.keyword;
    log.info(`Processing ${request.url} (keyword="${keyword}")`);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4000);

    // Seletores possíveis de anúncios
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

                        // Captura robusta do nome da página
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
};

// Configuração do crawler
const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1,
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
        log.error(`❌ Request failed for ${request.url}: ${error?.message || error}`);
    }
});

await crawler.run();

log.info('🏁 Actor finished successfully.');
await Actor.exit();
