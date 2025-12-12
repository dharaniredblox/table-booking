import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import puppeteer from "puppeteer";
import axios from "axios";
import * as cheerio from "cheerio";
// ---------- DIRECTORIES ----------

const RAW_DIR = "extract/raw-html-json";
const CLEANED_DIR = "extract/cleaned-json";
const DELAY_MS = 2000;

// -----------------------------
// Helper functions
// -----------------------------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uniq = (a) => [...new Set((a || []).filter(Boolean))];

// -----------------------------
// Generate res_id
// -----------------------------

function generateRestaurantId(name, postcode, latitude) {
  const safeName = (name || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "");
  const post = postcode ? postcode.replace(/\s+/g, "") : "unknown";
  const latPrefix = latitude
    ? String(latitude).split(".")[0].slice(0, 2)
    : "00";
  return `${safeName}_${post}_${latPrefix}`;
}

async function safeGoto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      return;
    } catch (err) {
      console.warn(`⚠️ Failed to load ${url}, retrying... (${i + 1})`);
      await delay(2000);
    }
  }
  throw new Error(`Failed to load ${url} after ${retries} attempts`);
}

async function fetchBookingData(page, restaurant_url) {
  await page.goto(restaurant_url, { waitUntil: "domcontentloaded" });
  await delay(4000);

  // Wait for widget or fallback
  try {
    await page.waitForSelector(
      '[data-test="time-slots"], [data-qa="booking-widget"], body',
      { timeout: 30000 }
    );
  } catch {
    console.warn("⚠️ Booking widget not found initially");
  }

  // Try to open guest dropdown (safe selectors only)
  try {
    const possibleSelectors = [
      '[data-qa="widget-guest-amount-dropdown"]',
      'button[aria-label*="people"]',
      'button[aria-label*="guest"]',
      '[data-testid*="guest"]',
      '[data-testid*="party"]',
      "button:has(span)",
    ];

    let guestButton = null;
    for (const sel of possibleSelectors) {
      guestButton = await page.$(sel);
      if (guestButton) break;
    }

    if (guestButton) {
      await guestButton.click().catch(() => {});
      await delay(1500);
    }
  } catch (err) {
    console.warn("⚠️ Could not open guest dropdown:", err.message);
  }

  // Optional: click “Find a table” if exists, to trigger available times
  try {
    const findBtn = await page.$('button:has-text("Find a table")');
    if (findBtn) {
      await findBtn.click();
      await delay(3000);
    }
  } catch {}

  // Retry a few times if times aren’t yet loaded
  let data = { availableTimes: [], partySizeOptions: [] };
  for (let i = 0; i < 4; i++) {
    data = await page.evaluate(() => {
      const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

      // Grab available times
      const times = uniq(
        Array.from(
          document.querySelectorAll(
            'ul[data-test="time-slots"] div[role="button"], ul[data-test="time-slots"] li div'
          )
        )
          .map((el) => el.textContent.trim())
          .filter(Boolean)
      );

      // Grab party sizes
      let partySizes = [];

      // Try <select>
      const select = document.querySelector(
        'select[data-test="party-size-picker"]'
      );
      if (select && select.options.length) {
        partySizes = uniq(
          Array.from(select.options).map((o) => o.textContent.trim())
        );
      }

      // Try <li> or <button> options
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

      // Fallback: regex split “1 person2 people...”
      if (partySizes.length === 1 && /\d+\s*people?/.test(partySizes[0])) {
        const matches = partySizes[0].match(/\d+\s*people?/g);
        if (matches) partySizes = uniq(matches);
      }

      return { availableTimes: times, partySizeOptions: partySizes };
    });

    if (data.availableTimes.length > 0 || data.partySizeOptions.length > 0)
      break;
    await delay(2000);
  }

  // Deduplicate and clean final results
  const availableTimes = uniq(data.availableTimes);
  const partySizeOptions = uniq(data.partySizeOptions);

  return { availableTimes, partySizeOptions };
}

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


async function fetchAllImages(page, $) {
  const imagesSet = new Set();

  // ⏱ Increase timeout limit globally for this page (5 minutes)
  await page.setDefaultTimeout(300000); 

  const bannerImg = $('div[data-test="restaurant-banner"] img').attr("src");
  if (bannerImg) imagesSet.add(bannerImg);

  $("img").each((_, el) => {
    const src = $(el).attr("src");
    const dataSrc = $(el).attr("data-src");
    const srcset = $(el).attr("srcset");
    if (src) imagesSet.add(src);
    if (dataSrc) imagesSet.add(dataSrc);
    if (srcset) {
      const candidates = srcset.split(",").map((s) => s.trim().split(" ")[0]);
      const largest = candidates[candidates.length - 1];
      if (largest) imagesSet.add(largest);
    }
  });

  try {
    const moreButton = await page.$("button:has(div p)");
    if (moreButton) {
      await moreButton.click();
      await delay(1500);
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

      await page.evaluate(
        (el) => el.scrollIntoView({ behavior: "smooth", block: "end" }),
        lastImg
      );
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

// -----------------------------
// Scrape a single restaurant
// -----------------------------
async function scrapeRestaurant(page, restaurantUrl) {
  await safeGoto(page, restaurantUrl);
  await delay(2000);

  const html = await page.content();
  const $ = cheerio.load(html);

  // -----------------------------
  // Parse JSON-LD
  // -----------------------------
  let schemaData = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      Array.isArray(json) ? schemaData.push(...json) : schemaData.push(json);
    } catch {}
  });

  const byType = buildByType(schemaData);
  const rs = byType.Restaurant || {};

  const lb = byType.LocalBusiness || {};
  const fsrv = byType.FoodService || {};
  const restaurantSchema =
    schemaData.find((s) => s["@type"] === "Restaurant") ||
    rs ||
    lb ||
    fsrv ||
    {};

  const nameRaw =
    restaurantSchema?.name || $("h1, h2").first().text().trim() || "unknown";


  // -----------------------------
  // Save RAW data
  // -----------------------------
  const rawData = {
    restaurant_url: restaurantUrl,
    htmlSnippet: html.substring(0, 500),
    schemaData,
  };

  // await fs.writeFile(
  //   path.join(RAW_DIR, `${resId}.json`),
  //   JSON.stringify(rawData, null, 2),
  //   "utf-8"
  // );

  // await fs.writeFile(path.join(RAW_DIR, `${resId}.html`), html, "utf-8");

  // -----------------------------
  // Cleaned JSON
  // -----------------------------
  let address = restaurantSchema?.address?.streetAddress || "";
  let postcode =
  restaurantSchema?.address?.addressCountry ||
  restaurantSchema?.address?.postalCode ||
    "";
  const phone = restaurantSchema?.telephone || "";
  const latitude = restaurantSchema?.geo?.latitude || null;
  const longitude = restaurantSchema?.geo?.longitude || null;

  // Fallback for missing address
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
        address = $(
          'span[data-test="restaurant-detail-title"]:contains("Location")'
        )
          .next("div")
          .text()
          .trim();
      }
    }
  }

  // Google Maps fallback
  const googleMap =
    latitude && longitude
      ? `https://www.google.com/maps/dir//${latitude},${longitude}`
      : $('a[href*="https://www.google.com/maps/dir"]').attr("href") || null;

  const description = restaurantSchema?.description || "";
  const cuisineType = Array.isArray(restaurantSchema?.servesCuisine)
    ? restaurantSchema.servesCuisine.join(", ")
    : restaurantSchema?.servesCuisine || "";

  const priceLevel = restaurantSchema?.priceRange || "";

  // -----------------------------
  // Opening Hours (schema + HTML)
  // -----------------------------
  let openingHours = [];

  // From JSON-LD schema
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

  // Fallback: visible text on page (only if still empty)
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

  // -----------------------------
  // pills (ambience, amenities, meals, seating)
  // -----------------------------
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
  // Extract seating areas

  // -----------------------------
  // Seating Areas (Private Dining Rooms)
  // -----------------------------
  let rawRooms = [];

  try {
    // Try to find private dining info in the full schemaData
    const privateDining =
      schemaData.find((s) => s.privateDining?.restaurant?.rooms) ||
      schemaData.find((s) => s.privateDining);

    if (privateDining?.privateDining?.restaurant?.rooms) {
      rawRooms = privateDining.privateDining.restaurant.rooms;
    } else if (rs.rooms) {
      rawRooms = rs.rooms;
    }
  } catch (err) {
    console.warn("⚠️ Could not extract rooms:", err.message);
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

  console.log("seatingAreas", seatingAreas);

  const bookingData = await fetchBookingData(page, restaurantUrl);
  const availableTimes = uniq(bookingData.availableTimes || []);
  const partySizeOptions = uniq(bookingData.partySizeOptions || []);

  const images = await fetchAllImages(page, $);

  const imageCount = images.length;

  console.log(`🖼️ Found ${imageCount} image(s) for ${nameRaw}`);


  // -----------------------------
  // Ratings extraction
  // -----------------------------
  // Primary: schema.org
  let overallRating = restaurantSchema?.aggregateRating?.ratingValue || null;
  const totalReviews = restaurantSchema?.aggregateRating?.reviewCount || null;

  // Ratings breakdown default
  const ratingsBreakdown = {
    food: "",
    service: "",
    ambience: "",
    value: "",
  };

  // If there's an HTML ratings list, parse it
  $('ul[data-test="reviews-ratings-list"] li').each((_, li) => {
    const name = $(li).find('[data-testid="rating-name"]').text().trim();
    const value = $(li).find('[data-testid="rating-value"]').text().trim();
    if (!name || !value) return;
    const lower = name.toLowerCase();
    if (lower.includes("food")) ratingsBreakdown.food = value;
    else if (lower.includes("service")) ratingsBreakdown.service = value;
    else if (lower.includes("ambience") || lower.includes("ambience"))
      ratingsBreakdown.ambience = value;
    else if (lower.includes("value")) ratingsBreakdown.value = value;
  });

  // Overall rating fallback from visible text (e.g., "4.6 based on recent ratings")
  if (!overallRating) {
    const sectionText = $("section").text();
    const m = sectionText.match(/(\d\.\d)\s+based on/i);
    if (m) overallRating = m[1];
  }

  // Another fallback: pick first element that looks like a numeric rating near the ratings list
  if (!overallRating) {
    const near = $('ul[data-test="reviews-ratings-list"]').prev().text().trim();
    const m2 = near.match(/(\d\.\d)/);
    if (m2) overallRating = m2[1];
  }

  // -----------------------------
  // Reviews (same as before)
  // -----------------------------
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
      const snippet = rv.reviewBody || null;

      // console.log("snippet",snippet);

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

  // Detect Reserve integration (schema + HTML fallback)
  let integrationWithGoogleReserve = "Not Available";

  if (rs.potentialAction?.target) {
    integrationWithGoogleReserve = "Available";
  } else {
    const reserveBtn =
      $('button[data-test="experience-reserve-button"]').length > 0;
    if (reserveBtn) integrationWithGoogleReserve = "Available";
  }

  console.log("integrationWithGoogleReserve", integrationWithGoogleReserve);


  const resId = generateRestaurantId(nameRaw,postcode,latitude);

  console.log("resIdresId",resId);
  
  const cleaned = {
    restaurantId: resId,
    restaurant_url: restaurantUrl,
    Venue_Information: {
      restaurantName: nameRaw,
      cuisineType,
      address,
      postcode,
      phone,
      googleMap,
      priceLevel,
      meals,
      ambience,
      amenities,
      description,
      latitude,
      longitude,
      images,
    },
    Reservation_Details: {
      openingHours,
      availableTimes,
      averageDiningDuration: null,
      seatingAreas,
      partySizeOptions,
      bookingPolicy: "",
      specialExperienceBookings: true,
      // integrationWithGoogleReserve: "Available",
      integrationWithGoogleReserve,
    },
    Ratings_and_Reviews: {
      overallRating,
      totalReviews,
      ratingsBreakdown,
      reviews,
      tagsFromReviews: [],
    },
  };

  await fs.writeFile(
    path.join(RAW_DIR, `${resId}.json`),
    JSON.stringify(rawData, null, 2),
    "utf-8"
  );

  await fs.writeFile(path.join(RAW_DIR, `${resId}.html`), html, "utf-8");

  try {
    const cleanedPath = path.join(CLEANED_DIR, `${resId}.json`);
    await fs.writeFile(cleanedPath, JSON.stringify(cleaned, null, 2), "utf-8");
    console.log(`✅ Saved cleaned JSON: ${cleanedPath}`);
  } catch (err) {
    console.error("❌ Failed to save cleaned JSON:", err.message);
  }

  console.log(`✅ Scraped & saved: ${nameRaw}`);
  await delay(DELAY_MS);
}

// -----------------------------
// MAIN
// -----------------------------
async function main() {
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.mkdir(CLEANED_DIR, { recursive: true });

  const restaurantsDataRaw = JSON.parse(
    await fs.readFile("restaurant_experiences.json", "utf-8")
  );
  const restaurantsData = Array.isArray(restaurantsDataRaw)
    ? restaurantsDataRaw
    : restaurantsDataRaw.data;

  if (!restaurantsData || !restaurantsData.length) {
    console.error("❌ No restaurants found in JSON");
    return;
  }

  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" });

  for (const rest of restaurantsData) {
    if (!rest.restaurant_url) {
      console.warn("⚠️ Missing URL in:", rest);
      continue;
    }
    try {
      await scrapeRestaurant(page, rest.restaurant_url);
    } catch (err) {
      console.error(`❌ Failed ${rest.restaurant_url}: ${err.message}`);
    }
  }

  await browser.close();
  console.log("🎉 All restaurants scraped!");
}

main();
