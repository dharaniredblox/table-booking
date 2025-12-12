import { connect } from "puppeteer-real-browser";
import fs from "fs";
import {
  saveElementHtml,
  saveToFile,
  saveRestaurantHtml,
  saveToRestaurantFile,
} from "../utils/file-handler.js";

import * as cheerio from "cheerio";

import path from "path";

/**
 * Abstract base class for web scraping with Puppeteer
 * Provides common functionality for any website scraping
 */
export class BaseWebScraper {
  constructor(url, options = {}) {
    if (this.constructor === BaseWebScraper) {
      throw new Error(
        "BaseWebScraper is abstract and cannot be instantiated directly"
      );
    }

    this.url = url;
    this.options = {
      headless: true,
      timeout: 30000,
      viewport: { width: 2560, height: 1600 },
      saveHtml: true,
      captureNetwork: true,
      autoScroll: true,
      ...options,
    };

    this.browser = null;
    this.page = null;
    this.capturedData = [];
  }

  // ==================== CORE PUPPETEER SETUP ====================

  async init() {
    this.logStep("Initializing browser...");

    // Use puppeteer-real-browser for better Cloudflare bypass
    const { page, browser } = await connect({
      headless: "auto",
      fingerprint: true,
      turnstile: true,
      tf: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=VizDisplayCompositor",
      ],
    });

    this.browser = browser;
    this.page = page;

    // Enable request interception for network capture
    await this.page.setRequestInterception(true);

    this.page.on("request", (request) => {
      // Capture API requests
      const url = request.url();
      if (this.shouldCaptureRequest(url)) {
        this.logStep(`📡 Capturing request: ${url}`);
      }
      request.continue();
    });

    this.page.on("response", async (response) => {
      // Capture API responses
      const url = response.url();
      if (this.shouldCaptureRequest(url)) {
        try {
          const responseData = await response.json();
          this.capturedData.push({
            url,
            method: response.request().method(),
            status: response.status(),
            data: responseData,
          });
          this.logStep(`✅ Captured response from: ${url}`);
        } catch (error) {
          // Not JSON response, skip
        }
      }
    });

    this.logStep("Browser initialized successfully");
  }

  // ==================== NAVIGATION & PAGE HANDLING ====================

  async navigateToPage() {
    this.logStep(`Navigating to: ${this.url}`);

    await this.page.goto(this.url, {
      waitUntil: "networkidle2",
      timeout: this.options.timeout,
    });

    // Check for Cloudflare challenge (puppeteer-real-browser should handle this automatically)
    await this.handleCloudflareChallenge();

    // Wait for initial content
    await this.waitForInitialContent();

    // Auto-scroll if enabled
    if (this.options.autoScroll) {
      await this.autoScroll();
    }

    // Save HTML if enabled
    if (this.options.saveHtml) {
      await this.savePageHtml();
    }

    this.logStep("Page loaded and processed");
  }

  async handleCloudflareChallenge() {
    this.logStep("Checking for Cloudflare challenge...");
    const title = await this.page.title();
    const isChallengePage =
      title.includes("Just a moment") ||
      title.includes("Checking your browser") ||
      title.includes("Please wait") ||
      title.includes("Cloudflare");

    if (isChallengePage) {
      this.logStep(
        "🛡️ Cloudflare challenge detected - puppeteer-real-browser should handle automatically..."
      );

      // Wait for automatic handling by puppeteer-real-browser
      try {
        await this.page.waitForFunction(
          () => {
            const currentTitle = document.title;
            return (
              !currentTitle.includes("Just a moment") &&
              !currentTitle.includes("Checking your browser") &&
              !currentTitle.includes("Please wait") &&
              !currentTitle.includes("Cloudflare")
            );
          },
          { timeout: 60000 }
        );

        this.logStep("✅ Cloudflare challenge completed automatically");
        await this.page.waitForTimeout(5000);
      } catch (error) {
        this.logStep("⚠️ Cloudflare challenge timeout - proceeding anyway");

        // Save debug HTML for analysis
        const debugHtml = await this.page.content();
        // const debugPath = `${this.getSiteName()}_cloudflare_debug_${Date.now()}.html`;
        // await saveRestaurantHtml(this.getSiteName(), debugPath, debugHtml);
        // this.logStep(`💾 Saved debug page: ${debugPath}`);
      }
    }
  }

  async autoScroll(maxPasses = 12, pauseMs = 600) {
    this.logStep("Auto-scrolling to load lazy content...");
    let lastHeight = await this.page.evaluate(() => document.body.scrollHeight);

    for (let i = 0; i < maxPasses; i++) {
      await this.page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight)
      );
      await this.sleep(pauseMs);

      const newHeight = await this.page.evaluate(
        () => document.body.scrollHeight
      );
      if (newHeight === lastHeight) {
        this.logStep(`Auto-scroll completed after ${i + 1} passes`);
        break;
      }
      lastHeight = newHeight;
    }
  }

  // ==================== DATA EXTRACTION ====================

  async run() {
  try {
    await this.init();
    await this.navigateToPage();

    const html = await this.page.content();
    const $ = cheerio.load(html);

    const ldJson = this.extractLdJson($);
    const restaurantInfo = this.extractRestaurantInfo(ldJson);
    const nextData = this.extractNextData($);
    const menu = this.transformMenu(nextData);

    const results = {
      restaurant_id: restaurantInfo.id,
      restaurant: restaurantInfo,
      menu,
    };

    // Save HTML + JSON
    await this.saveResults([results]);
    this.saveHtmlContent(html);

    this.logStep(`✅ Scraping completed successfully. Found ${menu.reduce((sum,s)=>sum+s.items.length,0)} items`);
    return results;
  } catch (error) {
    this.logStep(`❌ Error: ${error.message}`);
    throw error;
  } finally {
    if (this.browser) await this.browser.close();
  }
}


  // ==================== UTILITY METHODS ====================

  shouldCaptureRequest(url) {
    return (
      url.includes("/api/") || url.includes("graphql") || url.includes(".json")
    );
  }

  async savePageHtmlBackup() {
    const html = await this.page.content();
    const filename = `${this.getSiteName()}_page_${Date.now()}.html`;
    const savedPath = await saveRestaurantHtml(
      this.getSiteName(),
      filename,
      html
    );
    this.logStep(`💾 Saved page HTML: ${savedPath}`);
  }
  async savePageHtml() {
    const html = await this.page.content();

    // Fixed file path (overwrite every time)
    const filename = path.resolve(
      `./html/${this.getSiteName().toLowerCase()}_page.html`
    );

    // Make sure the folder exists
    fs.mkdirSync(path.dirname(filename), { recursive: true });

    fs.writeFileSync(filename, html, "utf-8");
    this.logStep(`💾 Saved page HTML (overwritten) at: ${filename}`);
  }

  async saveResults(results) {
    if (results && results.length > 0) {
      const filename = `${this.getSiteName()}_puppeter_normalized_${Date.now()}.json`;
      const savedPath = await saveToRestaurantFile(
        this.getSiteName(),
        filename,
        results
      );
      this.logStep(`💾 Saved ${results.length} results to: ${savedPath}`);
    }
  }

  async processResults(domData, networkData) {
    // Default implementation - child classes can override
    return [...(Array.isArray(domData) ? domData : []),
    ...(Array.isArray(networkData) ? networkData : []),];
  }

  logStep(message) {
    console.log(`🔎 [${this.getSiteName()}] ${message}`);
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==================== ABSTRACT METHODS ====================
  // These must be implemented by child classes

  getSiteName() {
    throw new Error("getSiteName() must be implemented by child class");
  }

  async waitForInitialContent() {
    throw new Error(
      "waitForInitialContent() must be implemented by child class"
    );
  }

  async extractFromDOM() {
    throw new Error("extractFromDOM() must be implemented by child class");
  }

  extractFromNetworkData(capturedData) {
    throw new Error(
      "extractFromNetworkData() must be implemented by child class"
    );
  }
}
