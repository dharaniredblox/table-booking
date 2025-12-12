import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  uploadJsonByRestaurantId,
  deleteJsonByRestaurantId,
  downloadJsonByRestaurantId,
  checkIfJsonExists
} from "./utils/s3Uploader.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUCKET_NAME = "data-extractions-scraping";

async function run() {
  const filePath = path.resolve(__dirname, "../justeat-scrapeUrl/scraping/merged/restaurants_source_merged.json");
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  const restaurantId = Array.isArray(data) ? data[0].restaurant_id : data.restaurant_id;

  // Upload (deletes old first)
  const uploadResult = await uploadJsonByRestaurantId(data, BUCKET_NAME, "justeats");
  console.log("Upload Result:", uploadResult);

  // Check existence
  const exists = await checkIfJsonExists(restaurantId, BUCKET_NAME, "justeats");
  console.log(`File exists? ${exists}`);

  // Download file
  const downloadPath = path.resolve(__dirname, "../downloaded.json");
  const downloadResult = await downloadJsonByRestaurantId(restaurantId, BUCKET_NAME, downloadPath, "justeats");
  console.log("Download Result:", downloadResult);

  // Delete file
  // const deleteResult = await deleteJsonByRestaurantId(restaurantId, BUCKET_NAME, "justeats");
  // console.log("Delete Result:", deleteResult);
}

run().catch(console.error);
