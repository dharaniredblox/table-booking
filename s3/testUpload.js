import { readFileSync } from "fs";
import { uploadToS3 } from "./s3Uploader.js";

async function run() {
  // Read the JSON you generated in extract-json.js
  const jsonContent = readFileSync("./justeat/extract_restaurant.json", "utf-8");
  const restaurantData = JSON.parse(jsonContent);

  // Upload to S3
  const url = await uploadToS3("extract_restaurant.json", restaurantData);
  console.log("🌍 File accessible at:", url);
}

run();
