import puppeteer from "puppeteer";
import fs from "fs";
import { generateRestaurantId } from "../src/utils/normalize.js";
import { upsertTableBooking } from "../src/utils/dynamo.js";

const BASE_URL = "https://www.opentable.co.uk/metro";
const START_URL = `${BASE_URL}/london-restaurants`;
const OUTPUT_FILE = "extract";
const OUTPUT_PATH = `${OUTPUT_FILE}/url-scrape/restaurant_url.json`;

(async () => {
  console.log("🚀 Launching browser...");
  const browser = await puppeteer.launch({
    headless: "auto",
    defaultViewport: null,
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 2366, height: 768 });

  // ✅ Set User Agent (avoid detection)
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  console.log("🌆 Opening London restaurants page...");
  await page.goto(START_URL, { waitUntil: "networkidle2", timeout: 0 });

  console.log("⬇️ Auto-scrolling entire page...");
  await autoScroll(page);

  console.log("🔍 Looking for 'Restaurant experiences trending in London'...");
  // await page.waitForTimeout(4000);
  await new Promise((r) => setTimeout(r, 4000));

  await autoScroll(page);
  let viewAllUrl = await findViewAllUrlWithRetry(page, 10);

  if (!viewAllUrl) {
    await page.screenshot({
      path: "debug_viewall_section.png",
      fullPage: true,
    });
    throw new Error(
      "❌ Could not find 'View all' link! Check debug_viewall_section.png"
    );
  }

  console.log("🔗 Found 'View all' URL:", viewAllUrl);

  console.log("🌐 Navigating to experiences page...");
  await page.goto(viewAllUrl, { waitUntil: "networkidle2", timeout: 0 });

  console.log("⏳ Waiting for experiences section...");
  await page.waitForSelector("section[data-testid], li[data-rid]", {
    timeout: 60000,
  });

  console.log("⬇️ Scrolling & loading all experiences...");
  await autoScrollWithViewMore(page);

  console.log("🍽️ Scraping experience data...");
  const scrapedData = await page.evaluate(() => {
    const section =
      document.querySelector('section[data-testid*="Trending"]') ||
      document.querySelector('section[data-testid*="Special Menus"]') ||
      document.querySelector("section");

    if (!section) return null;

    const header =
      section.querySelector("h2,h3")?.innerText?.trim() || "Unknown Header";
    const cards = section.querySelectorAll("li[data-rid]");
    const data = [];

    cards.forEach((card) => {
      const name = card.querySelector("h3,h4")?.innerText?.trim() || "";
      const restaurant_image = card.querySelector("img")?.src || "";
      const spans = Array.from(card.querySelectorAll(".HvyBiVvZWsc- span"));
      const restaurant_name = spans[0]?.innerText?.trim() || "";
      const location = spans[1]?.innerText?.trim() || "";
      const price = spans[2]?.innerText?.trim() || "";

      const rid = card.getAttribute("data-rid");
      const restaurant_url = rid
        ? `https://www.opentable.co.uk/restaurant/profile/${rid}`
        : "";

      data.push({
        name,
        restaurant_name,
        location,
        price,
        restaurant_image,
        restaurant_url,
      });
    });

    return { header, data };
  });

  if (!scrapedData) throw new Error("❌ Could not find experiences section!");

  // ✅ Save initial file
  if (!fs.existsSync(OUTPUT_FILE)) fs.mkdirSync(OUTPUT_FILE);
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        header: scrapedData.header,
        page_url: viewAllUrl,
        data: [],
      },
      null,
      2
    )
  );
  console.log(`💾 Initial scraped data saved to ${OUTPUT_PATH}`);

  // ✅ Process each restaurant
  for (const [index, item] of scrapedData.data.entries()) {
    let restPage;
    try {
      restPage = await browser.newPage();
      await restPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      await restPage.goto(item.restaurant_url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      const ldJson = await restPage.evaluate(() => {
        const el = document.querySelector('script[type="application/ld+json"]');
        if (!el) return null;
        try {
          return JSON.parse(el.textContent);
        } catch {
          return null;
        }
      });

      const postcode = ldJson?.address?.addressCountry || "unknown";
      const lat = ldJson?.geo?.latitude || 0;
      const cuisine =
        Array.isArray(ldJson?.servesCuisine) && ldJson.servesCuisine.length
          ? ldJson.servesCuisine.join(", ")
          : ldJson?.servesCuisine || "";
      const rating = ldJson?.aggregateRating?.ratingValue || null;

      const addr = ldJson?.address || {};
      const address = [
        addr.streetAddress,
        addr.addressLocality,
        addr.postalCode,
        addr.addressCountry,
      ]
        .filter(Boolean)
        .join(", ");

      let name = item.restaurant_name || "";

      // Replace Ŏ with O
      name = name.replace(/Ŏ/g, "O");

      // Remove ", London" only
      name = name.replace(/, London/i, "");

      // Remove all commas
      name = name.replace(/,/g, "");

      // Remove non-alphanumeric characters and lowercase
      name = name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

      console.log("🍴 Clean name:", name);

      const restaurant_id = generateRestaurantId(name, postcode, lat);
      console.log("🆔 ID:", restaurant_id);

      const restaurantObj = {
        restaurant_id,
        restaurant_name: name,
        opentable_restaurant_url: item.restaurant_url,
        opentable_cuisine: cuisine,
        opentable_location: item.location,
        opentable_rating: rating,
        opentable_address: address,
        opentable_updated_at: new Date().toISOString(),
        opentable_scraped_at: "", // ✅ set initial scraped timestamp
        opentable_status: "pending",
      };
      console.log("restaurantObj",restaurantObj);
    
      await upsertTableBooking(restaurantObj);
      console.log(`💾 [${index + 1}] Saved ${restaurant_id} to DynamoDB`);

      // ✅ Append to JSON
      const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
      existing.data.push(restaurantObj);
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existing, null, 2));

      console.log(`📁 [${index + 1}] Appended ${restaurant_id} to JSON file`);
    } catch (err) {
      console.warn(
        `⚠️ Failed to enrich ${item.restaurant_name}: ${err.message}`
      );
    } finally {
      if (restPage) await restPage.close();
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  console.log(`✅ Scrape complete! Data saved to ${OUTPUT_PATH}`);
  await browser.close();
})();

/* ---------- HELPERS ---------- */

async function findViewAllUrlWithRetry(page, retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      const url = await getViewAllUrl(page);
      if (url) return url;
    } catch {
      console.log("⚠️ Retry...");
    }
    await autoScrollStep(page);
  }
  return null;
}

async function getViewAllUrl(page) {
  return await page.evaluate(() => {
    const possibleHeaders = [
      "Restaurant experiences trending in London",
      // "Experiences trending now in London",
      // "Restaurant experiences in London",
      // "Special menus in London",
      // "Experiences in London",
      // "Trending restaurants in London",
    ];

    const headers = Array.from(document.querySelectorAll("h2, h3, span"));
    for (const h of headers) {
      const text = h.textContent?.trim()?.toLowerCase();
      if (possibleHeaders.some((hdr) => text.includes(hdr.toLowerCase()))) {
        const section = h.closest("section");
        if (section) {
          const link = section.querySelector(
            "a[title='View all'], a[aria-label='View all'], a[href*='/list/']"
          );
          return link?.href || null;
        }
      }
    }

    // fallback: first "View all" link on the page that looks like a restaurant list
    const fallback = document.querySelector("a[href*='/list/']");
    return fallback?.href || null;
  });
}

async function autoScrollStep(page) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await new Promise((res) => setTimeout(res, 1000));
}

async function autoScrollWithViewMore(page) {
  let lastHeight = await page.evaluate("document.body.scrollHeight");
  let viewMoreClicked = 0;

  while (true) {
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    await new Promise((res) => setTimeout(res, 1500));

    const viewMoreBtn = await page.$(
      "button[data-test='experience-grid-view-more']"
    );
    if (viewMoreBtn) {
      console.log("🖱️ Clicking 'View more'...");
      await viewMoreBtn.click();
      viewMoreClicked++;
      await new Promise((res) => setTimeout(res, 2000));
    }

    const newHeight = await page.evaluate("document.body.scrollHeight");
    if (newHeight === lastHeight) break;
    lastHeight = newHeight;
  }

  console.log(
    `🔁 Scrolling finished — 'View more' clicked ${viewMoreClicked} times.`
  );
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  });
}
