import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import crypto from "crypto";

import { generateRestaurantId } from "../src/utils/normalization.js";
import { upsertTableBooking } from "../src/utils/dynamo.js";

const BASE_URL = "https://www.quandoo.co.uk";
const START_URL = `${BASE_URL}/london`;
const OUTPUT_FILE = "extract";
const POLITE_DELAY_MS = 1000;

// --- Utility functions ---
function extractPlaceId(url) {
  if (!url) return null;
  const m = url.match(/-([0-9]+)(?:\/|$|[?])/);
  return m ? m[1] : null;
}

function cleanText(text = "") {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const half = trimmed.slice(0, trimmed.length / 2);
  if (trimmed === half + half) return half.trim();
  return trimmed;
}

function normalizeLocation(text = "") {
  let cleaned = cleanText(text);
  cleaned = cleaned.replace(/^Located at\s*/i, "").replace(/\s*area$/i, "").trim();
  return cleaned;
}

function fallbackRestaurantId(name, postalCode) {
  const str = `${name}-${postalCode}`.toLowerCase();
  return crypto.createHash("md5").update(str).digest("hex").slice(0, 12);
}

async function fetchPageHtml(url) {
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Node scraper)" },
  });
  return cheerio.load(data);
}

async function fetchRestaurantDetails(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Node scraper detail)" },
    });
    const $ = cheerio.load(data);
    const jsonLd = $('script[type="application/ld+json"]').html();

    if (jsonLd) {
      const parsed = JSON.parse(jsonLd);
      if (parsed.address) {
        const postalCode = parsed.address.postalCode || "";
        const address = [
          parsed.address.streetAddress,
          parsed.address.addressLocality,
          parsed.address.addressRegion,
          parsed.address.postalCode,
        ]
          .filter(Boolean)
          .join(", ");

        const latitude = parsed.geo?.latitude || null;
        const longitude = parsed.geo?.longitude || null;
        return { postalCode, latitude, longitude, address };
      }
    }
    return { postalCode: "", latitude: null, longitude: null, address: "" };
  } catch (err) {
    console.error(` Failed to fetch details for ${url}: ${err.message}`);
    return { postalCode: "", latitude: null, longitude: null, address: "" };
  }
}

// --- Local JSON helper ---
async function saveRestaurantLocally(restaurantObj) {
  try {
    let existing = [];
    try {
      const data = await fs.readFile(`${OUTPUT_FILE}/restaurant_url_scrape.json`, "utf-8");
      existing = JSON.parse(data);
    } catch {
      // File doesn't exist yet — start new
      existing = [];
    }

    // Prevent duplicates
    const index = existing.findIndex((r) => r.restaurant_id === restaurantObj.restaurant_id);
    if (index !== -1) {
      existing[index] = restaurantObj; // Update existing
    } else {
      existing.push(restaurantObj); // Add new
    }

    await fs.writeFile(`${OUTPUT_FILE}/restaurant_url_scrape.json`, JSON.stringify(existing, null, 2), "utf-8");
    console.log(` Saved locally (${existing.length} total): ${restaurantObj.restaurant_id}`);
  } catch (err) {
    console.error(` Error writing to ${`${OUTPUT_FILE}/restaurant_url_scrape.json`}: ${err.message}`);
  }
}

// --- Main scraper ---
async function scrapeAllRestaurants() {
  let page = 1;
  let lastPageIdsHash = "";
  let repeatedPageCount = 0;

  try {
    while (true) {
      const url = `${START_URL}?page=${page}`;
      console.log(` Scraping page ${page}: ${url}`);

      const $ = await fetchPageHtml(url);
      const cards = $('[data-qa="merchant-card-wrapper"]');
      if (!cards || cards.length === 0) {
        console.log(` No restaurant cards found on page ${page}. Stopping.`);
        break;
      }

      const pageIds = [];

      for (const el of cards) {
        const card = $(el);
        const name = cleanText(card.find('[data-qa="merchant-name"]').text());
        console.log("restaurant_name",name);
        
        const relativeUrl = card.find('a[href^="/place/"]').attr("href");
        console.log("relativeUrl",relativeUrl);
        
        const restaurantUrl = relativeUrl ? `${BASE_URL}${relativeUrl}` : null;

        console.log("restaurantUrl",restaurantUrl);
        
        const placeId = extractPlaceId(relativeUrl) || restaurantUrl;
        pageIds.push(placeId);

        const metaText = cleanText(card.find('[data-qa="merchant-card-cuisine"]').text());
        let cuisine = "";
        let type = "";
        if (metaText.includes("•")) {
          const parts = metaText.split("•").map((p) => cleanText(p));
          cuisine = parts[0] || "";
          type = parts[1] || "";
        } else {
          cuisine = metaText;
        }

        const location = normalizeLocation(card.find('[data-qa="merchant-location"]').text());
        const rating = cleanText(card.find('[data-qa="reviews-score"]').first().text());

        // --- inside the main for loop ---
        const details = await fetchRestaurantDetails(restaurantUrl);
        const { postalCode, latitude, address } = details;

        const cityName = "London";
        let restaurant_id;
        try {
          restaurant_id = generateRestaurantId(name, postalCode, latitude, cityName);
        } catch {
          restaurant_id = fallbackRestaurantId(name, postalCode);
        }

        const restaurantObj = {
          restaurant_id,
          restaurant_name: name,
          quandoo_restaurant_url: restaurantUrl,
          quandoo_cuisine: cuisine,
          quandoo_location: location,
          quandoo_rating: rating,
          quandoo_address: address,
          // city_name: cityName,
          quandoo_updated_at: new Date().toISOString(),
          quandoo_scraped_at: "",
          quandoo_status: "pending"
        };

      console.log(` Found ${cards.length} restaurants on page ${page}`);

      console.log("restaurantObj",restaurantObj);

        // console.log(` ${restaurant_id} | ${name}`);

        // ✅ Save locally
        await saveRestaurantLocally(restaurantObj);

        // await mergeRestaurantInDynamo(restaurantObj);

        // ✅ Save to DynamoDB
        try {
          await upsertTableBooking(restaurantObj);
          console.log(`Saved ${restaurantObj.restaurant_id} in DynamoDB`);
          
        } catch (err) {
          console.error(` DynamoDB upsert failed for ${restaurant_id}: ${err.message}`);
        }

        await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
      }

      console.log(` Page ${page}: ${cards.length} restaurants scraped`);

      const sortedIds = [...new Set(pageIds)].sort();
      const currentPageHash = sortedIds.join("|");

      if (currentPageHash === lastPageIdsHash) {
        repeatedPageCount++;
      } else {
        repeatedPageCount = 0;
      }
      lastPageIdsHash = currentPageHash;

      if (repeatedPageCount >= 2) {
        console.log(" Detected repeated page content — stopping.");
        break;
      }

      // console.log(` Progress saved: ${deduped.length} total restaurants`);

      page++;
      await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    }

    console.log("🎉 Finished scraping all restaurants.");
  } catch (err) {
    console.error(" Scraper error:", err.message);
  }
}

scrapeAllRestaurants();
