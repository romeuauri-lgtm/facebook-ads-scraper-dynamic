import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const keyword = (input.keyword || '').trim();
const country = (input.country || 'ALL').toUpperCase();
const maxResults = parseInt(input.maxResults || 50, 10);

if (!keyword) {
    log.error('❌ No keyword provided - exiting.');
    await Actor.setValue('ERROR', { message: 'keyword is required' });
    await Actor.exit({ exitCode: 1 });
}

const searchUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all`;

log.info(`🔍 Searching Facebook Ads Library for: "${keyword}" (country=${country})`);
log.info(`Search URL: ${searchUrl}`);

const requestQueue = await RequestQueue.open();
await requestQueue.addRequest({ url: searchUrl });

// Função principal
const handlePage = async ({ page, request }) => {
    log.info(`Processing ${request.url}`);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4000);

    // Espera até os blocos de anúncios carregarem
    await page.waitForSelector('div.x1lliihq', { timeout: 30000 }).catch(() => log.warning('⚠️ No ad containers found.'));

    let collected = [];
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);

    for (let scroll = 0; scroll < 10 && collected.length < maxResults; scroll++) {
        // Extrai anúncios da página atual
        const ads = await page.evaluate(() => {
            const items = [];
            const nodes = document.querySelectorAll('div.x1lliihq.x6ikm8r.x10wlt62'); // container principal

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
        });

        // Deduplicar resultados
        for (const ad of ads) {
            if (!collected.find(a => a.text === ad.text && a.pageName === ad.pageName)) {
                collected.push(ad);
            }
        }

        // Scroll para carregar mais anúncios
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
        await page.waitForTimeout(1500);

        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === lastHeight) break;
        lastHeight = newHeight;
    }

    // Limitar ao máximo configurado
    collected = collected.slice(0, maxResults);

    // Push para dataset
    for (const [index, ad] of collected.entries()) {
        await Actor.pushData({
            keyword,
            country,
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

// Configuração do Crawler
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
