import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const keyword = (input.keyword || '').trim();
const country = (input.country || 'ALL').toUpperCase();
const maxResults = parseInt(input.maxResults || 50, 10);

// Novos parâmetros configuráveis
const adType = (input.adType || 'ACTIVE').toUpperCase();
const language = (input.language || 'en').toLowerCase();

// Datas de filtragem
const startDate = input.startDate || '2018-01-01';
const endDate = input.endDate || new Date().toISOString().split('T')[0];

if (!keyword) {
    log.error('❌ No keyword provided - exiting.');
    await Actor.setValue('ERROR', { message: 'keyword is required' });
    await Actor.exit({ exitCode: 1 });
}

// Construir URL de busca com todos os filtros
const searchUrl = `https://www.facebook.com/ads/library/?active_status=${adType}&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all&language=${language}&start_date=${startDate}&end_date=${endDate}`;

log.info(`🔍 Searching Facebook Ads Library for: "${keyword}" (country=${country}, adType=${adType}, language=${language}, from=${startDate} to=${endDate})`);
log.info(`Search URL: ${searchUrl}`);

const requestQueue = await RequestQueue.open();
await requestQueue.addRequest({ url: searchUrl });

// Função de tratamento da página
const handlePage = async ({ page, request }) => {
    log.info(`Processing ${request.url}`);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4000);

    // Espera até que blocos de anúncio possíveis existam
    await page.waitForSelector('div.x1lliihq', { timeout: 30000 }).catch(() => {
        log.warning('⚠️ No ad containers found with default selector.');
    });

    let collected = [];
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);

    // rolar e coletar anúncios
    for (let scroll = 0; scroll < 10 && collected.length < maxResults; scroll++) {
        const ads = await page.evaluate(() => {
            const items = [];
            const nodes = document.querySelectorAll('div.x1lliihq.x6ikm8r.x10wlt62');

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
                } catch (err) {
                    // falhar silenciosamente em casos de erro no elemento
                }
            });

            return items;
        });

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
