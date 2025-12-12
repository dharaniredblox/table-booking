import { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

const region = process.env.AWS_REGION || "us-east-1";
const bucket = process.env.AWS_BUCKET_NAME;

const s3 = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log("✅ Bucket already exists:", bucket);
  } catch {
    console.log("⚠️ Bucket not found, creating:", bucket);
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: region === "us-east-1" ? undefined : { LocationConstraint: region },
      })
    );
    console.log("✅ Bucket created:", bucket);
  }
}

export async function uploadToS3(fileName, data) {
  await ensureBucket();

  const params = {
    Bucket: bucket,
    Key: `restaurants/${fileName}`,
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json",
  };

  try {
    await s3.send(new PutObjectCommand(params));
    const url = `https://${bucket}.s3.${region}.amazonaws.com/${params.Key}`;
    console.log(`✅ Uploaded ${fileName} to S3: ${url}`);
    return url;
  } catch (err) {
    console.error("❌ S3 upload error:", err.message);
  }
}
