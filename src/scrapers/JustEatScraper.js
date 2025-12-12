import { BaseWebScraper } from "./BaseWebScraper.js";
import fs, { writeFileSync } from "fs";
import path from "path";
import * as cheerio from "cheerio";

/**
 * Just Eat specific scraper implementation
 * Example implementation to demonstrate BaseWebScraper extensibility
 */
export class JustEatScraper extends BaseWebScraper {
  constructor(url, options = {}) {
    super(url, {
      timeout: 60000,
      ...options,
    });

    const baseFolder = path.join(".", "justeat");
    fs.mkdirSync(baseFolder, { recursive: true });
    this.htmlFilePath = path.join(baseFolder, `JustEat_page_${Date.now()}.html`);
    this.jsonFilePath = path.join(baseFolder, `extract_restaurant_${Date.now()}.json`);
  }

  // ==================== REQUIRED IMPLEMENTATIONS ====================

  getSiteName() {
    return "JustEat";
  }

  async waitForInitialContent() {
    // Handle location permission popup
    await this.handleLocationPermission();

    // Handle cookie consent
    await this.handleCookieConsent();

    // Wait for Just Eat specific content
    try {
      await this.page.waitForSelector(
        '[data-test-id="restaurant-card"], .restaurant-item, .c-listing-item',
        { timeout: this.options.timeout }
      );
      this.logStep("Restaurant listings detected");
    } catch (error) {
      this.logStep("Fallback: waiting for any content container");
      await this.page.waitForSelector("main, #main, .main-content", {
        timeout: this.options.timeout,
      });
    }

    await this.sleep(2000);
  }

  async handleLocationPermission() {
    try {
      // Mock geolocation API to prevent permission dialog from appearing
      await this.page.evaluateOnNewDocument(() => {
        // Override navigator.geolocation.getCurrentPosition
        navigator.geolocation.getCurrentPosition = function (
          success,
          error,
          options
        ) {
          // Provide fake London coordinates immediately
          setTimeout(() => {
            success({
              coords: {
                accuracy: 21,
                altitude: null,
                altitudeAccuracy: null,
                heading: null,
                latitude: 51.5074, // London
                longitude: -0.1278, // London
                speed: null,
              },
              timestamp: Date.now(),
            });
          }, 100);
        };

        // Override watchPosition as well
        navigator.geolocation.watchPosition = function (
          success,
          error,
          options
        ) {
          return navigator.geolocation.getCurrentPosition(
            success,
            error,
            options
          );
        };

        // Override clearWatch
        navigator.geolocation.clearWatch = function (id) {
          // Do nothing
        };
      });

      // Also block permissions as backup
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions("https://www.just-eat.co.uk", []);

      this.logStep("✅ Mocked geolocation API to prevent permission dialog");

      await this.sleep(1000);
    } catch (error) {
      this.logStep(`⚠️ Location permission handling failed: ${error.message}`);
    }
  }

  async handleCookieConsent() {
    try {
      // Wait for cookie banners to appear
      await this.sleep(4000);

      // Handle pie-cookie-banner with shadow DOM
      const cookieHandled = await this.page.evaluate(() => {
        let handled = [];

        // Strategy 1: Handle pie-cookie-banner shadow DOM
        const pieCookieBanner = document.querySelector("pie-cookie-banner");
        if (pieCookieBanner && pieCookieBanner.shadowRoot) {
          const shadowRoot = pieCookieBanner.shadowRoot;

          // Look for buttons inside shadow DOM
          const necessaryButton = shadowRoot.querySelector(
            'pie-button[data-test-id="actions-necessary-only"]'
          );
          const acceptAllButton = shadowRoot.querySelector(
            'pie-button[data-test-id="actions-accept-all"]'
          );

          if (necessaryButton) {
            necessaryButton.click();
            handled.push("shadow-necessary-only");
          } else if (acceptAllButton) {
            acceptAllButton.click();
            handled.push("shadow-accept-all");
          }
        }

        // Strategy 2: Handle regular DOM pie-buttons (fallback)
        if (handled.length === 0) {
          const pieButtons = document.querySelectorAll("pie-button");
          for (const btn of pieButtons) {
            const testId = btn.getAttribute("data-test-id");
            if (testId === "actions-necessary-only") {
              btn.click();
              handled.push("regular-necessary-only");
              break;
            } else if (testId === "actions-accept-all") {
              btn.click();
              handled.push("regular-accept-all");
              break;
            }
          }
        }

        // Strategy 3: Handle standard cookie buttons
        if (handled.length === 0) {
          const buttons = Array.from(document.querySelectorAll("button"));
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toLowerCase() || "";
            if (
              text.includes("necessary only") ||
              text.includes("essential only")
            ) {
              btn.click();
              handled.push("standard-necessary");
              break;
            } else if (
              text.includes("accept all") ||
              text.includes("accept cookies")
            ) {
              btn.click();
              handled.push("standard-accept");
              break;
            }
          }
        }

        // Strategy 4: Remove cookie banner entirely if clicking fails
        if (handled.length === 0) {
          const cookieBanner = document.querySelector(
            'pie-cookie-banner, [class*="cookie"], [id*="cookie"]'
          );
          if (cookieBanner) {
            cookieBanner.remove();
            handled.push("removed-banner");
          }
        }

        return handled.length > 0 ? handled.join(", ") : false;
      });

      if (cookieHandled) {
        this.logStep(`🍪 Cookie consent handled: ${cookieHandled}`);
        await this.sleep(3000);
      } else {
        this.logStep("⚠️ No cookie consent banner found");
      }
    } catch (error) {
      this.logStep(`⚠️ Cookie consent handling failed: ${error.message}`);
    }
  }

  async extractFromDOMBackup() {
    try {
      return await this.page.evaluate(() => {
        // Just Eat specific selectors (these would need to be updated based on actual site structure)
        const restaurantCards = document.querySelectorAll(
          [
            '[data-test-id="restaurant-card"]',
            ".restaurant-item",
            ".c-listing-item",
            ".restaurant-card",
          ].join(", ")
        );

        const restaurants = [];

        restaurantCards.forEach((card) => {
          const name = card
            .querySelector(
              'h3, h4, .restaurant-name, [data-test-id="restaurant-name"]'
            )
            ?.textContent?.trim();
          const cuisine = card
            .querySelector(
              '.cuisine, .restaurant-cuisine, [data-test-id="restaurant-cuisine"]'
            )
            ?.textContent?.trim();
          const rating = card
            .querySelector('.rating, .star-rating, [data-test-id="rating"]')
            ?.textContent?.match(/\d\.\d/)?.[0];
          const deliveryTime = card
            .querySelector(
              '.delivery-time, .eta, [data-test-id="delivery-time"]'
            )
            ?.textContent?.trim();
          const link = card.querySelector("a")?.href;
          const image = card.querySelector("img")?.src;

          if (name) {
            restaurants.push({
              name,
              cuisine: cuisine || null,
              rating: rating || null,
              deliveryTime: deliveryTime || null,
              link: link || null,
              image: image || null,
              priceInfo: null, // Would extract if available
              offer: null, // Would extract if available
            });
          }
        });

        return restaurants;
      });
    } catch (error) {
      this.logStep(`DOM extraction failed: ${error.message}`);
      return [];
    }
  }

  async extractFromDOM() {
  try {
    return await this.page.evaluate(() => {
      const restaurantCards = document.querySelectorAll(
        '[data-test-id="restaurant-card"], .restaurant-item, .c-listing-item, .restaurant-card'
      );

      const restaurants = [];

      restaurantCards.forEach((card) => {
        const name = card.querySelector(
          'h3, h4, .restaurant-name, [data-test-id="restaurant-name"]'
        )?.textContent?.trim();

        const cuisine = card.querySelector(
          '.cuisine, .restaurant-cuisine, [data-test-id="restaurant-cuisine"]'
        )?.textContent?.trim();

        const rating = card.querySelector(
          '.rating, .star-rating, [data-test-id="rating"]'
        )?.textContent?.match(/\d\.\d/)?.[0];

        const deliveryTime = card.querySelector(
          '.delivery-time, .eta, [data-test-id="delivery-time"]'
        )?.textContent?.trim();

        const link = card.querySelector("a")?.href;
        const image = card.querySelector("img")?.src;

        if (name) {
          restaurants.push({
            name,
            cuisine: cuisine || null,
            rating: rating || null,
            deliveryTime: deliveryTime || null,
            link: link || null,
            image: image || null,
          });
        }
      });

      return restaurants; // always returns an array
    });
  } catch (error) {
    this.logStep(`DOM extraction failed: ${error.message}`);
    return []; // <--- return empty array instead of undefined
  }
}


  extractFromNetworkData(capturedData) {
    const menuData = [];

    for (const resp of capturedData) {
      if (!resp.data) continue;

      if (resp.data.menu) {
        const menuSections = resp.data.menu.map((section) => ({
          section: section.name || "Menu",
          items: (section.products || []).map((item) => ({
            id: item.id || null,
            name: item.name || null,
            description: item.description || null,
            price: item.price ? `£${(item.price / 100).toFixed(2)}` : null,
            image: item.image || null,
            addons: item.addons || [],
            dietary_tags: item.dietary_tags || [],
            nutrition: item.nutrition || null,
            popularity: item.popularity || null,
          })),
        }));

        menuData.push(...menuSections);
      }
    }

    return menuData;
  }

  // async saveResults(result) {
  //   const filename = `justeat_${result.source}_${Date.now()}.json`;
  //   fs.writeFileSync(filename, JSON.stringify(result.data, null, 2));
  //   this.logStep(`Results saved: ${filename} (${result.data.length} items)`);
  // }

  // ✅ only save HTML, not JSON here
  saveResultsss(html) {
    if (!html) {
      console.warn("⚠️ No HTML to save");
      return;
    }

    try {
      // 1️⃣ Get HTML string from the page (if not already)
      const htmlString = Array.isArray(html) ? html.join("") : html;

      // Create folders if not exist
      fs.mkdirSync(path.dirname(this.htmlFilePath), { recursive: true });
      fs.mkdirSync(path.dirname(this.jsonFilePath), { recursive: true });

      // 2️⃣ Save HTML
      writeFileSync(this.htmlFilePath, htmlString, "utf-8");
      this.logStep(`💾 HTML saved to ${this.htmlFilePath}`);

      // 3️⃣ Save JSON
      const $ = cheerio.load(htmlString);

      const ldJsonData = this.extractLdJson($);
      const nextData = this.extractNextData($);
      const menu = this.transformMenu(nextData);

      const restaurantInfo = this.extractRestaurantInfo(ldJsonData);

      const output = {
        restaurant_id: ldJsonData?.["@id"] || restaurantInfo.id || null,
        restaurant: restaurantInfo,
        menu,
      };

      writeFileSync(
        this.jsonFilePath,
        JSON.stringify(output, null, 2),
        "utf-8"
      );
      this.logStep(`📄 JSON extracted and saved to ${this.jsonFilePath}`);
    } catch (err) {
      console.error("❌ Failed JSON extraction:", err.message);
    }
  }

 async saveResults(results) {
  if (!results || results.length === 0) {
    this.logStep("⚠️ No results to save");
    return;
  }

  // Folder for this site
  const folder = path.resolve(`./data/${this.getSiteName().toLowerCase()}`);
  fs.mkdirSync(folder, { recursive: true });

  // Save JSON results
  const jsonFilename = path.join(folder, `${this.getSiteName().toLowerCase()}_results.json`);
  fs.writeFileSync(jsonFilename, JSON.stringify(results, null, 2), "utf-8");
  this.logStep(`💾JSON Saved ${results.length} results to: ${jsonFilename}`);

  // Save page HTML at the same time (single process)
  const htmlFilename = path.join(folder, `${this.getSiteName().toLowerCase()}_page.html`);
  const htmlContent = await this.page.content();
  fs.writeFileSync(htmlFilename, htmlContent, "utf-8");
  this.logStep(`💾 HTML Saved page: ${htmlFilename}`);
}

  // ---------------- HELPERS ----------------
  extractLdJson($) {
    const script = $('script[type="application/ld+json"]').first();
    if (!script.length) return {};
    try {
      return JSON.parse(script.html());
    } catch {
      return {};
    }
  }

  extractNextData($) {
    const script = $("#__NEXT_DATA__");
    if (!script.length) return {};
    try {
      return JSON.parse(script.html());
    } catch {
      return {};
    }
  }

  extractRestaurantInfo(ldJsonData) {
    return {
      id: ldJsonData?.["@id"] || Date.now().toString(),
      name: ldJsonData.name || "Unknown",
      logo: ldJsonData.image || null,
      cuisine_type: ldJsonData.servesCuisine || [],
      address: ldJsonData.address?.streetAddress || "",
      rating: parseFloat(ldJsonData.aggregateRating?.ratingValue) || null,
      review_count: ldJsonData.aggregateRating?.reviewCount || 0,
    };
  }

  transformMenu(nextData) {
  const fetchData =
    nextData?.props?.pageProps?.initialProps?.menu?.restaurant?.cdn ||
    nextData?.props?.appProps?.preloadedState?.menu?.restaurant;

  if (!fetchData) return [];

  const itemData = fetchData.cdn?.items || fetchData.items || {};
  const menuData = fetchData.cdn?.restaurant?.menus || fetchData.restaurant?.menus;

  if (!menuData?.length) return [];

  return menuData[0].categories.map((menu) => ({
    section: menu?.name || "Unknown Section",
    items: menu?.itemIds
      ?.map((itemId) => {
        const item = itemData[itemId];
        if (!item) return null;
        const variation = item.variations?.[0];
        return {
          id: item.id,
          name: item.name,
          description: item.description || null,
          price: variation?.basePrice ? `£${variation.basePrice.toFixed(2)}` : null,
          image: item.imageSources?.[0]?.path || null,
          nutrition: variation?.nutritionalInfo?.energyDisplay || null,
        };
      })
      .filter(Boolean),
  }));
}


  // ==================== HTML Saving ====================
  saveHtmlContent(html) {
    try {
      fs.writeFileSync(this.htmlFilePath, html, "utf-8"); // overwrite every time
      this.logStep(`💾 HTML saved to ${this.htmlFilePath}`);
    } catch (err) {
      this.logStep(`❌ Failed to save HTML: ${err.message}`);
    }
  }

  // ==================== OPTIONAL OVERRIDES ====================

  getNetworkCapturePatterns() {
    return [
      /justeat|just-eat|api|restaurant|search|list/i,
      "justeat",
      "just-eat",
      "restaurant",
      "api",
      "search",
    ];
  }

  getBlockedDomains() {
    return [...super.getBlockedDomains(), "hotjar", "optimizely"];
  }

  isNetworkDataSufficient(networkData) {
    return networkData.length > 5;
  }
}
