import * as cheerio from 'cheerio';
import fs from 'fs'
import { decode } from "html-entities";
import JSON5 from "json5";
import { uploadJson } from "../utils/s3Uploader.js";
import { normalizer } from "../utils/normalization.js"
import path from 'path';

// Helper function to convert minutes since midnight to HH:MM format
function formatTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

function generateRestaurantId(name, postalCode, lat, log) {
    const normalizedName = (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    return `${normalizedName}-${(postalCode || "N_A").replace(/\s+/g, "")}-${lat?.toFixed(0) || Date.now()}_${log?.toFixed(0) || ""}`;
}


function cleanText(s) {
    if (s == null) return null;
    return String(s).replace(/\s+/g, ' ').trim() || null;
}

function toArray(x) {
    return Array.isArray(x) ? x : (x == null ? [] : [x]);
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

function normalizeAddress(location, jsonld, restCandidate) {
    const {
        address,
        streetAddress,
        geo,
        region,
        postalCode,
        country,
        latitude,
        longitude,
    } = location || {};

    // Prepare fallback address if needed
    const add =
        jsonld?.address ||
        restCandidate?.address ||
        restCandidate?.store?.address ||
        {};

    const { lat: roundedLat, lng: roundedLng } = normalizer.roundLatLng(
        latitude || jsonld?.geo?.latitude,
        longitude || jsonld?.geo?.longitude
    );
    // ✅ Merge strategy: keep what exists, only fill missing
    return {
        fullAddress: address || null,
        streetAddress:
            streetAddress ||
            add.streetAddress ||
            add.address1 ||
            add.line1 ||
            add.addressLocality ||
            null,
        addressCity:
            geo?.city ||
            add.addressLocality ||
            add.city ||
            add.locality ||
            null,
        neighborhood: geo?.neighborhood || null,
        addressRegion:
            region ||
            add.addressRegion ||
            add.region ||
            add.state ||
            null,
        postalCode: postalCode || add.postalCode || add.zip || null,
        addressCountry: country || add.addressCountry || add.country || null,
        latitude: latitude || jsonld?.geo?.latitude || null,
        longitude: longitude || jsonld?.geo?.longitude || null,
        geohash: normalizer.generateGeohash(roundedLat, roundedLng),
    };
}

function getPriceFromItemItemThumNail(item) {
    try {
        const thumbnail = item.itemThumbnailElements?.[0]?.payload;
        if (!thumbnail) return null;

        // Try to get from text first, then accessibilityText
        return thumbnail.labelPayload?.label?.richTextElements?.[0]?.text?.text?.text ||
            thumbnail.labelPayload?.label?.accessibilityText;
    } catch (error) {
        return null;
    }
}

function normalizeMenuItem(item, currencyCodeAppJson = "N/A") {
    if (!item || typeof item !== "object") return null;
    return {
        id: item.uuid || null,
        name: item.name || item.title || "N/A",
        description: item.itemDescription || item.description || "N/A",
        price: (() => {
            const rawPrice = item.offers?.price ||
                item.priceTagline?.text ||
                item.priceTagline?.accessibilityText ||
                item.priceTagline?.textFormat?.replace(/<[^>]*>/g, '') ||
                getPriceFromItemItemThumNail(item) ||
                item.price;

            if (!rawPrice) return null;

            // Extract currency symbol and numbers/decimal
            const priceMatch = rawPrice.match(/([£$€]|Rs\.?|₹|¥)?\s*(\d*\.?\d+)/);
            return priceMatch ? (priceMatch[1] || '') + priceMatch[2] : null;
        })(),
        priceCurrency: item.offers?.priceCurrency || item.price?.currencyCode || currencyCodeAppJson,
        priceAccToPriceBucket: item.price || null,
        imageUrl: item.imageUrl || null,
        isSoldOut: item.isSoldOut ?? null,
        hasCustomizations: item.hasCustomizations ?? null,
    };
}

function unfoldMenuRawFromRestaurant(restaurantLike) {
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

function decodeEscapedUnicode(str) {
    if (typeof str !== 'string') return str;
    let s = str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
    );
    s = s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    return s;
}

function extractStringValue(decoded, key) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 's');
    const m = re.exec(decoded);
    if (!m) return null;
    const rawValue = m[1];
    try {
        return JSON.parse('"' + rawValue.replace(/"/g, '\\"') + '"');
    } catch {
        return rawValue.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
}

function uberParse(raw) {
    //Step 1: Uber escapes quotes and characters as HTML entities inside < script > tags(e.g., & quot; for ", &amp; for &).
    // This step turns it back into proper text.
    let decoded = decode(raw);

    // Step 2: Decode % encodings, They also shove URL-encoded JSON fragments (%22 → ", %5C → \).
    // This layer ensures those become real characters.
    decoded = decodeURIComponent(decoded);

    // Step 3: Fix escaped quotes
    decoded = decoded.replace(/\\u0022/g, '"');

    // Step 4: Try parsing
    try {
        return JSON.parse(decoded);
    } catch (e1) {
        try {
            return JSON5.parse(decoded);
        } catch (e2) {
            console.error("Uber parse failed:", e2.message);
            return null;
        }
    }
}

function collectAppJson($, useRegexToGetAddress = false, writeAppJsonToFile = false, postalCode = "N/A") {
    const script = $("#__REACT_QUERY_STATE__");
    if (!script.length) return { appJson: null, add: null };
    const scriptHTML = script.html();
    let finalData = null;
    try {
        const data = uberParse(scriptHTML);
        console.log(`✅ Successfully parsed RawJSON data from Uber Eats page`);
        const queries = data?.queries;
        finalData = queries && queries.length > 0 ? { ...queries[0]?.state?.data } : null
        // const fileName = finalData?.slug || finalData?.title?.split(" ")[0] || Date.now().toString().replace(/\s+/g, "_")

        const fileName = (jsonld?.name || Date.now().toString()).toString().replace(/\s+/g, "_");

        if (writeAppJsonToFile) {
            // Create postal code directory if it doesn't exist
            const postalCodeDir = path.join('./data/uberEatsRawJson', postalCode !== "N/A" ? postalCode : `${new Date().toISOString().split('T')[0]}`);
            if (!fs.existsSync(postalCodeDir)) {
                fs.mkdirSync(postalCodeDir, { recursive: true });
            }
            const filePath = path.join(postalCodeDir, `${fileName}.json`);
            if (fs.existsSync(filePath)) {
                fs.writeFileSync(`${filePath}.${new Date().toISOString().split('T')[0]}_bak.json`, JSON.stringify([{ id: "__REACT_QUERY_STATE__", data }], null, 2));
            }
            fs.writeFileSync(filePath, JSON.stringify([{ id: "__REACT_QUERY_STATE__", data }], null, 2));
        }
        return { appJson: finalData, add: null };
    } catch (error) {
        console.error("❌ Uber parse error:", error.message);

        if (useRegexToGetAddress) {
            // fallback regex-based extraction
            const decoded = decodeEscapedUnicode(scriptHTML);

            const streetAddress = extractStringValue(decoded, "streetAddress");
            let fullAddress = extractStringValue(decoded, "address");
            const postalCode =
                extractStringValue(decoded, "postalCode") ||
                extractStringValue(decoded, "postal_code") ||
                extractStringValue(decoded, "postcode");
            const city =
                extractStringValue(decoded, "city") ||
                extractStringValue(decoded, "addressLocality") ||
                extractStringValue(decoded, "citySlug");
            const lat = extractStringValue(decoded, "latitude");
            const lng = extractStringValue(decoded, "longitude");

            const parts = [streetAddress, city, postalCode].filter(Boolean);
            fullAddress = fullAddress ? fullAddress : parts.join(", ");

            const regAdd = {
                streetAddress: streetAddress || null,
                address: fullAddress || null,
                postalCode: postalCode || null,
                city: city || null,
                fullAddress: fullAddress || null,
                latitude: lat || null,
                longitude: lng || null,
            };

            return { appJson: null, add: regAdd };
        }

        return { appJson: null, add: null };
    }
}

function extractRestaurantDataFromJsonLd(jsonld, location = {}, deliveryTime = "N/A", writeJsonLdToFile = false, uploadOnS3ForRawState = false, postalCode = "N_A") {
    if (!jsonld) return null;
    const fileName = jsonld?.name.replace(" ", "_") || Date.now().toString()
    if (writeJsonLdToFile) {
        fs.writeFileSync(`./data/uberEatsRawJsonLd/${fileName}.json`, JSON.stringify(jsonld, null, 2));
    }
    if (writeJsonLdToFile) {
        // Create postal code directory if it doesn't exist
        const postalCodeDir = path.join('./data/uberEatsRawJsonLd', postalCode !== "N_A" ? postalCode : `${new Date().toISOString().split('T')[0]}`);
        if (!fs.existsSync(postalCodeDir)) {
            fs.mkdirSync(postalCodeDir, { recursive: true });
        }
        const filePath = path.join(postalCodeDir, `${fileName}.json`);
        if (fs.existsSync(filePath)) {
            fs.writeFileSync(`${filePath}.${new Date().toISOString().split('T')[0]}_bak.json`, JSON.stringify(jsonld, null, 2));
        }
        fs.writeFileSync(filePath, JSON.stringify(jsonld, null, 2));
    }
    if (uploadOnS3ForRawState) {
        const fileNamePrefix = `${fileName}_${jsonld['@id'].split("/")[jsonld['@id'].split("/").length - 1]}` || `${fileName}_${Date.now().toString()}`;
        const s3Key = `rawJsonLd/${fileNamePrefix}_JsonLd.json`;
        uploadJson(jsonld, "ubereats", s3Key);
    }
    const address = normalizeAddress(location, jsonld, null);
    // Build unified menu array
    const menu = [];
    const rows = unfoldMenuRawFromRestaurant(jsonld);
    const currencyCode = "N/A"; // fallback if JSON-LD has no currency info

    // Group items by section
    const sectionMap = {};
    for (const row of rows) {
        const sectionName = row.section || "N/A";
        if (!sectionMap[sectionName]) sectionMap[sectionName] = [];
        const normalized = normalizeMenuItem(row.item, currencyCode);
        if (normalized) sectionMap[sectionName].push(normalized);
    }

    // Convert section map to array
    for (const [section, items] of Object.entries(sectionMap)) {
        menu.push({ section, items });
    }

    return {
        "restaurant_id": generateRestaurantId(cleanText(jsonld?.name), address?.postalCode, address?.latitude, address?.longitude),
        "source_id": jsonld['@id'].split("/")[jsonld['@id'].split("/").length - 1] || null,
        "restaurant_url": jsonld['@id'] || null,
        "source": "Uber Eats",
        "lastScrapedAt": new Date().toISOString(),
        "restaurant": {
            name: cleanText(jsonld?.name),
            logo: jsonld?.image || jsonld?.logo || null,
            cuisineList: toArray(jsonld?.servesCuisine),
            ...address,
            phoneNumber: jsonld?.phoneNumber || null,
            ratingAvg: jsonld?.aggregateRating?.ratingValue || null,
            totalReviews: jsonld?.aggregateRating?.reviewCount || null,
            priceBucket: jsonld?.priceRange || null,
            deliveryTime,
        },
        "openingHours": normalizeOpeningHours(jsonld?.openingHoursSpecification),
        "menu": menu, // ✅ unified menu array like AppJSON
    };
}

function extractRestaurantDataFromAppJson(data, url = "N/A", deliveryTime = "N/A", uploadOnS3ForRawState = false) {
    // Basic Info
    if (!data) return null;
    if (uploadOnS3ForRawState) {
        const fileNamePrefix = `${data.slug}_${data.uuid}` || `${Date.now().toString()}`;
        const s3Key = `rawJson/${fileNamePrefix}_Json.json`;
        uploadJson(data, "ubereats", s3Key);
    }
    const source_id = data.uuid || null;   // ✅ Top-level id
    const basicInfo = {
        name: data.title,
        slug: data.slug,
        citySlug: data.citySlug,
        isOrderable: data.isOrderable,
        phoneNumber: normalizer.normalizePhone(data.phoneNumber, data.location?.country?.toUpperCase() || location?.location?.geo?.country?.toUpperCase() || "GB"),
        isWithinDeliveryRange: data.isWithinDeliveryRange
    };

    // Location Info
    const location = normalizeAddress(data.location, null, data);

    // ETA and Rating
    const details = {
        etaRange: data.etaRange?.text || data.etaRange?.accessibilityText,
        ratingAvg: data.rating?.ratingValue,
        totalReviews: data.rating?.reviewCount,
        workingHours: data.storeInfoMetadata?.workingHoursTagline
    };
    const priceBucket = data.priceBucket;

    // Categories + cuisines
    const cuisineList = data.cuisineList || data.categories || [];
    const currencyCode = data.currencyCode;
    // --- Build unified menu structure ---
    const menu = [];
    if (data.catalogSectionsMap) {
        for (const [, sections] of Object.entries(data.catalogSectionsMap)) {
            sections.forEach(section => {
                if (section.payload?.standardItemsPayload?.catalogItems) {
                    const sectionTitle = section.payload.standardItemsPayload.title?.text || "N/A";
                    const items = section.payload.standardItemsPayload.catalogItems
                        .map(item => normalizeMenuItem(item, currencyCode))
                        .filter(Boolean);
                    menu.push({ section: sectionTitle, items });
                }
            });
        }
    }

    // Opening Hours
    const openingHours = data.hours?.map(day => ({
        day: day.dayRange,
        hours: day.sectionHours?.map(sec => ({
            open: formatTime(sec.startTime),
            close: formatTime(sec.endTime),
            section: sec.sectionTitle
        }))
    }));
    return {
        "restaurant_id": generateRestaurantId(cleanText(basicInfo.name), location?.postalCode, location?.latitude, location?.longitude),
        "source_id": source_id,
        "restaurant_url": url,
        "source": "Uber Eats",
        "lastScrapedAt": new Date().toISOString(),
        "restaurant": {
            ...basicInfo,
            ...location,
            ...details,
            deliveryTime,
            cuisineList,
            priceBucket
        },
        "openingHours": openingHours,
        "menu": menu,
    };
}

export function extractUberEatsStore(html, writeJsonLdToFile = false, writeAppJsonToFile = false, deliveryTime = "N/A", url = "N/A", uploadOnS3ForRawState = false) {
    const $ = cheerio.load(html);

    // --- Step 1: Parse JSON-LD ---
    let jsonld = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const raw = $(el).html() || '';
            if (!raw.trim()) return;
            const obj = JSON.parse(raw);
            const list = Array.isArray(obj) ? obj : [obj];
            for (const c of list) {
                const types = toArray(c['@type']);
                if (types.includes('Restaurant')) { jsonld = c; return false; }
            }
        } catch { }
    });

    // --- Step 2: Parse AppJson ---
    let { appJson, regAddress } = collectAppJson($, false, writeAppJsonToFile);
    if (!appJson) {
        const result = collectAppJson($, true, writeAppJsonToFile);
        appJson = result?.appJson || null;
        regAddress = result?.regAddress || null;
    }
    // --- Step 3: Parse AppJson ---
    const appJsonData = extractRestaurantDataFromAppJson(appJson, url !== "N/A" ? url : (jsonld?.['@id'] || "N/A"), deliveryTime, uploadOnS3ForRawState);

    // --- Step 4: Parse JSON-LD ---
    const jsonLdData = extractRestaurantDataFromJsonLd(jsonld, regAddress ? regAddress : {}, deliveryTime, writeJsonLdToFile, uploadOnS3ForRawState);

    // --- Step 5: Merge both sources ---
    return {
        ...(jsonLdData || {}),
        ...(appJsonData || {}),   // AppJson overrides JSON-LD if both present
    };
}
