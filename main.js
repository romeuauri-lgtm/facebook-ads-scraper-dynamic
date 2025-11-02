import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const rawKeywords = input.keyword;
const country = (input.country || 'ALL').toUpperCase();
const maxResults = parseInt(input.maxResults || 50, 10);
const adType = (input.adType || 'ACTIVE').toUpperCase();
const language = (input.language || 'en').toLowerCase();
const startDate = input.startDate || '2018-01-01';
const endDate = input.endDate || new Date().toISOString().split('T')[0];
const maxKeywordTries = parseInt(input.maxKeywordTries || 5, 10);

// Normaliza as keywords (pode ser string única ou array)
let keywords = [];
if (Array.isArray(rawKeywords)) {
    keywords = rawKeywords.slice(0, maxKeywordTries);
} else if (typeof rawKeywords === 'string' && rawKeywords.trim()) {
    keywords = [rawKeywords.trim()];
}

if (keywords.length === 0) {
    log.error('❌ No keyword provided - exiting.');
    await Actor.setValue('ERROR', { message: 'keyword is required' });
    await Actor.exit({ exitCode: 1 });
}

const requestQueue = await RequestQueue.open();

for (const keyword of keywords) {
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=${adType}&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all&language=${language}&start_date=${startDate}&end_date=${endDate}`;
    log.info(`🔍 Searching Facebook Ads Library for: "${keyword}" (country=${country}, adType=${adType}, language=${language}, from=${startDate} to=${endDate})`);
    log.info(`Search URL: ${searchUrl}`);
    await requestQueue.addRequest({ url: searchUrl, userData: { keyword } });
}

// Função de tratamento da página
const handlePage = async ({ page, request }) => {
    const { keyword } = request.userData;
    log.info(`Processing ${request.url}`);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4000);

    // Espera seletor principal ou alternativo
    const selectors = [
        'div.x1lliihq.x6ikm8r.x10wlt62',
        'div[role="article"]',
        'div.x1lliihq'
    ];

    let foundSelector = null;
    for (const sel of selectors) {
        const exists = await page.$(sel);
        if (exists) {
            foundSelector = sel;
            break;
        }
    }

    if (!foundSelector) {
        log.warning('⚠️ Nenhum seletor de anúncio detectado, tentando mesmo assim...');
    } else {
        log.info(`✅ Usando seletor: ${foundSelector}`);
    }

    let collected = [];
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);

    for (let scroll = 0; scroll < 12 && collected.length < maxResults; scroll++) {
        const ads = await page.evaluate((sel) => {
            const items = [];
            const nodes = document.querySelectorAll(sel || 'div.x1lliihq');

            nodes.forEach((el) => {
                try {
                    const text = el.innerText?.trim() || null;
                    const mediaEls = el.querySelectorAll('img[src]');
                    const media = Array.from(mediaEls).map(i => i.src);

                    const pageName =
                        el.querySelector('a[role="link"] span')?.innerText?.trim() ||
                        el.querySelector('strong span')?.innerText?.trim() ||
                        null;

                    const snapshot =
                        el.querySelector('a[href*="facebook.com/ads/library/"]')?.href ||
                        window.location.href;

                    if (text || media.length) {
                        items.push({
                            text,
                            media,
                            pageName,
                            snapshot
                        });
                    }
                } catch (err) {}
            });
            return items;
        }, foundSelector);

        for (const ad of ads) {
            if (!collected.find(a => a.text === ad.text && a.pageName === ad.pageName)) {
                collected.push(ad);
            }
        }

        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
        await page.waitForTimeout(2000);

        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === lastHeight) break;
        lastHeight = newHeight;
    }

    collected = collected.slice(0, maxResults);

    if (collected.length === 0) {
        log.warning(`⚠️ Nenhum anúncio encontrado para "${keyword}".`);
        await Actor.pushData({
            keyword,
            status: 'no_results',
            message: 'No ads found for this keyword.',
            timestamp: new Date().toISOString(),
            source_url: request.url
        });
        return;
    }

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

    log.info(`✅ Pushed ${collected.length} ads for "${keyword}".`);
};

// Configuração do crawler
const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 300,
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
