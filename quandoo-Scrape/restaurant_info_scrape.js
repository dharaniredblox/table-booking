import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import puppeteer from "puppeteer";
import axios from "axios";
import * as cheerio from "cheerio";
import AWS from "aws-sdk";
import { updateScrapeStatus } from "../src/utils/dynamo.js";

// ---------- LOAD ENV ----------
dotenv.config({ path: path.resolve("../../.env") });

const {
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  AWS_BUCKET_NAME,
  DYNAMO_BOOKING_TABLE_NAME,
  S3_BOOKING_FOLDER_PREFIX,
} = process.env;

if (
  !AWS_ACCESS_KEY_ID ||
  !AWS_SECRET_ACCESS_KEY ||
  !AWS_REGION ||
  !AWS_BUCKET_NAME ||
  !DYNAMO_BOOKING_TABLE_NAME ||
  !S3_BOOKING_FOLDER_PREFIX
) {
  console.error(
    " Missing AWS credentials, bucket name, table name, or S3 folder prefix in .env"
  );
  process.exit(1);
}

// ---------- AWS CONFIG ----------
AWS.config.update({
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
  region: AWS_REGION,
});

const dynamo = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

// ---------- DIRECTORIES ----------
const OUTPUT_DIR = "extract/raw-html-json";
const CLEANED_DIR = "extract/cleaned-json";
const S3_DOWNLOAD_DIR = "extract/s3download";
const MERGING_DIR = "extract/merging";
const DELAY_MS = 2000;

await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(CLEANED_DIR, { recursive: true });
await fs.mkdir(S3_DOWNLOAD_DIR, { recursive: true });
await fs.mkdir(MERGING_DIR, { recursive: true });

// ---------- HELPERS ----------
const uniq = (a) => [...new Set((a || []).filter(Boolean))];

function buildByType(schemaData) {
  const map = {};
  for (const item of schemaData) {
    if (!item || !item["@type"]) continue;
    const types = Array.isArray(item["@type"])
      ? item["@type"]
      : [item["@type"]];
    for (const t of types) if (!map[t]) map[t] = item;
  }
  return map;
}

function generateRestaurantId(name, postcode, latitude) {
  const safeName = (name || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "");
  const post = postcode ? postcode.replace(/\s+/g, "") : "unknown";
  const latPrefix = latitude
    ? String(latitude).split(".")[0].slice(0, 2)
    : "00";
  return `${safeName}_${post}_${latPrefix}`;
}

async function fetchBookingData(page, restaurant_url) {
  await page.goto(restaurant_url, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 3000));

  const widget = await page.$('[data-qa="booking-widget"]');
  if (!widget) return { availableTimes: [], partySizeOptions: [] };

  const guestDropdown = await page.$(
    '[data-qa="widget-guest-amount-dropdown"]'
  );
  if (guestDropdown) {
    await guestDropdown.click();
    await new Promise((r) => setTimeout(r, 1500));
  }

  return await page.evaluate(() => {
    const times = Array.from(
      document.querySelectorAll('[data-qa^="booking-times-time-value"]')
    ).map((el) => el.textContent.trim());
    const partySizes = Array.from(
      document.querySelectorAll('span[data-qa="guest-amount-btn"]')
    ).map((el) => el.textContent.trim());
    return { availableTimes: times, partySizeOptions: partySizes };
  });
}

async function getRestaurantsFromDynamo() {
  let items = [];
  let lastKey = null;

  do {
    const data = await dynamo
      .scan({
        TableName: DYNAMO_BOOKING_TABLE_NAME,
        ExclusiveStartKey: lastKey,
      })
      .promise();
    items.push(...data.Items);
    lastKey = data.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

// ---------- MERGE LOGIC ----------
function mergeRestaurantData(existing, incoming) {
  const merged = {
    ...existing,
    sources: Array.from(
      new Set([...(existing.sources || []), ...(incoming.sources || [])])
    ),
    Venue_Information:
      existing.Venue_Information || incoming.Venue_Information || {},
    Combine_details: [],
  };

  // Step 1: Map existing platforms
  const platformMap = {};
  (existing.Combine_details || []).forEach((cd) => {
    if (cd.platform) platformMap[cd.platform] = { ...cd };
  });

  // Step 2: Merge incoming platforms
  (incoming.Combine_details || []).forEach((cd) => {
    if (!cd.platform) return;
    if (platformMap[cd.platform]) {
      // Merge reservation details
      platformMap[cd.platform].Reservation_Details = {
        ...platformMap[cd.platform].Reservation_Details,
        ...cd.Reservation_Details,
      };
      // Merge reviews
      const existingReviews =
        platformMap[cd.platform].Ratings_and_Reviews?.reviews || [];
      const incomingReviews = cd.Ratings_and_Reviews?.reviews || [];
      platformMap[cd.platform].Ratings_and_Reviews = {
        ...platformMap[cd.platform].Ratings_and_Reviews,
        ...cd.Ratings_and_Reviews,
        reviews: [...existingReviews, ...incomingReviews],
        tagsFromReviews: Array.from(
          new Set([
            ...(platformMap[
              cd.platform
            ].Ratings_and_Reviews?.tagsFromReviews?.flat() || []),
            ...(cd.Ratings_and_Reviews?.tagsFromReviews?.flat() || []),
          ])
        ),
      };
    } else {
      // If platform is new, add it
      platformMap[cd.platform] = cd;
    }
  });

  // Step 3: Convert back to array
  merged.Combine_details = Object.values(platformMap);

  return merged;
}

async function getExistingS3JSON(filename) {
  try {
    const obj = await s3
      .getObject({
        Bucket: AWS_BUCKET_NAME,
        Key: `${S3_BOOKING_FOLDER_PREFIX}${filename}`,
      })
      .promise();
    return JSON.parse(obj.Body.toString("utf-8"));
  } catch (err) {
    if (err.code === "NoSuchKey") return null;
    console.error(" Error reading existing S3 file:", err);
    return null;
  }
}

async function uploadCleanedJSONToS3(cleanedJSON, filename) {
  const s3Key = `${S3_BOOKING_FOLDER_PREFIX}${filename}`;
  let existing = await getExistingS3JSON(filename);

  let finalJSON = cleanedJSON;

  if (existing) {
    console.log(` Merging S3 JSON with cleaned JSON: ${filename}`);
    finalJSON = mergeRestaurantData(existing, cleanedJSON);
    const mergedPath = path.join(MERGING_DIR, filename);
    await fs.writeFile(mergedPath, JSON.stringify(finalJSON, null, 2), "utf-8");
    console.log(` Saved merged JSON locally → ${mergedPath}`);
  }

  await s3
    .putObject({
      Bucket: AWS_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(finalJSON, null, 2),
    })
    .promise();
  console.log(` Uploaded final JSON to S3: ${filename}`);
}

// ---------- SCRAPER ----------
async function scrapeRestaurantDetails(restaurant, page) {
  // console.log("restaurant.....",restaurant);
  
  try {
    // Fetch HTML
    const { data: html } = await axios.get(restaurant.quandoo_restaurant_url, {
      headers: { "User-Agent": "Mozilla/5.0 (Node scraper)" },
    });

    const $ = cheerio.load(html);

    // JSON-LD Schema
    const schemaData = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const txt = $(el).contents().text();
        const json = JSON.parse(txt);
        Array.isArray(json) ? schemaData.push(...json) : schemaData.push(json);
      } catch {}
    });

    const byType = buildByType(schemaData);
    const rs = byType.Restaurant || {};
    const lb = byType.LocalBusiness || {};
    const fsrv = byType.FoodService || {};

    // console.log("rs",rs);
    
    // Basic Info
    let name =
      $('h1[data-qa="merchant-name"]').text().trim() ||
      rs.name ||
      restaurant.name;

    name = name.split(" - ")[0];

    // name = name.replace(/\s+[A-Z][a-z]+$/, "");
    
    console.log("name",name);


    let cuisines = $(
      '[data-qa="merchant-cuisines"] a, [data-qa="merchant-cuisines"] span'
    )
      .map((_, el) => $(el).text().trim())
      .get();
    if (!cuisines.length && Array.isArray(rs.servesCuisine))
      cuisines = rs.servesCuisine;

    const price =
      rs.priceRange ||
      $('[data-qa="merchant-price-level"]').first().text().trim() ||
      null;
    const phone =
      $('a[data-qa="rdp-merchant-phone-number"]')
        .attr("href")
        ?.replace(/^tel:/, "") ||
      rs.telephone ||
      null;

    const addr = rs.address || lb.address || fsrv.address || {};
    const geo = rs.geo || lb.geo || fsrv.geo || {};
    const streetAddress = addr.streetAddress || null;
    const locality = addr.addressLocality || null;
    const region = addr.addressRegion || null;
    // const postcode = addr.postalCode || null;
    const postcode = addr.postalCode ? addr.postalCode.toUpperCase() : null;

    console.log("postcode",postcode);

    const country =
      typeof addr.addressCountry === "string"
        ? addr.addressCountry
        : addr.addressCountry?.name || null;
    const latitude = geo.latitude || null;
    const longitude = geo.longitude || null;
    const googleMap =
      rs.hasMap || $('iframe[src*="google.com/maps"]').attr("src") || null;

    // Meals
    let meals = $('[data-qa="merchant-meal"] span')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (!meals.length) {
      $("h6").each((_, el) => {
        const heading = $(el).text().trim().toLowerCase();
        if (heading === "meal" || heading === "meals") {
          const spans = $(el)
            .parent()
            .find("span")
            .map((_, s) => $(s).text().trim())
            .get()
            .filter(Boolean);
          if (spans.length) meals = spans;
        }
      });
    }

    // Ambiance & Amenities
    const grabPillsBelow = (headingText) => {
      let vals = [];
      $("h6").each((_, h) => {
        const t = $(h).text().trim().toLowerCase();
        if (t === headingText) {
          vals = $(h)
            .parent()
            .find("a, span, div")
            .map((__, s) => $(s).text().trim())
            .get()
            .filter(Boolean);
        }
      });
      return uniq(vals);
    };
    
    const ambiance = grabPillsBelow("ambiance") || grabPillsBelow("ambience");
    const amenities = grabPillsBelow("restaurant amenities");

    // console.log("ambiance",ambiance);
    // console.log("amenities",amenities);  
    // console.log("meals",meals);
    

    // Description
    const description =
      rs.description ||
      $('[data-qa="merchant-description"]').text().trim() ||
      $('[data-qa="merchant-about"]').text().trim() ||
      null;

    // Ratings
    const agg = rs.aggregateRating || {};
    const overallRating =
      agg.ratingValue ||
      $('[data-qa="reviews-score"]').first().text().trim() ||
      null;
    const totalReviews =
      agg.reviewCount ||
      $('[data-qa="reviews-amount"], [data-qa="reviews-count"]')
        .first()
        .text()
        .trim() ||
      null;

    const ratingsBreakdown = {
      food: null,
      service: null,
      ambience: null,
      value: null,
    };
    const allText = $("div,span,p,li")
      .map((_, e) => $(e).text().trim())
      .get()
      .join("\n");
    const pick = (label) => {
      const m = allText.match(
        new RegExp(`${label}\\s*[:\\-]?\\s*(\\d+(?:\\.\\d+)?)`, "i")
      );
      return m ? m[1] : null;
    };
    ratingsBreakdown.food = pick("food");
    ratingsBreakdown.service = pick("service");
    ratingsBreakdown.ambience = pick("ambience") || pick("ambiance");
    ratingsBreakdown.value = pick("value");

    // Reviews
    let reviews = [];
    $('[data-name="shared-review"]').each((_, r) => {
      const snippet = $(r).find('[data-qa="review-description"]').text().trim();
      const author = $(r).find(".notranslate").text().trim();
      const date = $(r)
        .find('small[data-qa="customer-review-date-and-count"]')
        .text()
        .trim();
      const stars = $(r).find('[data-qa="review-score"]').text().trim();

      const reviewText = snippet.toLowerCase();
      const tags = [];
      if (/good for dates/i.test(reviewText)) tags.push("good for dates");
      if (/lively/i.test(reviewText)) tags.push("lively");
      if (/quiet/i.test(reviewText)) tags.push("quiet");

      if (snippet)
        reviews.push({
          author: author || null,
          date: date || null,
          stars: stars || null,
          snippet,
          tags: tags.length ? tags : null,
        });
    });

    if (!reviews.length && Array.isArray(rs.review)) {
      reviews = rs.review.map((rv) => {
        const snippet = rv.description || null;
        const author = rv.author?.name || null;
        const date = rv.datePublished || null;
        const stars = rv.reviewRating?.ratingValue?.toString() || null;
        const reviewText = snippet ? snippet.toLowerCase() : "";
        const tags = [];
        if (/good for dates/i.test(reviewText)) tags.push("good for dates");
        if (/lively/i.test(reviewText)) tags.push("lively");
        if (/quiet/i.test(reviewText)) tags.push("quiet");
        return {
          author,
          date,
          stars,
          snippet,
          tags: tags.length ? tags : null,
        };
      });
    }

    // Images
    const imagesSet = new Set();
    $('img[data-qa="prospect-illustration"], img').each((_, el) => {
      const src = $(el).attr("src");
      if (src && /(quandoo|cloudfront|imgix)/i.test(src)) imagesSet.add(src);
    });
    if (rs.image) imagesSet.add(rs.image);
    (rs.photo || []).forEach((p) => p?.name && imagesSet.add(p.name));


    const images = [...imagesSet];

    // Booking & Reservation
    let averageDiningDuration = null;
    $("p, span, div").each((_, el) => {
      const match = $(el)
        .text()
        .trim()
        .toLowerCase()
        .match(/\b(\d+)\s*[–-]\s*(\d+)\s*(minutes|min)\b/);
      if (match) {
        averageDiningDuration = `${match[1]}-${match[2]} minutes`;
        return false;
      }
    });

    const seatingAreas = [];
    $("div, span, li").each((_, el) => {
      const text = $(el).text().trim();
      const areaMatch = text.match(/\b(bar|outdoor|window|terrace|patio)\b/i);
      if (areaMatch) {
        const area =
          areaMatch[1].charAt(0).toUpperCase() +
          areaMatch[1].slice(1).toLowerCase();
        const capMatch = text.match(/\((\d+)(?:\s*-\s*(\d+))?\)/);
        const obj = { area };
        if (capMatch) {
          obj.minCapacity = parseInt(capMatch[1], 10);
          obj.maxCapacity = capMatch[2]
            ? parseInt(capMatch[2], 10)
            : obj.minCapacity;
        }
        seatingAreas.push(obj);
      }
    });

    // Remove script and style contents before getting text
    $("script, style, noscript").remove();
    const pageText = $("body").text();
    const cleanText = pageText.replace(
      /window\.translations\s*=\s*\{[\s\S]*?\};?/g,
      ""
    ); // remove inline translation blobs

    // Split and clean lines
    const pageLines = cleanText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    // Keywords to look for
    const policyKeywords = [
      "booking policy",
      "cancellation policy",
      "no-show",
      "cancel",
      "fee",
    ];

    // Search for the policy lines
    let bookingPolicy = null;
    for (let i = 0; i < pageLines.length; i++) {
      const lineLower = pageLines[i].toLowerCase();
      if (policyKeywords.some((k) => lineLower.includes(k))) {
        // Collect a few nearby lines (context)
        const snippet = pageLines.slice(i, i + 4).join(" ");
        // Basic validation: skip if it's still some JS blob
        if (!/window\.translations|aboutPage\.keywords/i.test(snippet)) {
          bookingPolicy = snippet.replace(/\s+/g, " ").trim();
          break;
        }
      }
    }

    // console.log("bookingPolicy:", bookingPolicy);

    const specialExperienceBookings =
      /experience|tasting menu|set menu|event/i.test(pageText) ? true : null;

    // Opening Hours
    let openingHours = [];
    if (Array.isArray(rs.openingHoursSpecification)) {
      openingHours = rs.openingHoursSpecification.map((h) => {
        const days = Array.isArray(h.dayOfWeek)
          ? h.dayOfWeek.join(", ")
          : h.dayOfWeek || "";
        return `${days}: ${h.opens || ""} - ${h.closes || ""}`.trim();
      });
    } else if (Array.isArray(rs.openingHours))
      openingHours = rs.openingHours.slice();

    const bookingDate =
      $('[data-qa="widget-date-picker-selection"]').text().trim() ||
      $('[data-qa="widget-date-picker"] [aria-selected="true"]')
        .text()
        .trim() ||
      null;

    const bookingData = await fetchBookingData(page, restaurant.quandoo_restaurant_url);
    const availableTimes = bookingData.availableTimes;
    const partySizeOptions = bookingData.partySizeOptions;


     // ---------- RAW & CLEANED OUTPUT ----------
    const resId = generateRestaurantId(name, postcode, latitude);

    console.log("resId....",resId);
    
    
    // ---------- CLEANED JSON ----------
    const cleaned = {
      restaurantId: resId,
      restaurant_url: restaurant.quandoo_restaurant_url,
      sources: ["Quandoo"],
      Venue_Information: {
        restaurantName: name,
        cuisineType: cuisines.join(", "),
        address: streetAddress,
        postcode,
        latitude,
        longitude,
        phone,
        googleMap,
        priceLevel: price,
        description,
        images,
      },
      Combine_details: [
        {
          platform: "Quandoo",
          Reservation_Details: {
            openingHours: openingHours.length ? openingHours : null,
            availableTimes,
            averageDiningDuration,
            seatingAreas: seatingAreas.length ? seatingAreas : null,
            partySizeOptions,
            bookingPolicy,
            specialExperienceBookings,
            integrationWithGoogleReserve: rs.potentialAction?.target
              ? "Available"
              : "Not Available",
          },
          Ratings_and_Reviews: {
            overallRating,
            totalReviews,
            ratingsBreakdown,
            reviewSnippets: reviews,
            tagsFromReviews: reviews.map((r) => r.tags).filter(Boolean),
          },
        },
      ],
    };

    const cleanJsonPath = path.join(CLEANED_DIR, `${resId}.json`);
    await fs.writeFile(
      cleanJsonPath,
      JSON.stringify(cleaned, null, 2),
      "utf-8"
    );

    await uploadCleanedJSONToS3(cleaned, `${resId}.json`);

    // ---------- SAVE RAW HTML ----------
    const htmlPath = path.join(OUTPUT_DIR, `${resId}.html`);
    await fs.writeFile(htmlPath, html, "utf-8");

    // ---------- SAVE RAW JSON ----------
    const rawData = {
      restaurant_url: restaurant.quandoo_restaurant_url,
      htmlSnippet: html.substring(0, 500),
      schemaData,
    };
    const rawJsonPath = path.join(OUTPUT_DIR, `${resId}.json`);
    await fs.writeFile(rawJsonPath, JSON.stringify(rawData, null, 2), "utf-8");

    console.log(`Scraped & merged: ${resId}`);
    await updateScrapeStatus(resId, "completed");
    await new Promise((r) => setTimeout(r, DELAY_MS));
  } catch (err) {
    console.error(
      ` Failed scraping ${restaurant.quandoo_restaurant_url}: ${err.message}`
    );
  }
}

// ---------- MAIN ----------
async function main() {
  const all = await getRestaurantsFromDynamo();
  const restaurants = all.filter((r) => r.quandoo_restaurant_url);

  console.log(`Total restaurants in DB: ${all.length}`);
  console.log(`Quandoo restaurants to scrape: ${restaurants.length}`);

  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: null,
    args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--single-process",
  ],
  });
  const page = await browser.newPage();

  for (const restaurant of restaurants) {
    await scrapeRestaurantDetails(restaurant, page);
  }

  await browser.close();
  console.log("🎉 All restaurants scraped and uploaded to S3!");
}

main();
