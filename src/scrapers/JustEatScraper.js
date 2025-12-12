import { BaseWebScraper } from './BaseWebScraper.js';
import fs from 'fs';

/**
 * Just Eat specific scraper implementation
 * Example implementation to demonstrate BaseWebScraper extensibility
 */
export class JustEatScraper extends BaseWebScraper {
  constructor(url, options = {}) {
    super(url, {
      timeout: 60000,
      ...options
    });
  }

  // ==================== REQUIRED IMPLEMENTATIONS ====================

  getSiteName() {
    return 'JustEat';
  }

  async waitForInitialContent() {
    // Handle location permission popup
    await this.handleLocationPermission();
    
    // Handle cookie consent
    await this.handleCookieConsent();
    
    // Wait for Just Eat specific content
    try {
      await this.page.waitForSelector('[data-test-id="restaurant-card"], .restaurant-item, .c-listing-item', 
        { timeout: this.options.timeout });
      this.logStep('Restaurant listings detected');
    } catch (error) {
      this.logStep('Fallback: waiting for any content container');
      await this.page.waitForSelector('main, #main, .main-content', { timeout: this.options.timeout });
    }
    
    await this.sleep(2000);
  }

  async handleLocationPermission() {
    try {
      // Mock geolocation API to prevent permission dialog from appearing
      await this.page.evaluateOnNewDocument(() => {
        // Override navigator.geolocation.getCurrentPosition
        navigator.geolocation.getCurrentPosition = function(success, error, options) {
          // Provide fake London coordinates immediately
          setTimeout(() => {
            success({
              coords: {
                accuracy: 21,
                altitude: null,
                altitudeAccuracy: null,
                heading: null,
                latitude: 51.5074,  // London
                longitude: -0.1278, // London
                speed: null
              },
              timestamp: Date.now()
            });
          }, 100);
        };
        
        // Override watchPosition as well
        navigator.geolocation.watchPosition = function(success, error, options) {
          return navigator.geolocation.getCurrentPosition(success, error, options);
        };
        
        // Override clearWatch
        navigator.geolocation.clearWatch = function(id) {
          // Do nothing
        };
      });
      
      // Also block permissions as backup
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions('https://www.just-eat.co.uk', []);
      
      this.logStep('✅ Mocked geolocation API to prevent permission dialog');
      
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
        const pieCookieBanner = document.querySelector('pie-cookie-banner');
        if (pieCookieBanner && pieCookieBanner.shadowRoot) {
          const shadowRoot = pieCookieBanner.shadowRoot;
          
          // Look for buttons inside shadow DOM
          const necessaryButton = shadowRoot.querySelector('pie-button[data-test-id="actions-necessary-only"]');
          const acceptAllButton = shadowRoot.querySelector('pie-button[data-test-id="actions-accept-all"]');
          
          if (necessaryButton) {
            necessaryButton.click();
            handled.push('shadow-necessary-only');
          } else if (acceptAllButton) {
            acceptAllButton.click();
            handled.push('shadow-accept-all');
          }
        }
        
        // Strategy 2: Handle regular DOM pie-buttons (fallback)
        if (handled.length === 0) {
          const pieButtons = document.querySelectorAll('pie-button');
          for (const btn of pieButtons) {
            const testId = btn.getAttribute('data-test-id');
            if (testId === 'actions-necessary-only') {
              btn.click();
              handled.push('regular-necessary-only');
              break;
            } else if (testId === 'actions-accept-all') {
              btn.click();
              handled.push('regular-accept-all');
              break;
            }
          }
        }
        
        // Strategy 3: Handle standard cookie buttons
        if (handled.length === 0) {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toLowerCase() || '';
            if (text.includes('necessary only') || text.includes('essential only')) {
              btn.click();
              handled.push('standard-necessary');
              break;
            } else if (text.includes('accept all') || text.includes('accept cookies')) {
              btn.click();
              handled.push('standard-accept');
              break;
            }
          }
        }
        
        // Strategy 4: Remove cookie banner entirely if clicking fails
        if (handled.length === 0) {
          const cookieBanner = document.querySelector('pie-cookie-banner, [class*="cookie"], [id*="cookie"]');
          if (cookieBanner) {
            cookieBanner.remove();
            handled.push('removed-banner');
          }
        }
        
        return handled.length > 0 ? handled.join(', ') : false;
      });

      if (cookieHandled) {
        this.logStep(`🍪 Cookie consent handled: ${cookieHandled}`);
        await this.sleep(3000);
      } else {
        this.logStep('⚠️ No cookie consent banner found');
      }
    } catch (error) {
      this.logStep(`⚠️ Cookie consent handling failed: ${error.message}`);
    }
  }

  async extractFromDOM() {
    try {
      return await this.page.evaluate(() => {
        // Just Eat specific selectors (these would need to be updated based on actual site structure)
        const restaurantCards = document.querySelectorAll([
          '[data-test-id="restaurant-card"]',
          '.restaurant-item',
          '.c-listing-item',
          '.restaurant-card'
        ].join(', '));

        const restaurants = [];

        restaurantCards.forEach(card => {
          const name = card.querySelector('h3, h4, .restaurant-name, [data-test-id="restaurant-name"]')?.textContent?.trim();
          const cuisine = card.querySelector('.cuisine, .restaurant-cuisine, [data-test-id="restaurant-cuisine"]')?.textContent?.trim();
          const rating = card.querySelector('.rating, .star-rating, [data-test-id="rating"]')?.textContent?.match(/\d\.\d/)?.[0];
          const deliveryTime = card.querySelector('.delivery-time, .eta, [data-test-id="delivery-time"]')?.textContent?.trim();
          const link = card.querySelector('a')?.href;
          const image = card.querySelector('img')?.src;

          if (name) {
            restaurants.push({
              name,
              cuisine: cuisine || null,
              rating: rating || null,
              deliveryTime: deliveryTime || null,
              link: link || null,
              image: image || null,
              priceInfo: null, // Would extract if available
              offer: null // Would extract if available
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

  extractFromNetworkData(captured) {
    const restaurants = [];

    const looksLikeRestaurant = (obj) => {
      if (!obj || typeof obj !== 'object') return false;
      return (obj.name || obj.restaurantName || obj.title) && 
             (obj.cuisine || obj.cuisines || obj.category);
    };

    const mapRestaurant = (obj) => ({
      name: obj.name || obj.restaurantName || obj.title || null,
      cuisine: Array.isArray(obj.cuisines) ? obj.cuisines.join(' • ') : (obj.cuisine || obj.category || null),
      rating: obj.rating || obj.averageRating || null,
      deliveryTime: obj.deliveryTime || obj.eta || null,
      link: obj.url || obj.link || null,
      image: obj.image || obj.imageUrl || obj.logo || null,
      priceInfo: obj.priceRange || obj.price || null,
      offer: obj.promotion || obj.deal || null
    });

    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.filter(looksLikeRestaurant).forEach(obj => restaurants.push(mapRestaurant(obj)));
        node.forEach(walk);
      } else {
        if (looksLikeRestaurant(node)) {
          restaurants.push(mapRestaurant(node));
        }
        Object.values(node).forEach(walk);
      }
    };

    for (const capture of captured) {
      if (capture.json) walk(capture.json);
    }

    // Deduplicate
    const seen = new Set();
    return restaurants.filter(restaurant => {
      const key = `${restaurant.name}::${restaurant.link || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return !!restaurant.name;
    });
  }

  async saveResults(result) {
    const filename = `justeat_${result.source}_${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(result.data, null, 2));
    this.logStep(`Results saved: ${filename} (${result.data.length} items)`);
  }

  // ==================== OPTIONAL OVERRIDES ====================

  getNetworkCapturePatterns() {
    return [
      /justeat|just-eat|api|restaurant|search|list/i,
      'justeat',
      'just-eat',
      'restaurant',
      'api',
      'search'
    ];
  }

  getBlockedDomains() {
    return [
      ...super.getBlockedDomains(),
      'hotjar',
      'optimizely'
    ];
  }

  isNetworkDataSufficient(networkData) {
    return networkData.length > 5;
  }
}
