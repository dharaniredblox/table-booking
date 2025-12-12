// Uber Eats store extractor: parse HTML and return fields per comp_req.txt
// Returns a best-effort object. Missing fields are null if not found.

import * as cheerio from 'cheerio';

function cleanText(s) {
    if (s == null) return null;
    return String(s).replace(/\s+/g, ' ').trim() || null;
}

function collectAppJson($) {
    const out = [];
    $('script[type="application/json"]').each((_, el) => {
        const id = $(el).attr('id') || null;
        const raw = $(el).html() || '';
        console.log("raw",raw)
        if (!raw.trim()) return;
        try { out.push({ id, data: JSON.parse(raw) }); } catch { }
    });
    return out;
}

// Normalize a raw MenuItem-like object into an API-friendly shape
function normalizeMenuItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // Keep offers object(s) as-is (not flattened into price fields)
    const offers = Array.isArray(raw.offers) ? raw.offers : (raw.offers || null);
    const images = Array.isArray(raw.image) ? raw.image : (raw.image ? [raw.image] : []);
    const dietary = raw.suitableForDiet
        ? (Array.isArray(raw.suitableForDiet) ? raw.suitableForDiet : [raw.suitableForDiet])
        : [];
    return {
        id: raw.id || raw.sku || raw['@id'] || null,
        type: raw['@type'] || 'MenuItem',
        name: raw.name || null,
        description: raw.description || null,
        offers,
        images,
        nutrition: raw.nutrition || null,
        suitableForDiet: dietary,
    };
}

function deepFindAll(root, predicate, limit = 100) {
    const res = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length && res.length < limit) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        if (seen.has(cur)) continue; seen.add(cur);
        try { if (predicate(cur)) res.push(cur); } catch { }
        for (const k of Object.keys(cur)) {
            const v = cur[k];
            if (v && typeof v === 'object') stack.push(v);
            if (typeof v === 'string') {
                const s = v.trim();
                if ((s.startsWith('{') || s.startsWith('[')) && s.length > 50) {
                    try { const parsed = JSON.parse(s); if (parsed && typeof parsed === 'object') stack.push(parsed); } catch { }
                }
            }
            if (Array.isArray(v)) for (const it of v) stack.push(it);
        }
    }
    return res;
}

function parseMoneyFromString(s) {
    if (!s) return null;
    const m = String(s).match(/([£$€])?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
    if (!m) return null;
    return { currency: m[1] || null, amount: Number(m[2]) };
}

function toArray(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }

function toNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

// Try to extract geo coordinates from JSON-LD or app JSON blobs
function extractGeo(jsonld, appJson) {
    // From JSON-LD
    let lat = jsonld?.geo?.latitude ?? jsonld?.latitude ?? null;
    let lon = jsonld?.geo?.longitude ?? jsonld?.longitude ?? jsonld?.lng ?? null;
    lat = toNumber(lat);
    lon = toNumber(lon);
    if (lat != null && lon != null) return { latitude: lat, longitude: lon };

    // Search app JSON for likely coordinate shapes
    for (const blob of appJson) {
        const candidates = deepFindAll(
            blob.data,
            o => (
                o && typeof o === 'object' && (
                    (o.latitude != null && (o.longitude != null || o.lng != null)) ||
                    (o.lat != null && (o.lon != null || o.lng != null)) ||
                    (o.location && (o.location.lat != null && (o.location.lon != null || o.location.lng != null)))
                )
            ),
            5
        );
        for (const c of candidates) {
            const a = c.location?.lat ?? c.latitude ?? c.lat;
            const b = c.location?.lon ?? c.location?.lng ?? c.longitude ?? c.lng ?? c.lon;
            const A = toNumber(a);
            const B = toNumber(b);
            if (A != null && B != null) return { latitude: A, longitude: B };
        }
    }
    return { latitude: null, longitude: null };
}

function normalizeOpeningHours(spec) {
    if (!spec) return null;
    const arr = Array.isArray(spec) ? spec : [spec];
    const daysOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    const out = [];
    for (const e of arr) {
        // Handle schema.org dayOfWeek values as strings or URLs
        const days = toArray(e.dayOfWeek).map(d => {
            if (!d) return null;
            const s = typeof d === 'string' ? d : (d['@id'] || d['@type'] || '');
            const m = String(s).match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
            if (!m) return null;
            const day = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
            return day;
        }).filter(Boolean);

        const opens = e.opens || e.openingTime || null;
        const closes = e.closes || e.closingTime || null;

        // If multiple days, expand into separate entries
        for (const day of days) {
            out.push({ day, opens, closes });
        }
    }

    // Sort by weekday order
    out.sort((a, b) => daysOrder.indexOf(a.day) - daysOrder.indexOf(b.day));
    return out;
}

// Unfold all menu items from a Restaurant-like object (e.g., your printed "r")
// - Keeps each item object AS-IS (no shape changes)
// - Handles single object vs array
// - Recurses nested hasMenuSection
export function unfoldMenuRawFromRestaurant(restaurantLike) {
    const out = [];

    function visitSection(section, path = []) {
        if (!section || typeof section !== 'object') return;

        const sectionName = section.name || null;
        const nextPath = [...path, sectionName].filter(Boolean);

        // Items can be array or single object or undefined
        const items = section.hasMenuItem;
        if (Array.isArray(items)) {
            for (const it of items) {
                out.push({ section: sectionName, path: nextPath, item: it });
            }
        } else if (items && typeof items === 'object') {
            out.push({ section: sectionName, path: nextPath, item: items });
        }

        // Nested subsections
        const subsections = section.hasMenuSection;
        if (Array.isArray(subsections)) {
            for (const sub of subsections) visitSection(sub, nextPath);
        } else if (subsections && typeof subsections === 'object') {
            visitSection(subsections, nextPath);
        }
    }

    const topSections = restaurantLike?.hasMenu?.hasMenuSection;
    if (Array.isArray(topSections)) {
        for (const s of topSections) visitSection(s, []);
    } else if (topSections && typeof topSections === 'object') {
        visitSection(topSections, []);
    }

    return out;
}

// Build a key-value menu map from unfolded rows.
// Key = joined section path (e.g., "Starters > Chaats"), Value = array of raw item objects.
export function buildMenuMapFromRestaurant(restaurantLike, joiner = ' > ') {
    const rows = unfoldMenuRawFromRestaurant(restaurantLike);
    const map = {}; // JSON-safe object
    for (const row of rows) {
        const key = (row.path && row.path.length) ? row.path.join(joiner) : '(root)';
        if (!map[key]) map[key] = [];
        const normalized = normalizeMenuItem(row.item);
        if (normalized) map[key].push(normalized);
    }
    return map;
}

// Flat list of normalized items with section path
export function buildMenuItemsFlatFromRestaurant(restaurantLike, joiner = ' > ') {
    const rows = unfoldMenuRawFromRestaurant(restaurantLike);
   
    const out = [];
    for (const row of rows) {
        const sectionPath = (row.path && row.path.length) ? row.path.join(joiner) : '(root)';
        const normalized = normalizeMenuItem(row.item);
        if (normalized) out.push({ sectionPath, ...normalized });
    }
    return out;
}

function extractMenuFromCandidates(jsonld, appJson) {
    // Return both structures: { menuMap, menuItems }
    // if (jsonld?.hasMenu?.hasMenuSection) {
    //     // console.log("jsonld",jsonld)
    //     console.log("jsonld.hasMenu",jsonld.hasMenu.hasMenuSection[0].hasMenuItem)
    //     return {
    //         menuMap: buildMenuMapFromRestaurant(jsonld),
    //         menuItems: buildMenuItemsFlatFromRestaurant(jsonld),
    //     };
    // }
    
    for (const blob of appJson) {//it gives uuid and session details
        // console.log("blob",blob, "\n")
        const found = deepFindAll(blob.data, o => o?.hasMenu?.hasMenuSection, 1);
        // console.log(" found", found)
        if (found.length) {
            // console.log("found",found)
            return {
                menuMap: buildMenuMapFromRestaurant(found[0]),
                menuItems: buildMenuItemsFlatFromRestaurant(found[0]),
            };
        }
    }
    return { menuMap: {}, menuItems: [] };
}

export function extractUberEatsStore(html) {
    const $ = cheerio.load(html);

    // JSON-LD restaurant (if present)
    let jsonld = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const raw = $(el).html() || '';
            if (!raw.trim()) return;
            const obj = JSON.parse(raw);
            const list = Array.isArray(obj) ? obj : [obj];
            for (const c of list) {
                // console.log("c",c)
                const types = toArray(c['@type']);
                if (types.includes('Restaurant')) { jsonld = c; return false; }
            }
        } catch { }
    });

    // Application JSON blobs (React state etc.)
    const appJson = collectAppJson($);

    // Try to locate a restaurant/store-like node in app JSON
    let restCandidate = null;
    for (const blob of appJson) {
        const found = deepFindAll(blob.data, o => (
            (o && typeof o === 'object') && (
                o.hasMenu?.hasMenuSection || // schema-like
                o.store?.title || o.store?.name ||
                (o.title && o.sectionUuid) ||
                o.restaurantInfo || o.merchantInfo || o.brandInfo
            )
        ), 50);
        if (found.length) { restCandidate = found[0]; break; }
    }

    // Basic fields
    const titleTag = cleanText($('title').first().text());
    const ogTitle = cleanText($('meta[property="og:title"]').attr('content'));
    const ogImage = cleanText($('meta[property="og:image"]').attr('content'));

    // Name
    const name = cleanText(
        jsonld?.name || restCandidate?.name || restCandidate?.store?.title || restCandidate?.store?.name || ogTitle || titleTag
    );

    // Logo/image
    const logo = jsonld?.image || jsonld?.logo || restCandidate?.image || restCandidate?.logo || ogImage || null;

    // Cuisines
    let cuisineTypes = jsonld?.servesCuisine || restCandidate?.cuisines || restCandidate?.store?.cuisine || [];
    cuisineTypes = Array.isArray(cuisineTypes) ? cuisineTypes : (cuisineTypes ? [cuisineTypes] : []);

    // Tags (dietary etc.)
    const tags = (restCandidate?.dietaryTags || restCandidate?.tags || restCandidate?.store?.badges || []).filter(Boolean);

    // Address components
    const addr = jsonld?.address || restCandidate?.address || restCandidate?.store?.address || null;
    const address = addr ? {
        streetAddress: addr.streetAddress || addr.address1 || addr.line1 || null,
        addressLocality: addr.addressLocality || addr.city || addr.locality || null,
        addressRegion: addr.addressRegion || addr.region || addr.state || null,
        postalCode: addr.postalCode || addr.zip || null,
        addressCountry: addr.addressCountry || addr.country || null,
    } : null;
    const postcode = address?.postalCode || null;
    const locality = address?.addressLocality || null;

    // Delivery radius (heuristic; often in meters/km in state)
    let deliveryRadius = restCandidate?.deliveryRadius || restCandidate?.store?.deliveryRadius || null;
    if (typeof deliveryRadius === 'number') deliveryRadius = { unit: 'm', value: deliveryRadius };

    // Opening hours
    const openingHours = normalizeOpeningHours(
        jsonld?.openingHoursSpecification || restCandidate?.openingHoursSpecification || restCandidate?.hours || null
    );
    // Times
    const estimatedPrepTime = restCandidate?.prepTime || restCandidate?.estimatedPrepTime || null;
    const estimatedDeliveryTime = restCandidate?.deliveryTime || restCandidate?.estimatedDeliveryTime || restCandidate?.etaRange || null;

    // Ratings
    const agg = jsonld?.aggregateRating || restCandidate?.aggregateRating || restCandidate?.rating || null;
    const ratingAvg = agg?.ratingValue ?? agg?.value ?? null;
    const totalReviews = agg?.reviewCount ?? agg?.count ?? null;

    // Hygiene rating (rarely exposed)
    const hygieneRating = restCandidate?.hygieneRating ?? null;

    // Fees and thresholds
    let deliveryFee = null;
    let minimumOrderValue = null;
    let offers = [];

    // Search appJson for common fee fields
    for (const blob of appJson) {
        const fees = deepFindAll(blob.data, o => o && (o.deliveryFee || o.fee || o.minimumOrderValue || o.minOrderValue || o.promo || o.promotions), 20);
        for (const f of fees) {
            if (deliveryFee == null && (f.deliveryFee || f.fee)) deliveryFee = f.deliveryFee || f.fee;
            if (minimumOrderValue == null && (f.minimumOrderValue || f.minOrderValue)) minimumOrderValue = f.minimumOrderValue || f.minOrderValue;
            if (f.promo) offers = offers.concat(toArray(f.promo));
            if (f.promotions) offers = offers.concat(toArray(f.promotions));
        }
        if (deliveryFee && minimumOrderValue) break;
    }

    // Fallback: try to parse money-like strings in meta
    if (deliveryFee == null) deliveryFee = parseMoneyFromString($('meta[name="delivery:fee"]').attr('content')) || null;
    if (minimumOrderValue == null) minimumOrderValue = parseMoneyFromString($('meta[name="order:minimum"]').attr('content')) || null;
    const { menuMap, menuItems } = extractMenuFromCandidates(jsonld, appJson);
    const { latitude, longitude } = extractGeo(jsonld, appJson);
    return {
        name: name || null,
        logo: logo || null,
        cuisineTypes,
        tags,
        address,
        postcode,
        locality,
        latitude,
        longitude,
        deliveryRadius,
        openingHours,
        estimatedPrepTime,
        estimatedDeliveryTime,
        ratingAvg,
        totalReviews,
        hygieneRating,
        deliveryFee,
        minimumOrderValue,
        // API-friendly menu outputs
        // menu: menuMap,          // backward compatible key
        // menuItems,              // flat list
    };
}

export default extractUberEatsStore;
