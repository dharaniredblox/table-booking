import path from 'path';
import fs from 'fs';
import { apiRequest } from './utils/apiHandler.js';
import { uploadFile, uploadJson } from './utils/s3Uploader.js';
import { extractUberEatsStore } from './scrapers/apiExtractor.js';
import { UberEatsScraper } from './scrapers/mainPageScrapper.js';
import { restroInfoExtractorFromAllStores } from './htmlParser.js';
// Ensure store directory exists
const dirStr = {
    failedStoreUrlsFile: './failed_store_urls.log',
    failedMainUrlsFile: './failed_main_urls.log',
    rawHtmlDir: './data/rawHtml', // Raw HTML downloaded pages
    parsedHtmlDir: './data/parsedHtml', // Parsed store metadata
    processed_stores: './data/processed_stores', // Final processed store data,
    processedUrlsFile: './data/progress.json', // Processed URLs
    s3BucketName: 'data-extractions-scraping',
    uberEatsRawJson: './data/uberEatsRawJson',
    uberEatsRawJsonLd: './data/uberEatsRawJsonLd',
}

// make only directories (not file paths)
const dirsToMake = [
    dirStr.rawHtmlDir,
    dirStr.parsedHtmlDir,
    dirStr.processed_stores,
    path.dirname(dirStr.failedStoreUrlsFile),
    path.dirname(dirStr.failedMainUrlsFile),
    dirStr.uberEatsRawJson,
    dirStr.uberEatsRawJsonLd,
];

dirsToMake.forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Load progress: main pages or store-level
function loadProgress(loadStoreProgress = false, postalCode = "") {
    try {
        if (loadStoreProgress) {
            const file = path.join(dirStr.processed_stores, `${postalCode}_progress.json`);
            if (!fs.existsSync(file)) return {};
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
        if (!fs.existsSync(dirStr.processedUrlsFile)) return {};
        const raw = fs.readFileSync(dirStr.processedUrlsFile, 'utf8') || '';
        if (!raw) return {};
        const parsed = JSON.parse(raw);

        // backward compatibility: if old format is array -> convert to map
        if (Array.isArray(parsed)) {
            const obj = {};
            for (const postal of parsed) obj[postal] = { downloaded: true, processed: false };
            saveProgress(obj);
            return obj;
        }

        return (typeof parsed === 'object' && parsed) ? parsed : {};
    } catch (err) {
        if (loadStoreProgress) {
            console.error('loadStoreProgress error:', err.message);
            return {};
        }
        console.error('loadProgress error:', err.message);
        return {};
    }
}

// Save progress: main pages or store-level
function saveProgress(progressObj, saveStoreProgress = false, postalCode = "") {
    try {
        if (saveStoreProgress) {
            const file = path.join(dirStr.processed_stores, `${postalCode}_progress.json`);
            fs.writeFileSync(file, JSON.stringify(progressObj, null, 2), 'utf-8');
            return;
        }
        const filepath = dirStr.processedUrlsFile;
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(filepath) && fs.lstatSync(filepath).isDirectory()) {
            fs.renameSync(filepath, filepath + '.bak_' + Date.now());
        }
        const tmp = `${filepath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(progressObj, null, 2), 'utf8');
        fs.renameSync(tmp, filepath); // atomic replace
    } catch (err) {
        if (saveStoreProgress) {
            console.error('saveStoreProgress error:', err.message);
            return;
        }
        console.error('saveProgress error:', err.message);
        throw err;
    }
}

function getStoresMetaDataOrUrls(type = "", filePath = "") {
    try {
        if (type === 'metaData') {
            // If filePath is provided, use it directly, otherwise use the parsedHtmlDir
            const metaDataPath = filePath || path.join(dirStr.parsedHtmlDir, 'stores_metadata.json');
            const response = JSON.parse(fs.readFileSync(metaDataPath, 'utf-8'));

            // Handle the case where data is nested in a 'data' property
            const data = Array.isArray(response) ? response : (response.data || []);

            if (!Array.isArray(data)) {
                const errorPreview = JSON.stringify(response).slice(0, 50);
                console.error(`Expected an array but got: ${errorPreview}...`);
                return [];
            }
            if (data.length === 0) {
                console.warn('No stores found in the metadata file');
            }
            return data;
        }
        if (type === 'urls') {
            const urlsPath = filePath || './urls.json';
            const data = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));

            // Handle the new format where URLs are in an object array
            if (data.urls && Array.isArray(data.urls)) {
                // Convert the array of objects into the expected format
                return data.urls.flatMap(obj => {
                    const [postalCode, url] = Object.entries(obj)[0]; // Get first key-value pair
                    return { [postalCode]: url };
                });
            }

            // Fallback to the original format
            if (!Array.isArray(data)) {
                console.error('Expected an array of URLs but got:', data);
                return [];
            }
            if (data.length === 0) {
                console.warn('No URLs found in the file');
            }
            return data;
        }
        throw new Error('Invalid type specified');
    } catch (error) {
        console.error(`Error in getStoresMetaDataOrUrls (type: ${type}):`, error.message);
        return []; // Return empty array instead of throwing to prevent crashes
    }
}

function sleep(ms = 5000) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, maxRetries = 5, baseDelay = 10000) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await apiRequest(url, { ...options, format: 'text' });
            return response;
        } catch (error) {
            lastError = error;
            console.error(`Attempt ${attempt} failed:`, error.message);

            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
                console.log(`Retrying in ${delay}ms...`);
                await sleep(delay);
            }
        }
    }

    throw new Error(`Failed after ${maxRetries} attempts: ${lastError.message}`);
}

async function donwloadMainHTMLPage() {
    console.log('Downloading main HTML pages...\n');
    try {
        const urlsData = getStoresMetaDataOrUrls('urls');
        const CONCURRENT_LIMITS = 3;

        // load progress map once (single source of truth)
        const progressMap = loadProgress();
        const downloadedSet = new Set(
            Object.entries(progressMap).filter(([, v]) => v && v.downloaded).map(([k]) => k)
        );

        const urlsToProcess = urlsData.filter(urlObj => {
            const [postalCode] = Object.entries(urlObj)[0];
            return !downloadedSet.has(postalCode);
        });

        console.log(`Found ${urlsToProcess.length} new URLs to process out of ${urlsData.length} total\n`);

        for (let i = 0; i < urlsToProcess.length; i += CONCURRENT_LIMITS) {
            const batch = urlsToProcess.slice(i, i + CONCURRENT_LIMITS);
            const totalBatches = Math.ceil(urlsToProcess.length / CONCURRENT_LIMITS);
            console.log(`Starting batch ${Math.floor(i / CONCURRENT_LIMITS) + 1}/${totalBatches} with ${batch.length} urls`);

            await Promise.all(batch.map(async (urlObj) => {
                let postalCode = 'UNKNOWN';
                let url = 'UNKNOWN';
                try {
                    const entry = Object.entries(urlObj)[0];
                    if (!entry) throw new Error('Invalid URL object');
                    [postalCode, url] = entry;

                    if (downloadedSet.has(postalCode)) return;

                    console.log(`Starting download for postal code: ${postalCode}...`);
                    const scraper = new UberEatsScraper(url, {
                        saveNet: false,
                        downloadOnly: true,
                        postalCode,
                        outputDir: dirStr.rawHtmlDir
                    });
                    await scraper.run(); // writes file

                    // update in-memory progress safely
                    progressMap[postalCode] = progressMap[postalCode] || {};
                    progressMap[postalCode].downloaded = true;

                    downloadedSet.add(postalCode);
                    console.log(`✅ Downloaded: ${postalCode}`);
                } catch (err) {
                    const safePostal = postalCode || 'UNKNOWN';
                    const safeUrl = url || JSON.stringify(urlObj);
                    console.error(`❌ Error downloading ${safePostal}:`, err?.message || err);
                    fs.appendFileSync(
                        dirStr.failedMainUrlsFile,
                        `${new Date().toISOString()} - ${safeUrl} - ${err?.message || err}\n`
                    );
                }
            }));

            // persist the updated progressMap once per batch (atomic)
            try {
                saveProgress(progressMap);
            } catch (err) {
                console.error('Failed to persist progress after batch:', err);
            }

            console.log(`Completed batch ${Math.floor(i / CONCURRENT_LIMITS) + 1}/${totalBatches}`);
            if (i + CONCURRENT_LIMITS < urlsToProcess.length) {
                await sleep(10000);
                console.log('Waiting 10s before next batch...');
            }
        }

        console.log('\n✅ All main pages downloaded!\n');
    } catch (err) {
        console.error('Error donwloadMainHTMLPage:', err);
    }
}

async function processHTMLFile(htmlPath, outputDir) {
    try {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        const postalCode = path.basename(htmlPath).split('_page_after_js.html')[0];
        const outputPath = path.join(outputDir, `${postalCode}_stores.json`);

        // Extract restaurant data
        const restaurants = restroInfoExtractorFromAllStores(html);
        const validRestaurants = restaurants.filter(restaurant => restaurant.name);

        // Add source information
        const processedData = {
            source: 'UberEats',
            postalCode,
            timestamp: new Date().toISOString(),
            count: validRestaurants.length,
            data: validRestaurants
        };

        // Save to file
        fs.writeFileSync(outputPath, JSON.stringify(processedData, null, 2), 'utf-8');
        console.log(`✅ Extracted ${validRestaurants.length} restaurants from ${postalCode}`);
        return { success: true, count: validRestaurants.length, file: outputPath };
    } catch (error) {
        console.error(`❌ Error processing ${htmlPath}:`, error.message);
        return { success: false, error: error.message };
    }
}

async function donwloadAndProcessMainPages() {
    console.log('🚀 Starting download and processing of all main pages...');
    try {
        const outputDir = dirStr.parsedHtmlDir;
        const inputDir = dirStr.rawHtmlDir;

        // 1. Download (this persists progress per-batch)
        await donwloadMainHTMLPage();

        // 2. Build list of downloaded files and skip those already processed
        const progress = loadProgress();
        const processedSet = new Set(Object.entries(progress).filter(([_, v]) => v && v.processed).map(([k]) => k));

        const allFiles = fs.readdirSync(inputDir).filter(f => f.endsWith('_page_after_js.html'));
        const files = allFiles.filter(f => {
            const postal = path.basename(f).split('_page_after_js.html')[0];
            return !processedSet.has(postal);
        });

        console.log(`Found ${allFiles.length} total HTML files, ${files.length} new files to process`);

        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const CONCURRENCY = 3;
        const results = [];

        for (let i = 0; i < files.length; i += CONCURRENCY) {
            const batch = files.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.all(batch.map(file => processHTMLFile(path.join(inputDir, file), outputDir)));
            results.push(...batchResults);

            // update in-memory progress for successful ones
            const progressMap = loadProgress(); // refresh to merge any external changes
            for (let idx = 0; idx < batch.length; idx++) {
                const filename = batch[idx];
                const res = batchResults[idx];
                const postalCode = path.basename(filename).split('_page_after_js.html')[0];
                if (res && res.success) {
                    progressMap[postalCode] = progressMap[postalCode] || {};
                    progressMap[postalCode].processed = true;
                    console.log(`✅ Processed html for: ${postalCode}`);
                } else {
                    console.log(`⚠️ Failed processing html for: ${postalCode}`);
                }
            }

            // persist once per batch
            try { saveProgress(progressMap); } catch (e) { console.error('Failed to save progress after processing batch:', e); }

            if (i + CONCURRENCY < files.length) {
                await sleep(2000);
            }
        }

        // summary
        const successful = results.filter(r => r.success);
        console.log(`\n🎉 Processing complete! ${successful.length}/${files.length} files succeeded.`);
        return results;
    } catch (err) {
        console.error('Critical error in downloadAndProcessMainPages:', err);
        throw err;
    }
}


// Process individual stores with progress tracking
async function processStores(filePath = "", uploadOnS3ForStagingState = false, uploadOnS3ForRawState = false) {
    // Get store metadata
    const storesMetadata = getStoresMetaDataOrUrls('metaData', filePath);
    let totalStores = storesMetadata.length;
    console.log(`Total stores to process: ${totalStores}`);
    let processedCount = 0;
    let skippedCount = 0;
    const postalCode = path.basename(filePath).split('_stores')[0];
    const postalCodeDir = path.join(dirStr.processed_stores, postalCode);
    if (!fs.existsSync(postalCodeDir)) {
        fs.mkdirSync(postalCodeDir, { recursive: true });
        console.log(`📁 Created directory for postal code: ${postalCode}`);
    }
    // Load or initialize progress map for this postal code
    const storeProgress = loadProgress(true, postalCode);
    for (const storeData of storesMetadata) {
        const safeName = `${storeData.name.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '_')}_${storeData.url.split("/").pop()}`.toLowerCase();
        const fileName = path.join(postalCodeDir, `${safeName}.json`);

        // Skip already processed stores
        if (storeProgress[safeName]?.processed && (!uploadOnS3ForStagingState || storeProgress[safeName]?.uploadedOnS3Staging)) {
            skippedCount = skippedCount + 1;
            console.log(`Skipping fully processed & ${storeProgress[safeName]?.uploadedOnS3Staging ? 'uploaded on S3 staging' : 'not uploaded on S3 staging'}: ${storeData.name}\n\n Total Skipped ${skippedCount}`);
            continue;
        }
        await sleep(Math.random() * 2000); // Random delay to be gentle on server, just to prevent server from tracking req
        let success = false;
        let uploadedOnS3Staging = storeProgress[safeName]?.uploadedOnS3Staging || false; // retain previous upload status
        try {
            let jsonContent = null;
            if (!storeProgress[safeName]?.processed && !fs.existsSync(fileName)) {
                console.log(`Processing: ${storeData.name}...`);
                const html = await fetchWithRetry(storeData.url);
                const store = extractUberEatsStore(html, true, true, storeData.deliveryTime, storeData.url, uploadOnS3ForRawState);

                if (store && store?.restaurant?.name) {
                    jsonContent = JSON.stringify(store, null, 2);
                    fs.writeFileSync(fileName, jsonContent);
                    console.log(`✅ [${processedCount + skippedCount + 1}/${totalStores}] Processed: ${store?.restaurant?.name} | ` +
                        `✅ Processed: ${processedCount + 1} | ` +
                        `⏩ Skipped: ${skippedCount} | ` +
                        `📊 Remaining: ${totalStores - (processedCount + skippedCount + 1)}`);
                    processedCount++;  // Increment after using the value
                    success = true;
                } else {
                    fs.appendFileSync(`${fileName}_Error.txt`, `Invalid store data received:\n${store}\n\n`);
                    console.error('❌ Invalid store data received:', store);
                }
            } else {
                // File already exists, mark as processed
                success = true;
            }

            // Upload to S3 if requested and not already uploaded
            if (uploadOnS3ForStagingState && !uploadedOnS3Staging && success && jsonContent) {
                const dateOnly = new Date().toLocaleDateString('en-CA'); // 'en-CA' gives YYYY-MM-DD format
                const s3Key = `ubereats/staging/${dateOnly}/stores/${safeName}.json`;
                const res = await uploadJson(jsonContent, dirStr.s3BucketName, s3Key);
                console.log(`✅ Successfully uploaded to S3: ${safeName}`);
                await sleep(5000);
                if (res.success) uploadedOnS3Staging = true;
            }

        } catch (error) {
            console.error(`❌ Error processing ${storeData.name || 'store'}:`, error?.message);
            fs.appendFileSync(
                dirStr.failedStoreUrlsFile,
                `${new Date().toISOString()} - ${storeData.url} - ${error.stack || error}\n`
            );
        } finally {
            // Update progress and persist
            storeProgress[safeName] = { processed: success, uploadedOnS3Staging };
            saveProgress(storeProgress, true, postalCode);
        }

        // Delay to be gentle on server
        // Random delay to be gentle on server. The average delay is 15 secs + 0-15 secs random => so its avg become 15 secs
        await sleep(15000 + Math.floor(Math.random() * 15000));
    }

    console.log(`✅ Completed processing stores for postal code: ${postalCode}`);
};

async function pipeline() {
    try {
        console.log('🚀 Starting pipeline...\n');

        // 1. Download and process main pages
        console.log('\n📥 Step 1: Downloading and processing main pages...\n');
        const processResults = await donwloadAndProcessMainPages();

        // Log summary of downloads
        const successfulFiles = processResults.filter(r => r.success);
        console.log(`\n📊 Download Summary:\n`);
        console.log(`- Processed: ${processResults.length} files`);
        console.log(`- Successful: ${successfulFiles.length} files`);
        console.log(`- Total restaurants found: ${successfulFiles.reduce((sum, r) => sum + (r.count || 0), 0)}`);

        // 2. Process individual stores
        console.log('\n🔄 Step 2: Processing individual stores...\n');
        const parsedFiles = fs.readdirSync(dirStr.parsedHtmlDir)
            .filter(file => file.endsWith('.json'));

        console.log(`Found ${parsedFiles.length} metadata files to process\n`);

        for (const file of parsedFiles) {
            const fullPath = path.join(dirStr.parsedHtmlDir, file);
            console.log(`\nProcessing stores from: ${file}\n`);
            await processStores(fullPath, true, false);
            console.log(`\n✅ Successfully processed stores from: ${file}\n`);
            console.log(`\nWaiting for 5 seconds before next batch...\n`);
            await sleep(5000 + 10000 * Math.random());
        }

        console.log('\n✨ Pipeline completed successfully!\n');
    } catch (error) {
        console.error('❌ Pipeline failed:', error);
        throw error; // Re-throw to handle in the main execution
    }
}

// Execute the pipeline
(async () => {
    try {
        console.log('🚀 Starting pipeline...\n');
        await pipeline();
        console.log('Pipeline completed successfully!\n');
    } catch (error) {
        console.error('❌ Fatal error in pipeline execution:', error);
        process.exit(1);
    }
})();