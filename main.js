import Apify from 'apify';

const { Actor } = Apify;

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
// using keyword and country
const searchUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all`;

console.log(`Searching Facebook Ads Library for: "${keyword}" country=${country}`);
console.log('Search URL:', searchUrl);

const requestQueue = await Apify.openRequestQueue();
await requestQueue.addRequest({ url: searchUrl });

const handlePageFunction = async ({ page, request, response }) => {
    console.log('Processing', request.url());

    // Wait for ads container to render. This selector is heuristic and may need updates.
    // We wait for either ad card container or results container.
    await page.waitForTimeout(1500);

    // try to wait for multiple possible ad container selectors
    const possibleSelectors = [
        'div[role="article"]', // common ARIA role for posts
        'div[data-testid*="ad"]',
        'div[aria-label*="Ad"]',
        'div._7kq' // fallback class — may change
    ];

    let found = false;
    for (const sel of possibleSelectors) {
        try {
            found = await page.$(sel) !== null;
            if (found) {
                break;
            }
        } catch (e) { /* ignore */ }
    }

    // scroll and wait to load more results (simple pagination emulation)
    // scroll a few times, respecting maxResults
    let collected = [];
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);
    for (let i = 0; i < 8 && collected.length < maxResults; i++) {
        // extract ad items on page
        const items = await page.evaluate(() => {
            // Helper to safely extract data from a node
            const ads = [];
            // find anchor links to ad snapshot or ad cards
            const nodes = Array.from(document.querySelectorAll('a[href*="/ads/library/"], div[role="article"], [data-testid]'));
            const seen = new Set();
            nodes.forEach(n => {
                try {
                    // Try to locate a snapshot link in the node subtree
                    const linkEl = n.querySelector('a[href*="/ads/library/"]') || (n.tagName === 'A' && n.href ? n : null);
                    const snapshot = linkEl ? linkEl.href : null;

                    // Title or text
                    const titleEl = n.querySelector('h3') || n.querySelector('strong') || n.querySelector('[role="heading"]');
                    const title = titleEl ? titleEl.innerText.trim() : null;

                    // Body text
                    const txtEl = n.querySelector('div[dir="auto"]') || n.querySelector('p') || n;
                    const text = txtEl ? txtEl.innerText.trim().slice(0, 800) : null;

                    // Page / publisher name
                    let pageName = null;
                    const pageEl = n.querySelector('a[href*="/pages/"], a[href*="/pg/"]') || n.querySelector('[aria-label*="Page"]');
                    if (pageEl) pageName = pageEl.innerText.trim();

                    // images
                    const imgs = Array.from(n.querySelectorAll('img')).map(i => i.src).filter(Boolean);

                    // basic dedupe key
                    const key = snapshot || title || text || (imgs[0] || '');

                    if (key && !seen.has(key)) {
                        seen.add(key);
                        ads.push({
                            snapshot: snapshot,
                            title,
                            text,
                            pageName,
                            media: imgs
                        });
                    }
                } catch (e) {
                    // skip node
                }
            });
            return ads;
        });

        // merge items unique by snapshot or title
        for (const it of items) {
            const exists = collected.find(x => (x.snapshot && it.snapshot && x.snapshot === it.snapshot) || (x.title && it.title && x.title === it.title));
            if (!exists) collected.push(it);
            if (collected.length >= maxResults) break;
        }

        // scroll
        await page.evaluate('window.scrollBy(0, window.innerHeight)');
        await page.waitForTimeout(1200);

        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === lastHeight) {
            // no more content
            break;
        }
        lastHeight = newHeight;
    }

    // Normalize collected and push to dataset
    let index = 0;
    for (const ad of collected.slice(0, maxResults)) {
        index++;
        await Apify.pushData({
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

const crawler = new Apify.BasicCrawler({
    requestQueue,
    maxConcurrency: 1,
    handleRequestFunction: async ({ request }) => {
        const browser = await Apify.launchPuppeteer({ headless: true, stealth: true });
        const page = await browser.newPage();

        // Set user agent to reduce chance of blocks
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36');

        try {
            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            // Wait a bit for JS to render
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
