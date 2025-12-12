import { UberEatsScraper } from './src/scrapers/UberEatsScraper.js';
import { JustEatScraper } from './src/scrapers/JustEatScraper.js';

/**
 * Test runner for the generic web scraper architecture
 * Demonstrates how different site scrapers can be used with the same interface
 */

const UBER_EATS_URL = "https://www.ubereats.com/feed?diningMode=DELIVERY&pl=JTdCJTIyYWRkcmVzcyUyMiUzQSUyMlVCMSUyMDFTUSUyMiUyQyUyMnJlZmVyZW5jZSUyMiUzQSUyMkNoSUpzUXMxdDZ4eWRrZ1JzMmNtdGJDX0RBayUyMiUyQyUyMnJlZmVyZW5jZVR5cGUlMjIlM0ElMjJnb29nbGVfcGxhY2VzJTIyJTJDJTIybGF0aXR1ZGUlMjIlM0E1MS41MDgwODgzJTJDJTIybG9uZ2l0dWRlJTIyJTNBLTAuMzc3NDY4MyU3RA%3D%3D";

// Just Eat URL - using main site to test Cloudflare handling
const JUST_EAT_URL = "https://www.just-eat.co.uk/area/b4-birmingham/kebabs";

async function testUberEatsScraper() {
  console.log('\n🚀 Testing UberEats Scraper...');
  console.log('=' .repeat(50));
  
  const scraper = new UberEatsScraper(UBER_EATS_URL, {
    headless: true,
    saveHtml: true,
    captureNetwork: true
  });

  try {
    const result = await scraper.run();
    console.log(`\n✅ UberEats scraping completed!`);
    console.log(`📊 Data source: ${result.source}`);
    console.log(`📦 Items found: ${result.data.length}`);
    
    if (result.data.length > 0) {
      console.log(`📋 Sample data:`, result.data.slice(0, 2));
    }
    
    return result;
  } catch (error) {
    console.error(`❌ UberEats scraping failed:`, error.message);
    return null;
  }
}

async function testJustEatScraper() {
  console.log('\n🚀 Testing JustEat Scraper...');
  console.log('=' .repeat(50));
  
  const scraper = new JustEatScraper(JUST_EAT_URL, {
    headless: true,
    saveHtml: true,
    captureNetwork: true
  });

  try {
    const result = await scraper.run();
    console.log(`\n✅ JustEat scraping completed!`);
    console.log(`📊 Data source: ${result.source}`);
    console.log(`📦 Items found: ${result.data.length}`);
    
    if (result.data.length > 0) {
      console.log(`📋 Sample data:`, result.data.slice(0, 2));
    }
    
    return result;
  } catch (error) {
    console.error(`❌ JustEat scraping failed:`, error.message);
    return null;
  }
}

async function demonstrateGenericInterface() {
  console.log('\n🔄 Demonstrating Generic Interface...');
  console.log('=' .repeat(50));
  
  // Array of different scrapers - same interface!
  const scrapers = [
    new UberEatsScraper(UBER_EATS_URL, { headless: true }),
    new JustEatScraper(JUST_EAT_URL, { headless: true })
  ];

  for (const scraper of scrapers) {
    console.log(`\n🎯 Running ${scraper.getSiteName()} scraper...`);
    
    try {
      const result = await scraper.run();
      console.log(`   ✅ ${scraper.getSiteName()}: ${result.data.length} items (${result.source})`);
    } catch (error) {
      console.log(`   ❌ ${scraper.getSiteName()}: ${error.message}`);
    }
  }
}

async function main() {
  console.log('🧪 Generic Web Scraper Architecture Test');
  console.log('=========================================');
  
  const args = process.argv.slice(2);
  const testType = args[0] || 'all';

  switch (testType.toLowerCase()) {
    case 'ubereats':
    case 'uber':
      await testUberEatsScraper();
      break;
      
    case 'justeat':
    case 'just':
      await testJustEatScraper();
      break;
      
    case 'generic':
    case 'interface':
      await demonstrateGenericInterface();
      break;
      
    case 'all':
    default:
      await testUberEatsScraper();
      await testJustEatScraper();
      await demonstrateGenericInterface();
      break;
  }

  console.log('\n🏁 Testing completed!');
  console.log('\n📚 Usage examples:');
  console.log('  node testGenericScraper.js uber     # Test UberEats only');
  console.log('  node testGenericScraper.js just     # Test JustEat only');
  console.log('  node testGenericScraper.js generic  # Test generic interface');
  console.log('  node testGenericScraper.js all      # Test everything');
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
  process.exit(1);
});

main().catch(console.error);
