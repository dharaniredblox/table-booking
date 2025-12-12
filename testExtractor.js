import { restroInfoExtractorFromAllStores } from './src/htmlParser.js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the HTML file
const html = readFileSync(join(__dirname, 'page_after_js.html'), 'utf-8');

// Extract restaurant data
const restaurants = restroInfoExtractorFromAllStores(html);

// Filter out any empty restaurant entries (where name is empty)
const validRestaurants = restaurants.filter(restaurant => restaurant.name);

// Save to JSON file
const outputPath = join(__dirname, 'restro_info_extractor_from_all_stores.json');
writeFileSync(outputPath, JSON.stringify(validRestaurants, null, 2), 'utf-8');

console.log(`✅ Successfully extracted ${validRestaurants.length} restaurants`);
console.log(`📄 Output saved to: ${outputPath}`);
