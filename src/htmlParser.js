import * as cheerio from "cheerio";

/**
 * Extracts restaurant information from the HTML containing all stores
 * @param {string} html - The HTML content to parse
 * @returns {Array<Object>} Array of restaurant objects with extracted data
 */
function restroInfoExtractorFromAllStores(html) {
    const $ = cheerio.load(html);
    const restaurantsMap = new Map(); // Key: `${name}::${cleanUrl}`

    // Helper function to clean URL
    const cleanUrl = (url) => {
        if (!url) return '';
        // Remove everything after ?diningMode=
        return url.split('?diningMode=')[0];
    };

    $('[data-testid="store-card"]').each((index, element) => {
        const $card = $(element);
        const name = $card.find('h3').text().trim();
        if (!name) return;

        // Extract and clean URL
        const rawUrl = $card.find('a[data-testid="store-card"]').attr('href') || '';
        const cleanedUrl = cleanUrl(rawUrl);

        console.log("cleanedUrl",cleanedUrl);
        
        const mapKey = `${name}::${cleanedUrl}`;

        // Skip if we already have this restaurant with data
        if (restaurantsMap.has(mapKey)) {
            return;
        }

        // Extract other data
        const ratingElement = $card.find('span[title]').first();
        const rating = ratingElement.attr('title') || '';

        // Only add if we have rating data
        if (rating) {
            const reviewCountElement = ratingElement.nextAll('span[title]').first();
            const reviewCount = reviewCountElement.attr('title') || '';
            const deliveryTime = $card.find('span.m6').last().text().trim();

            const offers = [];
            $card.find('[data-baseweb="tag"]').each((i, el) => {
                offers.push($(el).text().trim());
            });

            restaurantsMap.set(mapKey, {
                name,
                rating,
                reviewCount,
                deliveryTime,
                offers: offers.length ? offers : undefined,
                url: cleanedUrl ? `https://www.ubereats.com${cleanedUrl}` : ''
            });
        }
    });

    return Array.from(restaurantsMap.values());
}

export {
    restroInfoExtractorFromAllStores
};
