import path from 'path';
import fs from 'fs';
import { apiRequest } from './utils/apiHandler.js';
import { uploadFile, uploadJson, checkS3FileExists, downloadFileFromS3, deleteFileFromS3 } from './utils/s3Uploader.js';
import { extractUberEatsStore } from './scrapers/apiExtractor.js';
import { UberEatsScraper } from './scrapers/mainPageScrapper.js';
import { restroInfoExtractorFromAllStores } from './htmlParser.js';

// -------------------- Helpers --------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mergeSourcesAndMenus(existing, newData) {
  // Normalize both existing and new sources into arrays (preserve multi-word names)
  const normalizeSource = (src) => {
    if (!src) return [];
    if (Array.isArray(src)) return src.map(s => s.trim());
    if (typeof src === 'string') return [src.trim()];
    return [];
  };

  const existingSources = normalizeSource(existing.source);
  const newSources = normalizeSource(newData.source);
  const combinedSources = Array.from(new Set([...existingSources, ...newSources]));

  console.log("existingSources",existingSources);
  console.log("newSources",newSources);
  console.log("combinedSources",combinedSources);
   

  // Merge metadata (newData overwrites existing)
  const mergedMetadata = { ...(existing.metadata || {}), ...(newData.metadata || {}) };
  console.log("mergedMetadata",mergedMetadata);


  // Merge menus (prefer latest data)
  const existingMenus = existing.menus || [];
  const newMenus = newData.menus || [];
  const mergedMenus = [...existingMenus];

  console.log("existingMenus",existingMenus);
  console.log("newMenus",newMenus);
  console.log("mergedMenus",mergedMenus);


  newMenus.forEach(newMenu => {
    const idx = mergedMenus.findIndex(m => m.platform?.toLowerCase() === newMenu.platform?.toLowerCase());
    if (idx >= 0) {
      mergedMenus[idx] = newMenu; // replace with latest
    } else {
      mergedMenus.push(newMenu);
    }
  });

  return {
    ...existing,
    source: combinedSources,
    metadata: mergedMetadata,
    menus: mergedMenus,
    timestamp: new Date().toISOString(),
  };
}



// -------------------- Directories --------------------
const dirStr = {
  failedStoreUrlsFile: './failed_store_urls.log',
  failedMainUrlsFile: './failed_main_urls.log',
  rawHtmlDir: './data/rawHtml',
  parsedHtmlDir: './data/parsedHtml',
  processed_stores: './data/processed_stores',
  fromS3Dir: './data/from_s3',
  processedUrlsFile: './data/progress.json',
  s3BucketName: process.env.AWS_BUCKET_NAME || 'data-extractions-scraping',
};

// Ensure directories exist
[dirStr.rawHtmlDir, dirStr.parsedHtmlDir, dirStr.processed_stores, dirStr.fromS3Dir].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// -------------------- Progress --------------------
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
    if (Array.isArray(parsed)) {
      const obj = {};
      for (const postal of parsed) obj[postal] = { downloaded: true, processed: false };
      saveProgress(obj);
      return obj;
    }
    return (typeof parsed === 'object' && parsed) ? parsed : {};
  } catch (err) {
    console.error(loadStoreProgress ? 'loadStoreProgress error:' : 'loadProgress error:', err.message);
    return {};
  }
}

function saveProgress(progressObj, saveStoreProgress = false, postalCode = "") {
  try {
    if (saveStoreProgress) {
      const file = path.join(dirStr.processed_stores, `${postalCode}_progress.json`);
      fs.writeFileSync(file, JSON.stringify(progressObj, null, 2), 'utf-8');
      return;
    }
    const tmp = `${dirStr.processedUrlsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(progressObj, null, 2), 'utf8');
    fs.renameSync(tmp, dirStr.processedUrlsFile);
  } catch (err) {
    console.error(saveStoreProgress ? 'saveStoreProgress error:' : 'saveProgress error:', err.message);
  }
}

// -------------------- Fetching / Retry --------------------
async function fetchWithRetry(url, options = {}, maxRetries = 5, baseDelay = 10000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiRequest(url, { ...options, format: 'text' });
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed for ${url}:`, error.message);
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} attempts: ${lastError.message}`);
}

// -------------------- Get stores metadata / urls --------------------
function getStoresMetaDataOrUrls(type = "", filePath = "") {
  try {
    if (type === 'metaData') {
      const metaDataPath = filePath || path.join(dirStr.parsedHtmlDir, 'stores_metadata.json');
      const response = JSON.parse(fs.readFileSync(metaDataPath, 'utf-8'));
      const data = Array.isArray(response) ? response : (response.data || []);
      return Array.isArray(data) ? data : [];
    }
    if (type === 'urls') {
      const urlsPath = filePath || './urls.json';
      const data = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));
      if (data.urls && Array.isArray(data.urls)) {
        return data.urls.flatMap(obj => {
          const [postalCode, url] = Object.entries(obj)[0];
          return { [postalCode]: url };
        });
      }
      return Array.isArray(data) ? data : [];
    }
    throw new Error('Invalid type specified');
  } catch (error) {
    console.error(`Error in getStoresMetaDataOrUrls (type: ${type}):`, error.message);
    return [];
  }
}

// -------------------- Download main HTML pages --------------------
async function downloadMainHTMLPage() {
  console.log('Downloading main HTML pages...');
  try {
    const urlsData = getStoresMetaDataOrUrls('urls');
    const CONCURRENT_LIMITS = 3;
    const progressMap = loadProgress();
    const downloadedSet = new Set(
      Object.entries(progressMap).filter(([, v]) => v && v.downloaded).map(([k]) => k)
    );

    const urlsToProcess = urlsData.filter(urlObj => {
      const [postalCode] = Object.entries(urlObj)[0];
      return !downloadedSet.has(postalCode);
    });

    console.log(`Found ${urlsToProcess.length} new URLs to process.`);

    for (let i = 0; i < urlsToProcess.length; i += CONCURRENT_LIMITS) {
      const batch = urlsToProcess.slice(i, i + CONCURRENT_LIMITS);
      await Promise.all(batch.map(async (urlObj) => {
        let postalCode = 'UNKNOWN';
        let url = 'UNKNOWN';
        try {
          const entry = Object.entries(urlObj)[0];
          [postalCode, url] = entry;
          if (downloadedSet.has(postalCode)) return;

          console.log(`Downloading: ${postalCode}`);
          const scraper = new UberEatsScraper(url, { saveNet: false, downloadOnly: true, postalCode, outputDir: dirStr.rawHtmlDir });
          await scraper.run();

          progressMap[postalCode] = progressMap[postalCode] || {};
          progressMap[postalCode].downloaded = true;
          downloadedSet.add(postalCode);
        } catch (err) {
          fs.appendFileSync(dirStr.failedMainUrlsFile, `${new Date().toISOString()} - ${url} - ${err?.message || err}\n`);
        }
      }));
      saveProgress(progressMap);
      if (i + CONCURRENT_LIMITS < urlsToProcess.length) await sleep(10000);
    }

    console.log('✅ All main pages downloaded!');
  } catch (err) {
    console.error('Error downloadMainHTMLPage:', err);
  }
}

// -------------------- Process HTML files --------------------
async function processHTMLFile(htmlPath, outputDir) {
  try {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const postalCode = path.basename(htmlPath).split('_page_after_js.html')[0];
    const outputPath = path.join(outputDir, `${postalCode}_stores.json`);
    const restaurants = restroInfoExtractorFromAllStores(html);
    const validRestaurants = restaurants.filter(r => r.name);

    const processedData = {
      source: ['Uber Eats'],
      postalCode,
      timestamp: new Date().toISOString(),
      count: validRestaurants.length,
      data: validRestaurants
    };

    fs.writeFileSync(outputPath, JSON.stringify(processedData, null, 2));
    return { success: true, count: validRestaurants.length, file: outputPath };
  } catch (error) {
    console.error(`Error processing ${htmlPath}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function downloadAndProcessMainPages() {
  await downloadMainHTMLPage();
  const inputDir = dirStr.rawHtmlDir;
  const outputDir = dirStr.parsedHtmlDir;
  const progress = loadProgress();
  const processedSet = new Set(Object.entries(progress).filter(([_, v]) => v && v.processed).map(([k]) => k));
  const allFiles = fs.readdirSync(inputDir).filter(f => f.endsWith('_page_after_js.html'));
  const files = allFiles.filter(f => !processedSet.has(path.basename(f).split('_page_after_js.html')[0]));

  const CONCURRENCY = 3;
  const results = [];

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(file => processHTMLFile(path.join(inputDir, file), outputDir)));
    results.push(...batchResults);

    const progressMap = loadProgress();
    for (let idx = 0; idx < batch.length; idx++) {
      const postalCode = path.basename(batch[idx]).split('_page_after_js.html')[0];
      if (batchResults[idx].success) {
        progressMap[postalCode] = progressMap[postalCode] || {};
        progressMap[postalCode].processed = true;
      }
    }
    saveProgress(progressMap);
    if (i + CONCURRENCY < files.length) await sleep(2000);
  }

  return results;
}

async function uploadOrMergeStore(store, postalCodeDir, bucketName) {
  const restaurantId = store.restaurant_id;
  const safeFileName = `${restaurantId}.json`;
  const localFilePath = path.join(postalCodeDir, safeFileName);

  // S3 key
  const s3Key = `web-scraping/${safeFileName}`;
  let mergedStore = store;

  // 1️⃣ Check if file exists on S3
  if (await checkS3FileExists(bucketName, s3Key)) {
    // 2️⃣ Download existing S3 JSON
    const tmpDownloadPath = path.join(postalCodeDir, `tmp_${safeFileName}`);
    const downloadRes = await downloadFileFromS3(bucketName, s3Key, tmpDownloadPath);

    if (downloadRes.success) {
      const existingData = JSON.parse(fs.readFileSync(tmpDownloadPath, 'utf-8'));
      // 3️⃣ Merge existing data with new data
      mergedStore = mergeSourcesAndMenus(existingData, store);
      fs.unlinkSync(tmpDownloadPath); // cleanup temp file
      console.log(`🔄 Merged existing S3 data for store: ${restaurantId}`);
    }
  }

  // 4️⃣ Save locally
  fs.writeFileSync(localFilePath, JSON.stringify(mergedStore, null, 2), 'utf-8');

  // 5️⃣ Upload merged JSON to S3
  const uploadRes = await uploadJson(mergedStore, bucketName, s3Key);
  if (uploadRes.success) {
    console.log(`✅ Uploaded merged store to S3: ${restaurantId}`);
  } else {
    console.error(`❌ Failed to upload merged store: ${restaurantId}`, uploadRes.error);
  }

  return uploadRes.success;
}

export async function processStores(filePath = "", uploadOnS3ForStagingState = false, uploadOnS3ForRawState = false) {
  const storesMetadata = getStoresMetaDataOrUrls('metaData', filePath);
  const totalStores = storesMetadata.length;
  console.log(`Total stores to process: ${totalStores}`);
  if (totalStores === 0) return;

  const postalCode = path.basename(filePath).split('_stores')[0];
  const postalCodeDir = path.join('./data/processed_stores', postalCode);
  if (!fs.existsSync(postalCodeDir)) fs.mkdirSync(postalCodeDir, { recursive: true });

  const storeProgress = loadProgress(true, postalCode);
  let processedCount = 0;
  let skippedCount = 0;

  for (const storeData of storesMetadata) {
    await sleep(Math.random() * 2000); // gentle delay

    let store = null;
    let success = false;
    let uploadedOnS3Staging = storeProgress[storeData.name]?.uploadedOnS3Staging || false;

    try {
      // 1️⃣ Fetch HTML
      const html = await fetchWithRetry(storeData.url);

      // 2️⃣ Extract store
      store = extractUberEatsStore(html, true, true, storeData.deliveryTime, storeData.url, uploadOnS3ForRawState);

      if (!store || !store.restaurant_id) {
        console.error(`❌ Invalid store data for ${storeData.name}`);
        fs.appendFileSync(
          `${postalCodeDir}/${storeData.name}_Error.txt`,
          `Invalid store data received:\n${JSON.stringify(store, null, 2)}\n\n`
        );
        continue;
      }

      const restaurantId = store.restaurant_id;

      // 3️⃣ Skip if already processed & uploaded
      if (storeProgress[restaurantId]?.processed && (!uploadOnS3ForStagingState || uploadedOnS3Staging)) {
        skippedCount++;
        console.log(`⏩ Skipping already processed & uploaded store: ${restaurantId} | Skipped: ${skippedCount}`);
        continue;
      }

      // 4️⃣ Upload / merge with S3
      if (uploadOnS3ForStagingState) {
        uploadedOnS3Staging = await uploadOrMergeStore(store, postalCodeDir, process.env.AWS_BUCKET_NAME);
      } else {
        // save locally if not uploading to S3
        const safeFileName = `${restaurantId}.json`;
        fs.writeFileSync(path.join(postalCodeDir, safeFileName), JSON.stringify(store, null, 2), 'utf-8');
      }

      success = true;
      processedCount++;

    } catch (error) {
      console.error(`❌ Error processing ${storeData.name}:`, error?.message);
      fs.appendFileSync(
        './failed_store_urls.log',
        `${new Date().toISOString()} - ${storeData.url} - ${error.stack || error}\n`
      );
    } finally {
      const restaurantId = store?.restaurant_id || storeData.name.replace(/\s+/g, '_');
      storeProgress[restaurantId] = { processed: success, uploadedOnS3Staging };
      saveProgress(storeProgress, true, postalCode);
    }

    await sleep(15000 + Math.floor(Math.random() * 15000)); // gentle delay between stores
  }

  console.log(`✅ Completed processing stores for postal code: ${postalCode}`);
  console.log(`Processed: ${processedCount}, Skipped: ${skippedCount}, Total: ${totalStores}`);
}
// -------------------- Process individual stores with merge from S3 --------------------
async function processStoress(filePath = "", uploadOnS3ForStagingState = false, uploadOnS3ForRawState = false) {
    const storesMetadata = getStoresMetaDataOrUrls('metaData', filePath);
    const totalStores = storesMetadata.length;
    console.log(`Total stores to process: ${totalStores}`);
    if (totalStores === 0) return;

    const postalCode = path.basename(filePath).split('_stores')[0];
    const postalCodeDir = path.join(dirStr.processed_stores, postalCode);
    if (!fs.existsSync(postalCodeDir)) fs.mkdirSync(postalCodeDir, { recursive: true });

    const storeProgress = loadProgress(true, postalCode);
    let processedCount = 0;
    let skippedCount = 0;

    for (const storeData of storesMetadata) {
        await sleep(Math.random() * 2000); // gentle delay

        let store = null;
        let success = false;
        let uploadedOnS3Staging = storeProgress[storeData.name]?.uploadedOnS3Staging || false;

        try {
            const html = await fetchWithRetry(storeData.url);
            store = extractUberEatsStore(html, true, true, storeData.deliveryTime, storeData.url, uploadOnS3ForRawState);

            if (!store || !store.restaurant_id) {
                console.error(`❌ Invalid store data for ${storeData.name}`);
                fs.appendFileSync(`${postalCodeDir}/${storeData.name}_Error.txt`, `Invalid store data received:\n${JSON.stringify(store, null, 2)}\n\n`);
                continue;
            }

            const restaurantId = store.restaurant_id;
            const safeFileName = `${restaurantId}.json`;
            const fileName = path.join(postalCodeDir, safeFileName);

            if (storeProgress[restaurantId]?.processed && (!uploadOnS3ForStagingState || uploadedOnS3Staging)) {
                skippedCount++;
                console.log(`⏩ Skipping already processed & uploaded store: ${restaurantId} | Skipped: ${skippedCount}`);
                continue;
            }

            // ✅ Save locally in proper JSON format
            fs.writeFileSync(fileName, JSON.stringify(store, null, 2), 'utf-8');
            console.log(`✅ Processed store: ${restaurantId}`);
            success = true;
            processedCount++;

            // ✅ Upload to S3
            if (uploadOnS3ForStagingState && !uploadedOnS3Staging && success) {
                const s3Key = `web-scraping/${safeFileName}`;
                const res = await uploadJson(store, dirStr.s3BucketName, s3Key); // pass object, not string

                console.log("res",res);
                
                if (res.success) {
                    uploadedOnS3Staging = true;
                    console.log(`✅ Uploaded to S3: ${restaurantId}`);
                }
                await sleep(5000); // small delay after upload
            }

        } catch (error) {
            console.error(`❌ Error processing ${storeData.name}:`, error?.message);
            fs.appendFileSync(
                dirStr.failedStoreUrlsFile,
                `${new Date().toISOString()} - ${storeData.url} - ${error.stack || error}\n`
            );
        } finally {
            const restaurantId = store?.restaurant_id || storeData.name.replace(/\s+/g, '_');
            storeProgress[restaurantId] = { processed: success, uploadedOnS3Staging };
            saveProgress(storeProgress, true, postalCode);
        }

        await sleep(15000 + Math.floor(Math.random() * 15000));
    }

    console.log(`✅ Completed processing stores for postal code: ${postalCode}`);
    console.log(`Processed: ${processedCount}, Skipped: ${skippedCount}, Total: ${totalStores}`);
}


// -------------------- Pipeline --------------------
async function pipeline() {
  console.log('🚀 Starting pipeline...');
  try {
    console.log('📥 Step 1: Download and process main pages');
    const processResults = await downloadAndProcessMainPages();

    console.log('📊 Step 2: Process individual stores with S3 merge');
    const parsedFiles = fs.readdirSync(dirStr.parsedHtmlDir).filter(f => f.endsWith('.json'));
    for (const file of parsedFiles) {
      await processStores(path.join(dirStr.parsedHtmlDir, file), true);
    }

    console.log('🎉 Pipeline completed successfully!');
  } catch (err) {
    console.error('❌ Pipeline failed:', err);
  }
}

// -------------------- Run --------------------
(async () => {
  await pipeline();
})();
