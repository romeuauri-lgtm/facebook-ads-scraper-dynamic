import { Actor } from 'apify';
import { RequestQueue, BasicCrawler, launchPuppeteer } from 'crawlee';

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

// build Facebook Ads Library search URL
const searchUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all`;

console.log(`Searching Facebook Ads Library for: "${keyword}" country=${country}`);
console.log('Search URL:', searchUrl);

const requestQueue = await RequestQueue.open();
await requestQueue.addRequest({ url: searchUrl });

const handlePageFunction = async ({ page, request }) => {
    console.log('Processing', request.url);

    await page.waitForTimeout(1500);

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
        } catch (e) { /* ignore */ }
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

                    const titleEl = n.querySelector('h3') || n.querySelector('strong') || n.querySelector('[role="heading"]');
                    const title = titleEl ? titleEl.innerText.trim() : null;

                    const txtEl = n.querySelector('div[dir="auto"]') || n.querySelector('p') || n;
                    const text = txtEl ? txtEl.innerText.trim().slice(0, 800) : null;

                    let pageName = null;
                    const pageEl = n.querySelector('a[href*="/pages/"], a[href*="/pg/"]') || n.querySelector('[aria-label*="Page"]');
                    if (pageEl) pageName = pageEl.innerText.trim();

                    const imgs = Array.from(n.querySelectorAll('img')).map(i => i.src).filter(Boolean);

                    const key = snapshot || title || text || (imgs[0] || '');
                    if (key && !seen.has(key)) {
                        seen.add(key);
                        ads.push({ snapshot, title, text, pageName, media: imgs });
                    }
                } catch (e) {}
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

        await page.evaluate('window.scrollBy(0, window.innerHeight)');
        await page.waitForTimeout(1200);

        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === lastHeight) break;
        lastHeight = newHeight;
    }

    let index = 0;
    for (const ad of collected.slice(0, maxResults)) {
        index++;
        await Actor.pushData({
            keyword,
            country,
            rank: index,
            snapshot_url: ad.snapshot,
            title: ad.title,
            text: ad.text,
            page_name: ad.pageName,
            media: ad.media,
            scraped_at: new Date().toISOString(),
            source_url: request.url
        });
    }

    console.log(`Pushed ${collected.slice(0, maxResults).length} items`);
};

const crawler = new BasicCrawler({
    requestQueue,
    maxConcurrency: 1,
    handleRequestFunction: async ({ request }) => {
        const browser = await launchPuppeteer({ headless: true, stealth: true });
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36');

        try {
            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(3000);
            await handlePageFunction({ page, request });
        } catch (err) {
            console.error('Page error', err);
        } finally {
            await browser.close();
        }
    },
    handleFailedRequestFunction: async ({ request }) => {
        console.log(`Request ${request.url} failed too many times.`);
    },
});

await crawler.run();

console.log('Actor finished.');
await Actor.exit();
