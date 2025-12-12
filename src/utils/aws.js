// src/utils/aws.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { pipeline } from "stream";
import { promisify } from "util";

import {
  DynamoDBClient,
  ScanCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";

const pipe = promisify(pipeline);

// -------------------- Load .env --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") }); // adjust path to your .env

// -------------------- Debug loaded env --------------------
console.log("🔹 AWS_REGION:", process.env.AWS_REGION || "❌ missing");
console.log("🔹 AWS_BUCKET_NAME:", process.env.AWS_BUCKET_NAME || "❌ missing");
console.log("🔹 AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID ? "loaded" : "❌ missing");
console.log("🔹 AWS_SECRET_ACCESS_KEY:", process.env.AWS_SECRET_ACCESS_KEY ? "loaded" : "❌ missing");
console.log("🔹 DYNAMO_TABLE_NAME:", process.env.DYNAMO_TABLE_NAME || "❌ missing");

// -------------------- Check mandatory vars --------------------
if (
  !process.env.AWS_REGION ||
  !process.env.AWS_BUCKET_NAME ||
  !process.env.AWS_ACCESS_KEY_ID ||
  !process.env.AWS_SECRET_ACCESS_KEY
) {
  throw new Error(
    "❌ Missing AWS credentials or bucket name. Check your .env file and dotenv path!"
  );
}

// -------------------- DynamoDB Setup --------------------
export const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || "scrapping_restaurant_essentials";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const docClient = DynamoDBDocumentClient.from(client);

// -------------------- DynamoDB Helpers --------------------
export async function upsertRestaurant(item) {
  if (!item || !item.restaurant_id) throw new Error("Missing restaurant_id");

  try {
    await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    console.log(`✅ Saved/Updated ${item.restaurant_name || item.restaurant_id} → DynamoDB`);
  } catch (err) {
    console.error("❌ DynamoDB upsert error:", err.message, "Item:", item);
  }
}

export async function getAllRestaurants(limit = 1000) {
  try {
    const data = await docClient.send(new ScanCommand({ TableName: TABLE_NAME, Limit: limit }));
    return data.Items || [];
  } catch (err) {
    console.error("❌ DynamoDB scan error:", err.message);
    return [];
  }
}

export async function getRestaurantById(restaurant_id) {
  if (!restaurant_id) throw new Error("Missing restaurant_id");

  try {
    const data = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { restaurant_id } }));
    return data.Item || null;
  } catch (err) {
    console.error(`❌ DynamoDB get error for ${restaurant_id}:`, err.message);
    return null;
  }
}

// -------------------- S3 Setup --------------------
export const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
export const S3_BUCKET = process.env.AWS_BUCKET_NAME;

// -------------------- S3 Helpers --------------------
export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch {
    await s3.send(
      new CreateBucketCommand({
        Bucket: S3_BUCKET,
        CreateBucketConfiguration:
          process.env.AWS_REGION === "us-east-1" ? undefined : { LocationConstraint: process.env.AWS_REGION },
      })
    );
    console.log(`✅ Bucket created: ${S3_BUCKET}`);
  }
}

export async function s3Exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (err) {
    return err.name === "NotFound" || err.$metadata?.httpStatusCode === 404 ? false : false;
  }
}

export async function downloadFromS3(key, destination) {
  const response = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  await pipe(response.Body, fs.createWriteStream(destination));
  return JSON.parse(fs.readFileSync(destination, "utf-8"));
}

export async function uploadToS3(filePath, key) {
  await ensureBucket();
  const data = fs.readFileSync(filePath);
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: data, ContentType: "application/json" }));
  console.log(`📤 Uploaded ${filePath} → S3: ${key}`);
}

export async function deleteFromS3(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  console.log(`🗑 Deleted old S3 file: ${key}`);
}
