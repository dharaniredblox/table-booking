import fs from "fs";
import { 
  PutObjectCommand, 
  DeleteObjectCommand, 
  GetObjectCommand, 
  ListObjectsV2Command 
} from "@aws-sdk/client-s3";
import { s3Client } from "../../config/s3Config.js";
import { pipeline } from "stream";
import { promisify } from "util";
const streamPipeline = promisify(pipeline);

/**
 * Upload or Update JSON file using restaurant_id as file name
 * Deletes existing file before uploading if found
 * @param {Object|Array} data - JSON data (object or array)
 * @param {string} bucketName
 * @param {string} folder
 * @returns {Promise<Object>}
 */
async function uploadJsonByRestaurantId(data, bucketName, folder = "justeats") {
  let restaurantId;
  if (Array.isArray(data)) {
    restaurantId = data[0]?.restaurant_id;
  } else {
    restaurantId = data.restaurant_id;
  }

  if (!restaurantId) {
    return { success: false, error: "restaurant_id not found in JSON" };
  }

  const key = `${folder}/${restaurantId}.json`;

  try {
    // 1. Check if file exists
    const exists = await checkIfJsonExists(restaurantId, bucketName, folder);

    // 2. Delete old file if exists
    if (exists) {
      await deleteJsonByRestaurantId(restaurantId, bucketName, folder);
      console.log(`Old file ${key} deleted`);
    }

    // 3. Upload new file
    const params = {
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    };

    const command = new PutObjectCommand(params);
    await s3Client.send(command);

    const url = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`;

    return { success: true, url, key, message: "JSON uploaded successfully (replaced if existed)" };
  } catch (error) {
    return { success: false, error: error.message, key };
  }
}

/**
 * Delete JSON file by restaurant_id
 */
async function deleteJsonByRestaurantId(restaurantId, bucketName, folder = "justeats") {
  const key = `${folder}/${restaurantId}.json`;
  try {
    const command = new DeleteObjectCommand({ Bucket: bucketName, Key: key });
    await s3Client.send(command);
    return { success: true, key, message: "File deleted successfully" };
  } catch (error) {
    return { success: false, key, error: error.message };
  }
}

/**
 * Download JSON file by restaurant_id
 */
async function downloadJsonByRestaurantIdss(restaurantId, bucketName, downloadPath, folder = "justeats") {
  const key = `${folder}/${restaurantId}.json`;
  try {
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    const response = await s3Client.send(command);
    await streamPipeline(response.Body, fs.createWriteStream(downloadPath));
    return { success: true, path: downloadPath, key, message: "File downloaded successfully" };
  } catch (error) {
    return { success: false, key, error: error.message };
  }
}

/**
 * Check if file exists by restaurant_id
 */
async function checkIfJsonExists(restaurantId, bucketName, folder = "justeats") {
  const key = `${folder}/${restaurantId}.json`;
  try {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: key,
      MaxKeys: 1,
    });
    const response = await s3Client.send(command);
    return response.Contents?.length > 0;
  } catch (error) {
    console.error("checkIfJsonExists error:", error);
    return false;
  }
}

export {
  uploadJsonByRestaurantId,
  deleteJsonByRestaurantId,
  downloadJsonByRestaurantId,
  checkIfJsonExists,
};
