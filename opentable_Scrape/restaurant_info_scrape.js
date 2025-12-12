// main-scraper.js
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  getAllBookingItems,
  updateScrapeStatus,
  BOOKING_TABLE_NAME,
} from "../src/utils/dynamo.js";

// --- ESM-safe __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Load env ---
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const {
  AWS_REGION,
  AWS_BUCKET_NAME,
  S3_BOOKING_FOLDER_PREFIX,
  DYNAMO_BOOKING_TABLE_NAME,
} = process.env;

if (
  !AWS_REGION ||
  !AWS_BUCKET_NAME ||
  !S3_BOOKING_FOLDER_PREFIX ||
  !DYNAMO_BOOKING_TABLE_NAME
) {
  console.error(
    "❌ Missing AWS_REGION, AWS_BUCKET_NAME, S3_BOOKING_FOLDER_PREFIX, or DYNAMO_BOOKING_TABLE_NAME in .env"
  );
  process.exit(1);
}

console.log("DYNAMO_BOOKING_TABLE_NAME", DYNAMO_BOOKING_TABLE_NAME);

// --- AWS S3 client (v3) ---
const s3Client = new S3Client({ region: AWS_REGION });

// --- Directories ---
const RAW_DIR = path.join(__dirname, "extract/raw-html-json");
const CLEANED_DIR = path.join(__dirname, "extract/cleaned-json");
const S3DOWNLOAD_DIR = path.join(__dirname, "extract/s3-scrape");
const MERGED_DIR = path.join(__dirname, "extract/merged");
const DELAY_MS = 2000;
const S3_TARGET_PREFIX = S3_BOOKING_FOLDER_PREFIX.replace(/^\/+|\/+$/g, "");

// --- Helpers ---
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (a) => [...new Set((a || []).filter(Boolean))];

function generateRestaurantId(name, postcode, latitude) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "") // remove spaces & punctuation
    .trim();

  const post = postcode ? postcode.replace(/\s+/g, "") : "unknown";
  const latPrefix = latitude ? String(latitude).split(".")[0].slice(0, 2) : "00";
  return `${slug}_${post}_${latPrefix}`;
}

// utility to convert stream (GetObject.Body) to string
async function streamToString(stream) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

async function checkS3Exists(key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: AWS_BUCKET_NAME, Key: key }));
    return true;
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode ?? err?.statusCode ?? err?.status;
    if (code === 404 || err?.name === "NotFound" || err?.Code === "NotFound") return false;
    throw err;
  }
}

async function downloadExistingJson(resId) {
  const key = `${S3_TARGET_PREFIX}/${resId}.json`;
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: AWS_BUCKET_NAME, Key: key })
    );

    const body = await streamToString(response.Body);
    const parsed = JSON.parse(body);

    await fs.mkdir(S3DOWNLOAD_DIR, { recursive: true });
    const localPath = path.join(S3DOWNLOAD_DIR, `${resId}.json`);
    await fs.writeFile(localPath, JSON.stringify(parsed, null, 2), "utf-8");

    console.log(`⬇️ Downloaded existing S3 file → ${localPath}`);
    return parsed;
  } catch (err) {
    console.warn(`⚠️ Failed to download existing S3 JSON for ${resId}:`, err.message);
    return null;
  }
}

function mergeArrayUnique(a, b) {
  if (!Array.isArray(a)) a = [];
  if (!Array.isArray(b)) b = [];
  return uniq([...a, ...b]);
}

// Merge Combine_details arrays.
// Ensure there is one entry with platform 'opentable' using newData blocks (overrides existing opentable).
function mergeCombineDetails(oldCombine = [], newCombine = [], opentableEntry = null) {
  const result = [];
  const seenPlatforms = new Set();

  // keep old entries except 'opentable' (we will replace with opentableEntry if provided)
  for (const item of oldCombine) {
    const platform = (item.platform || "").toString().toLowerCase();
    if (platform === "opentable") continue;
    result.push(item);
    if (platform) seenPlatforms.add(platform);
  }

  // add any newCombine entries (except opentable) - dedupe by platform
  for (const item of newCombine) {
    const platform = (item.platform || "").toString().toLowerCase();
    if (platform === "opentable") continue;
    if (!seenPlatforms.has(platform)) {
      result.push(item);
      seenPlatforms.add(platform);
    } else {
      // merge if platform exists: shallow merge Reservation_Details and Ratings_and_Reviews
      const idx = result.findIndex(r => (r.platform || "").toString().toLowerCase() === platform);
      if (idx >= 0) {
        result[idx] = {
          ...result[idx],
          Reservation_Details: {
            ...(result[idx].Reservation_Details || {}),
            ...(item.Reservation_Details || {}),
            availableTimes: mergeArrayUnique(result[idx].Reservation_Details?.availableTimes, item.Reservation_Details?.availableTimes),
            openingHours: mergeArrayUnique(result[idx].Reservation_Details?.openingHours, item.Reservation_Details?.openingHours),
          },
          Ratings_and_Reviews: {
            ...(result[idx].Ratings_and_Reviews || {}),
            ...(item.Ratings_and_Reviews || {})
          }
        };
      }
    }
  }

  // finally add opentableEntry (prefer this one) if provided
  if (opentableEntry) {
    result.push(opentableEntry);
  }

  return result;
}

// Basic merge strategy:
// - newData overrides old at top-level
// - merge Venue_Information arrays (images, meals, ambience, amenities)
// - merge Ratings_and_Reviews.reviews deduping by author|date|snippet
// - merge Combine_details by combining old + new and ensuring an 'opentable' platform entry
function mergeRestaurantData(oldData = {}, newData = {}) {
  const mergedVenue = {
    ...(oldData.Venue_Information || {}),
    ...(newData.Venue_Information || {}),
    images: mergeArrayUnique(oldData.Venue_Information?.images, newData.Venue_Information?.images),
    meals: mergeArrayUnique(oldData.Venue_Information?.meals, newData.Venue_Information?.meals),
    ambience: mergeArrayUnique(oldData.Venue_Information?.ambience, newData.Venue_Information?.ambience),
    amenities: mergeArrayUnique(oldData.Venue_Information?.amenities, newData.Venue_Information?.amenities),
  };

  const mergedReservation = {
    ...(oldData.Reservation_Details || {}),
    ...(newData.Reservation_Details || {}),
    openingHours: mergeArrayUnique(oldData.Reservation_Details?.openingHours, newData.Reservation_Details?.openingHours),
    availableTimes: mergeArrayUnique(oldData.Reservation_Details?.availableTimes, newData.Reservation_Details?.availableTimes),
    partySizeOptions: mergeArrayUnique(oldData.Reservation_Details?.partySizeOptions, newData.Reservation_Details?.partySizeOptions),
    seatingAreas: mergeArrayUnique(oldData.Reservation_Details?.seatingAreas, newData.Reservation_Details?.seatingAreas),
  };

  const mergedReviews = (() => {
    const oldReviews = Array.isArray(oldData.Ratings_and_Reviews?.reviews) ? oldData.Ratings_and_Reviews.reviews : [];
    const newReviews = Array.isArray(newData.Ratings_and_Reviews?.reviews) ? newData.Ratings_and_Reviews.reviews : [];
    const combined = [...oldReviews, ...newReviews];
    const seen = new Set();
    const unique = [];
    for (const r of combined) {
      const key = `${r.author || ""}||${r.date || ""}||${(r.snippet || "").slice(0, 100)}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
      }
    }
    return unique;
  })();

  const mergedRatingsBlock = {
    ...(oldData.Ratings_and_Reviews || {}),
    ...(newData.Ratings_and_Reviews || {}),
    reviews: mergedReviews,
    tagsFromReviews: mergeArrayUnique(oldData.Ratings_and_Reviews?.tagsFromReviews, newData.Ratings_and_Reviews?.tagsFromReviews),
  };

  // Build opentable Combine_details entry from newData's Reservation_Details & Ratings_and_Reviews
  const opentableEntry = {
    platform: "opentable",
    Reservation_Details: {
      ...(newData.Reservation_Details || {}),
      openingHours: newData.Reservation_Details?.openingHours || mergedReservation.openingHours || [],
      availableTimes: newData.Reservation_Details?.availableTimes || mergedReservation.availableTimes || [],
      partySizeOptions: newData.Reservation_Details?.partySizeOptions || mergedReservation.partySizeOptions || [],
      seatingAreas: newData.Reservation_Details?.seatingAreas || mergedReservation.seatingAreas || [],
      averageDiningDuration: newData.Reservation_Details?.averageDiningDuration ?? null,
      bookingPolicy: newData.Reservation_Details?.bookingPolicy || "",
      specialExperienceBookings: newData.Reservation_Details?.specialExperienceBookings ?? true,
      integrationWithGoogleReserve: newData.Reservation_Details?.integrationWithGoogleReserve || mergedReservation.integrationWithGoogleReserve || "Not Available"
    },
    Ratings_and_Reviews: {
      ...(newData.Ratings_and_Reviews || {}),
      overallRating: newData.Ratings_and_Reviews?.overallRating ?? mergedRatingsBlock.overallRating,
      totalReviews: newData.Ratings_and_Reviews?.totalReviews ?? mergedRatingsBlock.totalReviews,
      ratingsBreakdown: newData.Ratings_and_Reviews?.ratingsBreakdown || mergedRatingsBlock.ratingsBreakdown || {},
      reviews: mergedRatingsBlock.reviews,
      tagsFromReviews: mergedRatingsBlock.tagsFromReviews
    }
  };

  // Combine_details: start from oldData.Combine_details and newData.Combine_details (if any)
  const oldCombine = Array.isArray(oldData.Combine_details) ? oldData.Combine_details : [];
  const newCombine = Array.isArray(newData.Combine_details) ? newData.Combine_details : [];

  const combinedCombineDetails = mergeCombineDetails(oldCombine, newCombine, opentableEntry);

  const merged = {
    ...oldData,
    ...newData,
    Venue_Information: mergedVenue,
    // keep Reservation_Details and Ratings_and_Reviews inside the combined object (temporary) but we will not upload these top-level blocks
    Reservation_Details: mergedReservation,
    Ratings_and_Reviews: mergedRatingsBlock,
    Combine_details: combinedCombineDetails,
    sources: mergeArrayUnique(oldData.sources, newData.sources),
    lastScrapedAt: new Date().toISOString(),
  };

  return merged;
}

async function fetchBookingData(page, restaurant_url) {
  await page.goto(restaurant_url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await delay(3000);

  try {
    await page.waitForSelector(
      '[data-test="time-slots"], [data-qa="booking-widget"], body',
      { timeout: 15000 }
    );
  } catch {
    // continue - not fatal
  }

  try {
    const possibleSelectors = [
      '[data-qa="widget-guest-amount-dropdown"]',
      'button[aria-label*="people"]',
      'button[aria-label*="guest"]',
      '[data-testid*="guest"]',
      '[data-testid*="party"]',
    ];

    for (const sel of possibleSelectors) {
      const el = await page.$(sel);
      if (el) {
        try {
          await el.click();
        } catch {}
        await delay(1000);
        break;
      }
    }
  } catch (err) {
    console.warn("⚠️ Could not open guest dropdown:", err.message);
  }

  let data = { availableTimes: [], partySizeOptions: [] };
  for (let i = 0; i < 4; i++) {
    data = await page.evaluate(() => {
      const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

      const times = uniq(
        Array.from(
          document.querySelectorAll(
            'ul[data-test="time-slots"] div[role="button"], ul[data-test="time-slots"] li div'
          )
        )
          .map((el) => el.textContent.trim())
          .filter(Boolean)
      );

      let partySizes = [];

      const select = document.querySelector(
        'select[data-test="party-size-picker"]'
      );
      if (select && select.options.length) {
        partySizes = uniq(
          Array.from(select.options).map((o) => o.textContent.trim())
        );
      }

      if (!partySizes.length) {
        partySizes = uniq(
          Array.from(
            document.querySelectorAll(
              '[data-qa="guest-amount-btn"], [data-testid*="guest-amount-btn"], li[role="option"], button[role="option"], [data-testid*="party"]'
            )
          )
            .map((el) => el.textContent.trim())
            .filter(Boolean)
        );
      }

      if (partySizes.length === 1 && /\d+\s*people?/.test(partySizes[0])) {
        const matches = partySizes[0].match(/\d+\s*people?/g);
        if (matches) partySizes = uniq(matches);
      }

      return { availableTimes: times, partySizeOptions: partySizes };
    });

    if (data.availableTimes.length > 0 || data.partySizeOptions.length > 0) break;
    await delay(2000);
  }

  return {
    availableTimes: uniq(data.availableTimes),
    partySizeOptions: uniq(data.partySizeOptions),
  };
}

// Fetch all images from gallery (scroll & collect)
async function fetchAllGalleryImages(page) {
  const imagesSet = new Set();

  try {
    const moreButton = await page.$('button:has(div p)');
    if (moreButton) {
      try { await moreButton.click(); } catch {}
      await delay(1000);
    }

    let previousCount = 0;
    let retries = 0;

    while (retries < 10) {
      const galleryImgs = await page.$$eval(
        'div[data-test="grid-photo"] img',
        (imgs) => imgs.map((img) => img.src).filter(Boolean)
      );
      galleryImgs.forEach((src) => imagesSet.add(src));

      const lastImg = await page.$('div[data-test="grid-photo"]:last-child');
      if (!lastImg) break;

      await page.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "end" }), lastImg);
      await delay(1200);

      if (imagesSet.size === previousCount) retries++;
      else {
        retries = 0;
        previousCount = imagesSet.size;
      }
    }
  } catch (err) {
    console.warn("⚠️ Could not fetch gallery images:", err.message);
  }

  return [...imagesSet];
}

async function scrapeRestaurant(page, restaurantUrl) {
  await page.goto(restaurantUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await delay(2000);
  const html = await page.content();
  const $ = cheerio.load(html);

  // JSON-LD
  let schemaData = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      Array.isArray(json) ? schemaData.push(...json) : schemaData.push(json);
    } catch {}
  });

  const rs = schemaData.find((s) => s["@type"] === "Restaurant") || {};

  // console.log("rsrs....",rs.url,rs.mainEntityOfPage );
  
  let nameRaw = rs.name || $("h1, h2").first().text().trim() || "unknown";

  // FIX: Replace “Ŏ” with “O”
  nameRaw = nameRaw.replace(/Ŏ/g, "O");

  // Decode "&amp;" and remove any trailing " - Location" or " – Location"
  nameRaw = nameRaw
    .replace(/&amp;/g, "&") // decode HTML entities
    .replace(/\s*[-–]\s*[^-–]+$/, "") // take only the part before "-" or "–"
    .trim();

  console.log("nameRaw", nameRaw);

  const addressObj = rs.address || {};
  let address = rs?.address?.streetAddress || "";

  const postcode = addressObj.addressCountry || addressObj.postalCode || "";
  const latitude = rs.geo?.latitude || null;
  const longitude = rs.geo?.longitude || null;

  const resId = generateRestaurantId(nameRaw, postcode, latitude);
  console.log("resId", resId);

  // Save raw locally
  const rawData = {
    restaurant_url: restaurantUrl,
    htmlSnippet: html.substring(0, 500),
    schemaData,
  };
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(path.join(RAW_DIR, `${resId}.html`), html, "utf-8");
  await fs.writeFile(
    path.join(RAW_DIR, `${resId}.json`),
    JSON.stringify(rawData, null, 2),
    "utf-8"
  );

  // fallback address extraction
  if (!address) {
    const locationLink = $('a[href*="https://www.google.com/maps/dir"]').attr(
      "href"
    );
    if (locationLink) {
      try {
        const url = new URL(locationLink);
        const destination = url.searchParams.get("destination");
        if (destination) address = decodeURIComponent(destination);
      } catch {
        address =
          $('span[data-test="restaurant-detail-title"]:contains("Location")')
            .next("div")
            .text()
            .trim() || "";
      }
    }
  }

  const googleMap =
    latitude && longitude
      ? `https://www.google.com/maps/dir//${latitude},${longitude}`
      : $('a[href*="https://www.google.com/maps/dir"]').attr("href") || null;

  // opening hours: try schema then page fallbacks
  let openingHours = [];
  if (Array.isArray(rs.openingHoursSpecification)) {
    openingHours = rs.openingHoursSpecification.map((h) => {
      const days = Array.isArray(h.dayOfWeek)
        ? h.dayOfWeek.join(", ")
        : h.dayOfWeek || "";
      return `${days}: ${h.opens || ""} - ${h.closes || ""}`.trim();
    });
  } else if (Array.isArray(rs.openingHours)) {
    openingHours = rs.openingHours.slice();
  } else if (typeof rs.openingHours === "string") {
    openingHours = rs.openingHours
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  if (!openingHours.length) {
    const possibleHeadings = ["opening hours", "hours", "open now"];
    $("*").each((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      if (possibleHeadings.some((h) => text.includes(h))) {
        const nearby = $(el).parent().find("li, div, tr").slice(0, 7);
        const lines = nearby
          .map((__, s) => $(s).text().trim())
          .get()
          .filter((v) => /\d/.test(v));
        if (lines.length) openingHours = uniq(lines);
      }
    });

    if (!openingHours.length) {
      $("tr").each((_, tr) => {
        const day = $(tr).find("td, th").first().text().trim();
        const time = $(tr).find("td, th").eq(1).text().trim();
        if (day && time && /[a-z]/i.test(day) && /\d/.test(time)) {
          openingHours.push(`${day}: ${time}`);
        }
      });
    }

    if (!openingHours.length) {
      const text = $("body").text();
      const regex =
        /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[^A-Za-z]{1,15}\d{1,2}(:\d{2})?\s?(am|pm)?\s?[-–]\s?\d{1,2}(:\d{2})?\s?(am|pm)?/gi;
      const matches = text.match(regex);
      if (matches) openingHours = uniq(matches.map((m) => m.trim()));
    }
  }

  const grabPills = (headingText) => {
    let vals = [];
    $("h6").each((_, h) => {
      if ($(h).text().trim().toLowerCase() === headingText.toLowerCase()) {
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

  const ambience = grabPills("ambiance") || grabPills("ambience");
  const amenities = grabPills("restaurant amenities");
  const meals = grabPills("Meals") || [];

  // rooms / seating areas
  let rawRooms = [];
  try {
    const privateDining =
      schemaData.find((s) => s.privateDining?.restaurant?.rooms) ||
      schemaData.find((s) => s.privateDining);
    if (privateDining?.privateDining?.restaurant?.rooms)
      rawRooms = privateDining.privateDining.restaurant.rooms;
    else if (rs.rooms) rawRooms = rs.rooms;
  } catch (err) {
    rawRooms = [];
  }

  const seatingAreas = (rawRooms || []).map((room) => ({
    name: room.name || null,
    description: room.description || null,
    seatedSize: room.seatedSize ?? null,
    standingSize: room.standingSize ?? null,
    photo: room.photo?.photoBySize?.xlarge?.url || null,
    minimumCapacity: room.minimumCapacity ?? null,
  }));

  const bookingData = await fetchBookingData(page, restaurantUrl);
  const availableTimes = uniq(bookingData.availableTimes || []);
  const partySizeOptions = uniq(bookingData.partySizeOptions || []);

  let integrationWithGoogleReserve = "Not Available";
  if (rs.potentialAction?.target) integrationWithGoogleReserve = "Available";
  else if ($('button[data-test="experience-reserve-button"]').length > 0)
    integrationWithGoogleReserve = "Available";

  // Ratings
  let overallRating = rs?.aggregateRating?.ratingValue || null;
  const totalReviews = rs?.aggregateRating?.reviewCount || null;
  const ratingsBreakdown = { food: "", service: "", ambience: "", value: "" };
  $('ul[data-test="reviews-ratings-list"] li').each((_, li) => {
    const name = $(li).find('[data-testid="rating-name"]').text().trim();
    const value = $(li).find('[data-testid="rating-value"]').text().trim();
    if (!name || !value) return;
    const lower = name.toLowerCase();
    if (lower.includes("food")) ratingsBreakdown.food = value;
    else if (lower.includes("service")) ratingsBreakdown.service = value;
    else if (lower.includes("ambience")) ratingsBreakdown.ambience = value;
    else if (lower.includes("value")) ratingsBreakdown.value = value;
  });

  if (!overallRating) {
    const sectionText = $("section").text();
    const m = sectionText.match(/(\d\.\d)\s+based on/i);
    if (m) overallRating = m[1];
  }

  let reviews = [];
  $('[data-name="shared-review"]').each((_, r) => {
    const snippet = $(r).find('[data-qa="review-description"]').text().trim();
    const author = $(r).find(".notranslate").text().trim();
    const date = $(r)
      .find('small[data-qa="customer-review-date-and-count"]')
      .text()
      .trim();
    const stars = $(r).find('[data-qa="review-score"]').text().trim();
    const reviewText = snippet ? snippet.toLowerCase() : "";
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
      const snippet = rv.reviewBody || rv.description || null;
      const author = rv.author?.name || null;
      const date = rv.datePublished || null;
      const stars = rv.reviewRating?.ratingValue?.toString() || null;
      const reviewText = snippet ? snippet.toLowerCase() : "";
      const tags = [];
      if (/good for dates/i.test(reviewText)) tags.push("good for dates");
      if (/lively/i.test(reviewText)) tags.push("lively");
      if (/quiet/i.test(reviewText)) tags.push("quiet");
      return { author, date, stars, snippet, tags: tags.length ? tags : null };
    });
  }

  // Images
  const imagesSet = new Set();

  const bannerImg = $('div[data-test="restaurant-banner"] img').attr('src');
  if (bannerImg) imagesSet.add(bannerImg);

  $("img").each((_, el) => {
    const src = $(el).attr("src");
    const dataSrc = $(el).attr("data-src");
    const srcset = $(el).attr("srcset");
    if (src) imagesSet.add(src);
    if (dataSrc) imagesSet.add(dataSrc);
    if (srcset) {
      const candidates = srcset.split(",").map(s => s.trim().split(" ")[0]);
      const largest = candidates[candidates.length - 1];
      if (largest) imagesSet.add(largest);
    }
  });

  const galleryImages = await fetchAllGalleryImages(page);
  galleryImages.forEach(src => imagesSet.add(src));

  const images = [...imagesSet];
  console.log(`🖼 Total images for ${nameRaw}: ${images.length}`);

  const cleaned = {
    restaurantId: resId,
    restaurant_url: restaurantUrl,
    sources: ["Opentable"],
    lastScrapedAt: new Date().toISOString(),
    Venue_Information: {
      restaurantName: nameRaw,
      cuisineType: Array.isArray(rs.servesCuisine) ? rs.servesCuisine.join(", ") : rs.servesCuisine || "",
      address: address || "",
      website: rs.url || rs.mainEntityOfPage || "",
      postcode,
      latitude,
      longitude,
      phone: rs.telephone || "",
      googleMap,
      priceLevel: rs.priceRange || "",
      description: rs.description || "",
      meals,
      ambience,
      amenities,
      images,
    },
    Reservation_Details: {
      openingHours: openingHours || [],
      availableTimes,
      partySizeOptions,
      averageDiningDuration: null,
      seatingAreas,
      bookingPolicy: "",
      specialExperienceBookings: true,
      integrationWithGoogleReserve,
    },
    Ratings_and_Reviews: {
      overallRating: overallRating || null,
      totalReviews: totalReviews || null,
      ratingsBreakdown,
      reviews,
      tagsFromReviews: reviews.map((r) => r.tags).filter(Boolean),
    },
    // scraped Combine_details could be empty by default; keep for merge
    Combine_details: [
      // we'll use this slot to ensure opentable combine entry is considered during merge
      {
        platform: "opentable",
        Reservation_Details: {
          openingHours: openingHours || [],
          availableTimes,
          partySizeOptions,
          averageDiningDuration: null,
          seatingAreas,
          bookingPolicy: "",
          specialExperienceBookings: true,
          integrationWithGoogleReserve,
        },
        Ratings_and_Reviews: {
          overallRating: overallRating || null,
          totalReviews: totalReviews || null,
          ratingsBreakdown,
          reviews,
          tagsFromReviews: reviews.map((r) => r.tags).filter(Boolean),
        }
      }
    ]
  };

  await fs.mkdir(CLEANED_DIR, { recursive: true });
  await fs.writeFile(
    path.join(CLEANED_DIR, `${resId}.json`),
    JSON.stringify(cleaned, null, 2),
    "utf-8"
  );

  console.log(`✅ Scraped & saved locally: ${resId}`);
  return cleaned;
}

async function uploadCleanedJsonToS3(resId, cleanedObject) {
  const key = `${S3_TARGET_PREFIX}/${resId}.json`;
  const body = JSON.stringify(cleanedObject, null, 2);
  const params = {
    Bucket: AWS_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: "application/json",
  };

  try {
    await s3Client.send(new PutObjectCommand(params));
    console.log(`☁️ Uploaded: s3://${AWS_BUCKET_NAME}/${key}`);
    return true;
  } catch (err) {
    console.error(`❌ Upload failed for ${resId}:`, err.message);
    return false;
  }
}

async function main() {
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.mkdir(CLEANED_DIR, { recursive: true });
  await fs.mkdir(S3DOWNLOAD_DIR, { recursive: true });
  await fs.mkdir(MERGED_DIR, { recursive: true });

  console.log("🔍 Fetching restaurant booking items from DynamoDB...");

  // get booking items from booking table (expects attribute restaurant_url)
  const items = await getAllBookingItems(DYNAMO_BOOKING_TABLE_NAME);

  const urls = uniq(items.map((it) => it.opentable_restaurant_url).filter(Boolean));

  console.log("📥 Total items:", items.length);
  console.log("🔗 URLs found:", urls.length);

  if (urls.length === 0) {
    console.log("❌ ERROR: No restaurant_url found in booking table!");
    console.log("🟡 Tip: Ensure upsertTableBooking() stores restaurant_url");
    return;
  }
  console.log(`📋 Found ${urls.length} URLs. Starting scrape...`);
  const browser = await puppeteer.launch({
    headless: false,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  let count = 0;
  for (const url of urls) {
    count++;
    console.log(`\n[${count}/${urls.length}] ${url}`);
    try {
      const cleaned = await scrapeRestaurant(page, url);

      // --- NEW: check S3 and merge if present ---
      const s3Key = `${S3_TARGET_PREFIX}/${cleaned.restaurantId}.json`;
      let finalData = cleaned;

      let existsInS3 = false;
      try {
        existsInS3 = await checkS3Exists(s3Key);
      } catch (err) {
        console.warn(`⚠️ Could not check S3 for ${cleaned.restaurantId}:`, err.message);
      }

      let oldData = null;
      if (existsInS3) {
        console.log(`♻️ Existing S3 entry found for ${cleaned.restaurantId}`);
        oldData = await downloadExistingJson(cleaned.restaurantId);
      }

      if (oldData) {
        finalData = mergeRestaurantData(oldData, cleaned);
      } else {
        // if no old data, ensure Combine_details includes opentable (we added one in cleaned)
        finalData = { ...cleaned };
        if (!Array.isArray(finalData.Combine_details)) {
          finalData.Combine_details = [
            {
              platform: "opentable",
              Reservation_Details: finalData.Reservation_Details || {},
              Ratings_and_Reviews: finalData.Ratings_and_Reviews || {}
            }
          ];
        }
      }

      // Build uploadable object: only keep Venue_Information and Combine_details (and metadata)
      const uploadObj = {
        restaurantId: finalData.restaurantId,
        restaurant_url: finalData.restaurant_url,
        sources: finalData.sources || [],
        lastScrapedAt: finalData.lastScrapedAt || new Date().toISOString(),
        Venue_Information: finalData.Venue_Information || {},
        Combine_details: Array.isArray(finalData.Combine_details) ? finalData.Combine_details : []
      };

      // Save merged local file
      const mergedPath = path.join(MERGED_DIR, `${cleaned.restaurantId}.json`);
      await fs.writeFile(mergedPath, JSON.stringify(uploadObj, null, 2), "utf-8");
      console.log(`🔀 Final upload object saved → ${mergedPath}`);

      const ok = await uploadCleanedJsonToS3(uploadObj.restaurantId, uploadObj);
      if (ok) {
        // update booking table status (restaurant_id used as key)
        try {
          await updateScrapeStatus(uploadObj.restaurantId, "completed");
        } catch (err) {
          console.warn(
            `⚠️ Could not update scrape status for ${uploadObj.restaurantId}:`,
            err.message
          );
        }
      }

      await delay(DELAY_MS);
    } catch (err) {
      console.error(`❌ Failed scraping ${url}:`, err.message);
    }
  }

  await browser.close();
  console.log("🎉 All done!");
}

// --- Run ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
}

export default main;
