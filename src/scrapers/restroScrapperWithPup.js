import 'dotenv/config';
import { saveToFile } from '../utils/file-handler.js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

async function detectShadowDOM(page) {
    // Detect open shadow roots
    const openHosts = await page.evaluate(() =>
        [...document.querySelectorAll('*')]
            .filter(el => !!el.shadowRoot)
            .map(el => ({
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                classes: el.className || null
            }))
    );

    // Detect creation of shadow roots (open or closed) via attachShadow hook
    // Use addInitScript BEFORE navigation to catch early creation
    const attachEvents = await page.evaluate(() => window.__shadowAttachEvents || []);
    return { openHosts, attachEvents };
}

puppeteer.use(StealthPlugin());

// /**
//  * Normalizes restaurant data into a consistent structure
//  * @param {Object} data - The raw restaurant data from the scraper
//  * @returns {Object} Normalized restaurant data
//  */
function normalizeRestaurantData(data) {
    const raw = data.restaurantInfo.raw || {};

    // Process menu sections
    const processMenuSections = (sections) => {
        if (!sections || !Array.isArray(sections)) {
            return {
                "@type": "Menu",
                "menu_sections": [],
                ...Object.fromEntries(sections || [])
            };
        }

        const menuData = {
            "@type": "Menu",
            "menu_sections": sections.map(section => section.name).filter(Boolean)
        };

        // Add each section's items under its name
        sections.forEach(section => {
            if (section.name && Array.isArray(section.hasMenuItem)) {
                menuData[section.name] = section.hasMenuItem.map(item => ({
                    "@type": "MenuItem",
                    "name": item.name || "",
                    "description": item.description || "",
                    "offers": {
                        "@type": "Offer",
                        "price": item.offers?.price || "0",
                        "priceCurrency": item.offers?.priceCurrency || "GBP"
                    }
                }));
            }
        });

        return menuData;
    };

    // Create normalized structure
    const normalized = {
        "@type": raw["@type"] || "Restaurant",
        "@id": raw["@id"] || "",
        "name": raw.name || data.restaurantInfo.name || "",
        "image": Array.isArray(raw.image) ? raw.image : [raw.image].filter(Boolean),
        "aggregateRating": {
            "@type": "AggregateRating",
            "ratingValue": parseFloat(raw.aggregateRating?.ratingValue) || 0,
            "reviewCount": String(raw.aggregateRating?.reviewCount || "0")
        },
        "servesCuisine": Array.isArray(raw.servesCuisine)
            ? [...new Set(raw.servesCuisine)]
            : [raw.servesCuisine].filter(Boolean),
        "geo": {
            "@type": "GeoCoordinates",
            "latitude": parseFloat(raw.geo?.latitude) || 0,
            "longitude": parseFloat(raw.geo?.longitude) || 0
        },
        "telephone": raw.telephone || data.restaurantInfo.telephone || "",
        "openingHoursSpecification": raw.openingHoursSpecification || data.restaurantInfo.openingHours || [],
        "hasMenu": processMenuSections(raw.hasMenu?.hasMenuSection || [])
    };

    return normalized;
}

/**
 * Saves normalized data to a file with timestamp
 * @param {Object} data - The data to save
 * @param {string} originalPath - Path of the original file
 */
async function saveNormalizedData(data) {
    try {
        // Create normalized data
        const normalizedData = normalizeRestaurantData(data);
        const newFilename = normalizedData.name ? `${normalizedData.name}_puppeter_normalized_${Date.now()}.json` : `puppeter_normalized_${Date.now()}.json`;
        await saveToFile(newFilename, normalizedData, { json: true })
    } catch (error) {
        console.error('Error saving normalized data:', error);
        throw error;
    }
}

function deepFindAll(root, predicate, maxDepth = 6) {
    const found = [];
    const stack = [{ node: root, depth: 0 }];
    const seen = new Set();
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);

        try {
            if (predicate(node)) found.push(node);
        } catch (_) {
            /* ignore predicate errors */
        }

        if (depth >= maxDepth) continue;

        if (Array.isArray(node)) {
            for (const item of node) stack.push({ node: item, depth: depth + 1 });
        } else {
            for (const key of Object.keys(node)) stack.push({ node: node[key], depth: depth + 1 });
        }
    }
    return found;
}

function normalizeMenuFromRestaurant(restaurantObj) {
    // Expect structures like restaurantObj.hasMenu.hasMenuSection[].hasMenuItem[]
    const menu = [];
    const sections = restaurantObj?.hasMenu?.hasMenuSection || [];
    for (const sec of sections) {
        const sectionName = sec?.name || sec?.title || 'Untitled Section';
        const items = sec?.hasMenuItem || sec?.items || [];
        for (const it of items) {
            menu.push({
                section: sectionName,
                id: it['@id'] || it.id || null,
                name: it.name || it.title || '',
                description: it.description || it.itemDescription || '',
                price: it?.offers?.price || it.price || null,
                currency: it?.offers?.priceCurrency || it.currency || null,
                raw: it,
            });
        }
    }
    return menu;
}

async function collectJSONLD(page) {
    return await page.evaluate(() => {
        const out = [];
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const json = JSON.parse(s.textContent || 'null');
                if (json) out.push(json);
            } catch (_) { }
        }
        return out;
    });
}

async function collectWindowBlobs(page) {
    // Try to extract any window-level data objects your site injects
    return await page.evaluate(() => {
        const candidates = [];
        const g = window;
        for (const k of Object.keys(g)) {
            try {
                const v = g[k];
                if (!v) continue;
                // Common patterns: objects with data or state fields
                if (typeof v === 'object') {
                    if (v.data || v.state || v.store || v.app || v.props) {
                        candidates.push({ id: k, data: v });
                    }
                }
            } catch (_) { }
        }
        return candidates;
    });
}

async function scrapeWithPuppeteer(url) {
    console.log('[puppeter] Launching browser...');
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: { width: 1366, height: 900 },
        });
    } catch (e) {
        console.error('[puppeter] Failed to launch browser:', e?.message || e);
        throw e;
    }

    const page = await browser.newPage();
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);

    // Reasonable headers to mimic desktop web
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
        'accept-language': 'en-GB,en;q=0.9',
    });

    const jsonResponses = [];

    page.on('response', async (res) => {

        const ct = res.headers()['content-type'] || '';
        const url = res.url();
        // Heuristics: capture JSON/XHRs which often include store/menu data
        const likely =
            ct.includes('application/json') ||
            url.includes('eats') ||
            url.includes('menu') ||
            url.includes('graphql') ||
            url.includes('store') ||
            url.includes('restaurant');

        if (!likely) return;
        try {
            const text = await res.text();
            if (!text) return;
            if (text.startsWith('{') || text.startsWith('[')) {
                const parsed = JSON.parse(text);
                jsonResponses.push({ url, body: parsed });
            }
        } catch (_) {
            /* ignore non-JSON */
        }
    });


    // Before page.goto: install a hook to capture attachShadow (works for open/closed)
    // const hookShadowAttach = () => {
    //     const seen = [];
    //     const orig = Element.prototype.attachShadow;
    //     Element.prototype.attachShadow = function (init) {
    //         try { seen.push({ tag: this.tagName.toLowerCase(), mode: (init && init.mode) || 'open' }); } catch { }
    //         return orig.call(this, init);
    //     };
    //     // expose for later read
    //     window.__shadowAttachEvents = seen;
    // };
    // if (typeof page.addInitScript === 'function') {
    //     await page.addInitScript(hookShadowAttach);
    // } else if (typeof page.evaluateOnNewDocument === 'function') {
    //     await page.evaluateOnNewDocument(hookShadowAttach);
    // }

    await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 90000 });

    // // After page.goto(...): To check shadow DOM
    // const info = await detectShadowDOM(page);
    // console.log('Shadow (open hosts):', info.openHosts);
    // console.log('Shadow (attach events):', info.attachEvents);
    // Give SPA a moment to fire late XHRs
    await new Promise((res) => setTimeout(res, 3000));

    const jsonldList = await collectJSONLD(page).catch(() => []);
    const windowBlobs = await collectWindowBlobs(page).catch(() => []);

    const jsonldCount = Array.isArray(jsonldList) ? jsonldList.length : 0;
    const windowBlobsCount = Array.isArray(windowBlobs) ? windowBlobs.length : 0;
    const jsonResponsesCount = Array.isArray(jsonResponses) ? jsonResponses.length : 0;
    console.log('[puppeter] Collected:', { jsonldCount, windowBlobsCount, jsonResponsesCount });

    // Try extraction priority: JSON-LD -> window blobs -> network JSON
    let restaurantCandidate = null;

    // 1) JSON-LD
    for (const j of (Array.isArray(jsonldList) ? jsonldList : [])) {
        const hits = deepFindAll(j, (o) => o?.hasMenu?.hasMenuSection, 4);
        if (hits.length) {
            restaurantCandidate = hits[0];
            break;
        }
    }

    // 2) Window blobs
    if (!restaurantCandidate) {
        for (const blob of (Array.isArray(windowBlobs) ? windowBlobs : [])) {
            const hits = deepFindAll(blob.data, (o) => o?.hasMenu?.hasMenuSection, 4);
            if (hits.length) {
                restaurantCandidate = hits[0];
                break;
            }
        }
    }

    // 3) Network responses
    if (!restaurantCandidate) {
        for (const resp of (Array.isArray(jsonResponses) ? jsonResponses : [])) {
            const hits = deepFindAll(resp.body, (o) => o?.hasMenu?.hasMenuSection, 5);
            if (hits.length) {
                restaurantCandidate = hits[0];
                break;
            }
        }
    }

    let menuItems = [];
    if (restaurantCandidate) {
        menuItems = normalizeMenuFromRestaurant(restaurantCandidate);
    }

    // Basic top-level fields from JSON-LD as a bonus
    let restaurantInfo = {};
    for (const j of jsonldList) {
        if (j['@type'] === 'Restaurant' || j['@type']?.includes?.('Restaurant')) {
            restaurantInfo = {
                name: j.name,
                url: j.url,
                telephone: j.telephone,
                address: j.address,
                openingHours: j.openingHours || j.openingHoursSpecification,
                aggregateRating: j.aggregateRating,
                priceRange: j.priceRange,
                servesCuisine: j.servesCuisine,
                raw: j,
            };
            break;
        }
    }

    await browser.close();

    return { restaurantInfo, menuItems, debug: { jsonResponsesCount, jsonldCount, windowBlobsCount } };
}

async function main() {
    // Find first arg that looks like a URL (handles cases like --"https://...")
    const rawArgs = process.argv.slice(2);
    let url = process.env.UE_URL || rawArgs.find(a => typeof a === 'string' && a.includes('http')) || '';
    // Clean any leading dashes and surrounding quotes
    url = url.replace(/^--+/, '').replace(/^"|"$/g, '');

    if (!url || !/^https?:\/\//i.test(url)) {
        console.error('Usage: node src/puppeter.js <uber_eats_restaurant_url>');
        console.error('Example: node src/puppeter.js "https://www.ubereats.com/gb/store/..."');
        process.exit(1);
    }

    console.log('[puppeter] Starting scrape for:', url);
    const started = Date.now();
    const out = await scrapeWithPuppeteer(url);
    // Print concise summary and write full output to data/output
    console.log('[puppeter] Restaurant:', out.restaurantInfo?.name || '(unknown)');
    console.log('[puppeter] Menu items found:', out.menuItems.length);
    console.log('[puppeter] Debug:', out.debug);
    try {
        await saveNormalizedData(out);
    } catch (error) {
        console.error('Could not save normalized data:', error);
    }
    console.log('[puppeter] Done in', Math.round((Date.now() - started) / 1000), 's');
}

console.log('[puppeter] Script loaded.');
main().catch((err) => {
    console.error('Puppeteer scrape failed:', err);
    process.exit(1);
});
