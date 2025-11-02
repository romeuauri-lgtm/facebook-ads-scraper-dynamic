import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const keyword = (input.keyword || '').trim();
const country = (input.country || 'ALL').toUpperCase();
const maxResults = parseInt(input.maxResults || 50, 10);

if (!keyword) {
    console.log('No keyword provided - exiting.');
    await Actor.setValue('ERROR', { message: 'keyword is required' });
    await Actor.exit({ exitCode: 1 });
}

// Build Facebook Ads Library search URL
const searchUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all`;

console.log(`Searching Facebook Ads Library for: "${keyword}" country=${country}`);
console.log('Search URL:', searchUrl);

const requestQueue = await RequestQueue.open();
await requestQueue.addRequest({ url: searchUrl });

// Handler principal
const handlePage = async ({ page, request, log }) => {
    log.info(`Processing ${request.url}`);
    await page.waitForTimeout(2000);

    const possibleSelectors = [
        'div[role="article"]',
        'div[data-testid*="ad"]',
        'div[aria-label*="Ad"]',
        'div._7kq'
    ];

    let found = false;
    for (const sel of possibleSelectors) {
        try {
            found = await page.$(sel) !== null;
            if (found) break;
        } catch {}
    }

    let collected = [];
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);

    for (let i = 0; i < 8 && collected.length < maxResults; i++) {
        const items = await page.evaluate(() => {
            const ads = [];
            const nodes = Array.from(document.querySelectorAll('a[href*="/ads/library/"], div[role="article"], [data-testid]'));
            const seen = new Set();
            nodes.forEach(n => {
                try {
                    const linkEl = n.querySelector('a[href*="/ads/library/"]') || (n.tagName === 'A' && n.href ? n : null);
                    const snapshot = linkEl ? linkEl.href : null;

                    const titleEl = n.querySelector('h3, strong, [role="heading"]');
                    const title = titleEl ? titleEl.innerText.trim() : null;

                    const txtEl = n.querySelector('div[dir="auto"], p, span');
                    const text = txtEl ? txtEl.innerText.trim().slice(0, 800) : null;

                    let pageName = null;
                    const pageEl = n.querySelector('a[href*="/pages/"], a[href*="/pg/"], [aria-label*="Page"]');
                    if (pageEl) pageName = pageEl.innerText.trim();

                    const imgs = Array.from(n.querySelectorAll('img')).map(i => i.src).filter(Boolean);

                    const key = snapshot || title || text || (imgs[0] || '');
                    if (key && !seen.has(key)) {
                        seen.add(key);
                        ads.push({ snapshot, title, text, pageName, media: imgs });
                    }
                } catch {}
            });
            return ads;
        });

        for (const it of items) {
            const exists = collected.find(x =>
                (x.snapshot && it.snapshot && x.snapshot === it.snapshot) ||
                (x.title && it.title && x.title === it.title)
            );
            if (!exists) collected.push(it);
            if (collected.length >= maxResults) break;
        }

        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(1200);

        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === lastHeight) break;
        lastHeight = newHeight;
    }

    for (const [index, ad] of collected.slice(0, maxResults).entries()) {
        await Actor.pushData({
            keyword,
            country,
            rank: index + 1,
            snapshot_url: ad.snapshot,
            title: ad.title,
            text: ad.text,
            page_name: ad.pageName,
            media: ad.media,
            scraped_at: new Date().toISOString(),
            source_url: request.url
        });
    }

    log.info(`Pushed ${collected.length} ads.`);
};

// Crawler Playwright (substitui BasicCrawler + launchPuppeteer)
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
    failedRequestHandler: async ({ request, log }) => {
        log.error(`Request ${request.url} failed after multiple retries.`);
    }
});

await crawler.run();

console.log('Actor finished.');
await Actor.exit();
