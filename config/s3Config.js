// config/s3Config.js
import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
  override: true,
});

const REGION = process.env.AWS_REGION || "us-east-1";
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

if (!BUCKET_NAME) throw new Error("❌ AWS_BUCKET_NAME is not set in .env");

const s3Client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export { s3Client, BUCKET_NAME, REGION };
