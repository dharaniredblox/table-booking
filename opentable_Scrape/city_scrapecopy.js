import puppeteer from "puppeteer";
import fs from "fs";

const BASE_URL = "https://www.opentable.co.uk/metro/london-restaurants";

(async () => {
  console.log("🚀 Launching browser...");
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  console.log("🌆 Opening London restaurants page...");
  await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 0 });

  console.log("⬇️ Auto-scrolling entire page...");
  await autoScroll(page);

  console.log("🔍 Looking for 'Restaurant experiences trending in London'...");
  let viewAllUrl = await findViewAllUrlWithRetry(page, 10);
  if (!viewAllUrl) throw new Error("❌ Could not find 'View all' link!");
  console.log("🔗 Found 'View all' URL:", viewAllUrl);

  console.log("🌐 Navigating to experiences page...");
  await page.goto(viewAllUrl, { waitUntil: "networkidle2", timeout: 0 });

  console.log("⏳ Waiting for 'Experiences trending in London' section...");
  await page.waitForSelector('section[data-testid="Special Menus Trending Now Experiences"]', { timeout: 60000 });

  console.log("⬇️ Scrolling & loading all experiences...");
  await autoScrollWithViewMore(page);

  console.log("🍽️ Scraping experience data...");
  const scrapedData = await page.evaluate(() => {
    const section = document.querySelector('section[data-testid="Special Menus Trending Now Experiences"]');
    if (!section) return null;

    const header = section.querySelector("h2")?.innerText?.trim() || "Unknown Header";

    const cards = section.querySelectorAll("li[data-rid]");
    const data = [];

    cards.forEach(card => {
      const name = card.querySelector("h3")?.innerText?.trim() || "";
      const restaurant_image = card.querySelector("img")?.src || "";
      const spans = Array.from(card.querySelectorAll(".HvyBiVvZWsc- span"));
      const restaurant_name = spans[0]?.innerText?.trim() || "";
      const location = spans[1]?.innerText?.trim() || "";
      const price = spans[2]?.innerText?.trim() || "";

      data.push({ name, restaurant_name, location, price, restaurant_image });
    });

    return { header, data };
  });

  if (!scrapedData) throw new Error("❌ Could not find experiences section!");

  // Include current page URL
  const finalOutput = {
    header: scrapedData.header,
    page_url: viewAllUrl,
    data: scrapedData.data,
  };

  console.log(`✅ Scraped ${scrapedData.data.length} experiences`);
  fs.writeFileSync("restaurant_experiences.json", JSON.stringify(finalOutput, null, 2));
  console.log("💾 Data saved to restaurant_experiences.json");

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
    const headers = Array.from(document.querySelectorAll("h2"));
    for (const h2 of headers) {
      if (h2.textContent.includes("Restaurant experiences trending in London")) {
        const section = h2.closest("section");
        if (section) {
          const link = section.querySelector("a[title='View all'], a[aria-label='View all']");
          return link?.href || null;
        }
      }
    }
    return null;
  });
}

async function autoScrollStep(page) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await new Promise(res => setTimeout(res, 1000));
}

async function autoScrollWithViewMore(page) {
  let lastHeight = await page.evaluate("document.body.scrollHeight");
  let viewMoreClicked = 0;

  while (true) {
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    await new Promise(res => setTimeout(res, 1500));

    const viewMoreBtn = await page.$("button[data-test='experience-grid-view-more']");
    if (viewMoreBtn) {
      console.log("🖱️ Clicking 'View more'...");
      await viewMoreBtn.click();
      viewMoreClicked++;
      await new Promise(res => setTimeout(res, 2000));
    }

    const newHeight = await page.evaluate("document.body.scrollHeight");
    if (newHeight === lastHeight) break;
    lastHeight = newHeight;
  }

  console.log(`🔁 Scrolling finished — 'View more' clicked ${viewMoreClicked} times.`);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
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
