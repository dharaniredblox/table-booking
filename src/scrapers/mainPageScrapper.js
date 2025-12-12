import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from "fs";
import path from "path";
import { saveElementHtml } from '../utils/file-handler.js';

// This is doneconst URL = "https://www.ubereats.com/feed?diningMode=DELIVERY&pl=JTdCJTIyYWRkcmVzcyUyMiUzQSUyMlVCMSUyMDFTUSUyMiUyQyUyMnJlZmVyZW5jZSUyMiUzQSUyMkNoSUpzUXMxdDZ4eWRrZ1JzMmNtdGJDX0RBayUyMiUyQyUyMnJlZmVyZW5jZVR5cGUlMjIlM0ElMjJnb29nbGVfcGxhY2VzJTIyJTJDJTIybGF0aXR1ZGUlMjIlM0E1MS41MDgwODgzJTJDJTIybG9uZ2l0dWRlJTIyJTNBLTAuMzc3NDY4MyU3RA%3D%3D"
const URL = "https://www.ubereats.com/feed?diningMode=DELIVERY&pl=JTdCJTIyYWRkcmVzcyUyMiUzQSUyMkRBMTclMjA2QVglMjIlMkMlMjJyZWZlcmVuY2UlMjIlM0ElMjJDaElKbVNqS0NKV3YyRWNSenBXS0t6UjJjZEklMjIlMkMlMjJyZWZlcmVuY2VUeXBlJTIyJTNBJTIyZ29vZ2xlX3BsYWNlcyUyMiUyQyUyMmxhdGl0dWRlJTIyJTNBNTEuNDk2MDg0NyUyQyUyMmxvbmdpdHVkZSUyMiUzQTAuMTYxOTM4NiU3RA%3D%3D&ps=1"
/* ----------------------------- Utilities ----------------------------- */

const logStep = (msg) => console.log(`🔎 ${msg}`);
const logData = (label, data, sample = 3) => {
  console.log(`📦 ${label}: count=${Array.isArray(data) ? data.length : 0}`);
  if (Array.isArray(data) && data.length) {
    console.log(`   └─ sample:`, data.slice(0, sample));
  }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Scroll until no growth (max passes as safety). */
async function autoScroll(page, { maxPasses = 12, pauseMs = 600 } = {}) {
  logStep("Auto-scrolling to load lazy content…");
  let lastHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let i = 0; i < maxPasses; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.1));
    await sleep(pauseMs);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight <= lastHeight) break;
    lastHeight = newHeight;
  }
}



/**
 * Get the Nth child of an element optionally filtered by className.
 * If className is given, finds children with that class and picks the nth.
 * Otherwise just returns nth child in DOM order.
 *
 * @param {ElementHandle} handle Puppeteer element handle
 * @param {number} n Index of child (1-based)
 * @param {string|null} className Optional class filter
 * @param {boolean} debug Print debug logs
 */
async function getNthChild(handle, n, className = null, debug = false) {
  return await handle.evaluateHandle(
    (el, { idx, cls, dbg }) => {
      const children = Array.from(el.children);
      if (dbg) {
        console.log("Children of", el.className || el.tagName, "=",
          children.map((c, i) => ({
            index: i + 1,
            tag: c.tagName,
            class: c.className
          }))
        );
      }
      const matching = cls
        ? children.filter(c => c.className.includes(cls))
        : children;

      return matching[idx - 1] || null;
    },
    { idx: n, cls: className, dbg: debug }
  );
}



/** Find a descendant by text (case-insensitive). Returns first matching element handle or null. */
async function findDescByText(rootHandle, selector, targetText) {
  const handle = await rootHandle.evaluateHandle(
    (root, sel, txt) => {
      const t = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const target = t(txt);
      const nodes = root.querySelectorAll(sel);
      for (const el of nodes) {
        if (t(el.textContent || "") === target) return el;
      }
      return null;
    },
    selector,
    targetText
  );
  const asEl = handle.asElement();
  if (!asEl) {
    try {
      await handle.dispose();
    } catch { }
    return null;
  }
  return asEl;
}

/** Robust text extractor for one store card element (runs in the page). */
function cardExtractorInPage(card) {
  const txt = (el) => (el ? el.textContent.trim() : null);
  const q = (sel) => card.querySelector(sel);

  // Name: try headings or aria-label on links
  let name =
    txt(q("h3")) ||
    txt(q("h4")) ||
    (q("a[aria-label]") ? q("a[aria-label]").getAttribute("aria-label") : null);

  // Link
  let link = q("a[href*='/store/']")?.href || null;

  // Image
  let image =
    q("picture img")?.src ||
    q("img")?.src ||
    (q("img") ? q("img").getAttribute("src") : null);

  // Collect all leaf text nodes to pattern-match fields
  const allText = (card.innerText || "").replace(/\s+/g, " ").trim();

  // Rating: look for e.g., "4.6", "4.6 ★", etc.
  let rating = null;
  const mRating = allText.match(/(\d\.\d)\s*★?|\s★\s*(\d\.\d)/);
  if (mRating) rating = mRating[1] || mRating[2] || null;

  // ETA: "10–20 min", "15-25 min", "10 min"
  let deliveryTime = null;
  const mEta = allText.match(/(\d+\s*[–-]\s*\d+\s*min|\d+\s*min)/i);
  if (mEta) deliveryTime = mEta[1];

  // Price tier: "£", "££", "£££"
  let priceInfo = null;
  const mPrice = allText.match(/£{1,4}/);
  if (mPrice) priceInfo = mPrice[0];

  // Cuisine: heuristic — take the first line after name that isn’t eta/price/rating
  let cuisine = null;
  // Often cuisines are in small text elements near the name
  const sub =
    txt(q("p")) ||
    txt(q("[data-testid*='subtitle']")) ||
    txt(q("div[role='text']")) ||
    null;
  if (sub) {
    // Remove tokens that are clearly ETA or price
    const tokens = sub
      .split(/•|·|\||,/)
      .map((s) => s.trim())
      .filter(
        (s) =>
          s &&
          !/\bmin\b/i.test(s) &&
          !/£/.test(s) &&
          !/^\d+(\.\d+)?$/.test(s) &&
          !/star|rating/i.test(s)
      );
    if (tokens.length) cuisine = tokens.join(" • ");
  }

  // Offer (optional)
  let offer = null;
  const offerNode = Array.from(card.querySelectorAll("div, span"))
    .map((e) => e.textContent.trim())
    .find((t) => /free item|off|discount|deal|save/i.test(t));
  if (offerNode) offer = offerNode;

  return { name, cuisine, rating, deliveryTime, priceInfo, offer, link, image };
}

/* ------------ Network capture + simple JSON extractor helpers ------------ */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function setupNetworkCapture(page, {
  dir = "netlogs",
  urlMatch = /ubereats|eats|api|getfeed|store|search|list/i
} = {}) {
  ensureDir(dir);
  const client = await page.target().createCDPSession();
  await client.send("Network.enable");
  const captured = [];

  client.on("Network.responseReceived", async (evt) => {
    const { response, requestId, type } = evt;
    const url = response.url || "";
    const ct = String(response.headers?.["content-type"] || "").toLowerCase();
    const isJson = ct.includes("application/json");

    if ((type === "XHR" || type === "Fetch") && isJson && urlMatch.test(url)) {
      try {
        const { body, base64Encoded } = await client.send("Network.getResponseBody", { requestId });
        const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
        let json = null;
        try { json = JSON.parse(text); } catch { }
        captured.push({ url, json, text });
      } catch {
        /* ignore */
      }
    }
  });

  return { client, captured, dir };
}

/** Save every captured JSON to disk for inspection */
function dumpCapturedJson(captured, dir = "netlogs") {
  ensureDir(dir);
  captured.forEach((c, i) => {
    if (c.json) {
      fs.writeFileSync(`${dir}/${String(i).padStart(2, "0")}.json`, JSON.stringify(c.json, null, 2));
    } else {
      fs.writeFileSync(`${dir}/${String(i).padStart(2, "0")}.txt`, c.text || "", "utf-8");
    }
  });
  console.log(`🛰️ Saved ${captured.length} captured responses → ${dir}/`);
}

/** Heuristic: walk JSON and pull out objects that look like store cards */
function extractStoresFromCaptured(captured) {
  const out = [];

  const looksLikeStore = (o) => {
    if (!o || typeof o !== "object") return false;
    const keys = Object.keys(o).map(k => k.toLowerCase());
    const keyStr = keys.join("|");
    const hasName = "name" in o || "title" in o || "storeName" in o || "restaurantName" in o;
    const hasEta = "eta" in o || "etaRange" in o || keyStr.includes("eta");
    const hasImg = "imageUrl" in o || (o.image && (o.image.url || o.image.src)) || "logoUrl" in o;
    const hasRating = "rating" in o || "averageRating" in o || keyStr.includes("rating");
    const maybeUuid = keyStr.includes("uuid") || keyStr.includes("storeuuid") || keyStr.includes("merchantuuid");
    return hasName && (hasEta || hasImg || hasRating || maybeUuid);
  };

  const mapStore = (o) => {
    const name = o.name || o.title || o.storeName || o.restaurantName || null;

    const rating =
      o.rating?.value || o.rating || o.averageRating || null;

    const deliveryTime =
      o.eta ||
      (o.etaRange ? `${o.etaRange.min}-${o.etaRange.max} min` : null) ||
      (o.deliveryTime ? `${o.deliveryTime} min` : null);

    const priceInfo =
      o.price || o.priceRating || o.priceTier || null;

    const image =
      o.imageUrl ||
      o.logoUrl ||
      (o.image && (o.image.url || o.image.src)) ||
      null;

    const slug =
      o.slug || o.storeSlug || o.restaurantSlug || null;

    const link =
      o.storeUrl ||
      o.storefrontUrl ||
      (o.action && (o.action.link || o.action.url)) ||
      (slug ? `https://www.ubereats.com/store/${slug}` : null);

    const cuisine =
      (Array.isArray(o.cuisines) && o.cuisines.join(" • ")) ||
      o.cuisine ||
      null;

    return { name, cuisine, rating, deliveryTime, priceInfo, link, image };
  };

  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      // If it's an array of objects that look like stores, map them
      if (node.length && typeof node[0] === "object" && node.some(looksLikeStore)) {
        node.filter(looksLikeStore).forEach((o) => out.push(mapStore(o)));
      }
      node.forEach(walk);
    } else {
      Object.values(node).forEach(walk);
    }
  };

  for (const c of captured) {
    if (c.json) walk(c.json);
  }

  // Deduplicate by name+link
  const seen = new Set();
  return out.filter(s => {
    const key = `${s.name}::${s.link || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !!s.name;
  });
}

/* ------------------------------ Scraper ------------------------------ */

export class UberEatsScraper {
  constructor(url, { saveNet = false, downloadOnly = false, postalCode = "N/A", outputDir = "./data/rawHtml" }) {
    this.url = url;
    this.browser = null;
    this.page = null;
    this.saveNet = saveNet;
    this.postalCode = postalCode !== "N/A" ? postalCode : `${Date.now().toString()}_POSTALCODE_N/A`;
    this.downloadOnly = downloadOnly;
    this.outputDir = outputDir;
  }

  async init() {
    puppeteer.use(StealthPlugin());
    this.browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
      defaultViewport: {
        width: 2560,
        height: 1600,
        deviceScaleFactor: 1,       // 100% scaling
        isMobile: false,
        hasTouch: false
      }
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({
      width: 2560,
      height: 1600,
      deviceScaleFactor: 1
    });
    // ✅ add this line
    if (this.saveNet) {
      this.net = await setupNetworkCapture(this.page, { dir: "netlogs" });
    }
    // ✅ Enable request interception BEFORE navigation
    await this.page.setRequestInterception(true);

    // ✅ Block ads/analytics
    this.page.on("request", (req) => {
      const url = req.url();
      if (
        url.includes("google") ||
        url.includes("doubleclick") ||
        url.includes("tiktok") ||
        url.includes("criteo")
      ) {
        req.abort(); // block ads/analytics
      } else {
        req.continue();
      }
    });

    // ✅ Forward page console logs to Node
    // this.page.on("console", (msg) => {
    //   if (!msg.text().includes("Refused")) {
    //     console.log("🖥️  PAGE:", msg.text());
    //   }
    // });

    logStep("Navigating to page…");
    await this.page.goto(this.url, { waitUntil: "networkidle2", timeout: 0 });

    // Wait for main skeleton
    await this.page.waitForSelector("main#main-content", { timeout: 30000 });
    logStep("Main content detected.");

    // Let initial content settle
    await sleep(5000);

    // Load more content
    await autoScroll(this.page);
    if (this.downloadOnly) {
      const html = await this.page.content();
      ensureDir(this.outputDir);
      console.log(`ensured dir: ${this.outputDir}`);

      // Create a safe filename by replacing invalid characters
      const safePostalCode = this.postalCode.replace(/[\\/:*?"<>|]/g, '_');
      const filePath = path.join(this.outputDir, `${safePostalCode}_page_after_js.html`);

      // Write the file
      fs.writeFileSync(filePath, html, "utf-8");
      console.log(`💾 Saved page after JS html file [From INIT FUNCTION] → ${filePath}`);
      return;
    }
  }

  /** Follow your DOM flow strictly and return the feed-desktop container handle. */
  async getFeedDesktopHandle() {
    logStep("Step 1: <body> → #root");
    const root = await this.page.$("body > div#root");
    if (!root) throw new Error("Root div (#root) not found right under <body>.");

    logStep("Step 2: #root → <main id='main-content'>");
    const main = await root.$(":scope main#main-content");
    if (!main) throw new Error("main#main-content not found under #root.");
    await saveElementHtml(main, "debug-main2.html");
    logStep("Step 3: main → DIV-1 (first direct child div)");
    const div1 = await main.$(":scope > div");
    if (!div1) throw new Error("DIV-1 (direct child of main) not found.");

    logStep("Step 4: DIV-1 → DIV-1-Child (its direct child)");
    const div1Child = await div1.$(":scope > div");
    if (!div1Child) throw new Error("DIV-1-Child not found.");
    await saveElementHtml(div1Child, "debug-step4.html");
    logStep("Step 5: DIV-1-Child → pick the 5th child");
    const children = await div1Child.$$(":scope > div");
    console.log("Found children count:", children.length);
    console.log(children);
    if (children.length < 5) {
      throw new Error("Less than 5 children inside DIV-1-Child");
    }

    const fifthChild = children[4]; // index is 0-based


    logStep("Step 6: 5th child → its direct child (DIV-1-CHILDS-5TH-CHILDs-Child)");
    const fifthChildInner = await fifthChild.$(":scope > div");
    if (!fifthChildInner)
      throw new Error("Direct child inside 5th child not found.");

    logStep("Step 7: That inner → Only Child");
    const onlyChild = await fifthChildInner.$(":scope > div");
    if (!onlyChild) throw new Error("Only child div not found.");

    logStep("Step 8: Only Child → feed-desktop container");
    const feedDesktop = await onlyChild.$(
      ":scope div[class*='feed-desktop'], div[data-testid='feed-desktop']"
    );
    if (!feedDesktop)
      throw new Error("feed-desktop container not found inside Only Child.");

    logStep("✅ feed-desktop found.");
    return feedDesktop;
  }

  /** Extract sections (Speedy Deliveries + All Stores) from feed-desktop. */
  /** Extract sections (Speedy Deliveries + All Stores) from feed-desktop. */
  async extractSectionsFromFeed(feedDesktopHandle) {
    return await feedDesktopHandle.evaluate((feed) => {
      const txt = (el) => (el ? el.textContent.trim() : null);
      const extractCard = (card) => {
        const q = (sel) => card.querySelector(sel);

        let name =
          txt(q("h3")) ||
          txt(q("h4")) ||
          (q("a[aria-label]") ? q("a[aria-label]").getAttribute("aria-label") : null);

        let link = q("a[href*='/store/']")?.href || null;
        let image =
          q("picture img")?.src ||
          q("img")?.src ||
          (q("img") ? q("img").getAttribute("src") : null);

        const allText = (card.innerText || "").replace(/\s+/g, " ").trim();

        let rating = null;
        const mRating = allText.match(/(\d\.\d)\s*★?|\s★\s*(\d\.\d)/);
        if (mRating) rating = mRating[1] || mRating[2] || null;

        let deliveryTime = null;
        const mEta = allText.match(/(\d+\s*[–-]\s*\d+\s*min|\d+\s*min)/i);
        if (mEta) deliveryTime = mEta[1];

        let priceInfo = null;
        const mPrice = allText.match(/£{1,4}/);
        if (mPrice) priceInfo = mPrice[0];

        let cuisine = null;
        const sub =
          txt(q("p")) ||
          txt(q("[data-testid*='subtitle']")) ||
          txt(q("div[role='text']")) ||
          null;
        if (sub) {
          const tokens = sub
            .split(/•|·|\||,/)
            .map((s) => s.trim())
            .filter(
              (s) =>
                s &&
                !/\bmin\b/i.test(s) &&
                !/£/.test(s) &&
                !/^\d+(\.\d+)?$/.test(s) &&
                !/star|rating/i.test(s)
            );
          if (tokens.length) cuisine = tokens.join(" • ");
        }

        let offer = null;
        const offerNode = Array.from(card.querySelectorAll("div, span"))
          .map((e) => e.textContent.trim())
          .find((t) => /free item|off|discount|deal|save/i.test(t));
        if (offerNode) offer = offerNode;

        return { name, cuisine, rating, deliveryTime, priceInfo, offer, link, image };
      };

      const getByText = (sel, text) => {
        const t = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const target = t(text);
        const list = feed.querySelectorAll(sel);
        for (const el of list) if (t(el.textContent) === target) return el;
        return null;
      };

      const result = { speedyDeliveries: [], allStores: [] };

      // ---- Speedy Deliveries ----
      const speedySpan = getByText("h2 span", "Speedy deliveries");
      if (speedySpan) {
        const section = speedySpan.closest("section");
        if (section) {
          const cards = section.querySelectorAll("[data-testid='store-card']");
          for (const c of cards) result.speedyDeliveries.push(extractCard(c));
        }
      }

      // ---- All Stores ----
      const allStoresH2 = getByText("h2", "All Stores");
      if (allStoresH2) {
        const container = allStoresH2.closest("div") || feed;
        const cards = container.querySelectorAll("[data-testid='store-card']");
        for (const c of cards) result.allStores.push(extractCard(c));
      }

      return result;
    });
  }


  async run() {
    try {
      await this.init();
      if (this.downloadOnly)
        return;
      if (this.saveNet) {
        // 🛰️ dump captured network responses
        dumpCapturedJson(this.net.captured, this.net.dir);
        console.log(`🛰️ Captured JSON responses: ${this.net.captured.length}`);
        // 🔎 Try to extract stores from the captured JSON
        const netStores = extractStoresFromCaptured(this.net.captured);
        logData("Extracted (network)", netStores);

        if (netStores.length) {
          fs.writeFileSync("ubereats_network.json", JSON.stringify(netStores, null, 2));
          console.log("💾 Saved → ubereats_network.json");
          // ✅ If we got data from the network, we can stop here (skip DOM path)
          return;
        }
      }
      // Follow the exact flow to the feed-desktop
      const feedDesktop = await this.getFeedDesktopHandle();

      // Extract both sections from that container
      const data = await this.extractSectionsFromFeed(feedDesktop);

      // Log counts + samples
      logData("Speedy Deliveries", data.speedyDeliveries);
      logData("All Stores", data.allStores);

      // Save
      fs.writeFileSync(`${this.postalCode}.json`, JSON.stringify(data, null, 2));
      console.log("💾 Saved extracted data from main page  → " + this.postalCode + ".json");
    } catch (err) {
      console.log(err)
      console.error("❌ Error from mainPageScrapper:", err.message || err);
    } finally {
      console.log("Closing browser\n");
      if (this.browser) await this.browser.close();
    }
  }
}

/* ------------------------------ Execute ------------------------------ */

// (async () => {
//   const scraper = new UberEatsScraper(URL, { saveNet: false, downloadOnly: true, postalCode: "N/A", outputDir: "./data/rawHtml" });
//   await scraper.run();
// })();
