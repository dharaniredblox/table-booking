import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import path from "path";

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

let client;
let db;

export async function getDb() {
  if (db) return db;

  const MONGO_URI = process.env.MONGO_URI;
  const MONGO_DB_NAME = process.env.MONGO_DB_NAME;

  if (!MONGO_URI || !MONGO_DB_NAME) {
    console.error("❌ Missing MongoDB URI or DB name in .env");
    process.exit(1);
  }

  try {
    client = new MongoClient(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    await client.connect();
    db = client.db(MONGO_DB_NAME);
    console.log(`✅ Connected to MongoDB: ${MONGO_DB_NAME}`);
    return db;
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  }
}

export async function closeMongo() {
  if (client) {
    await client.close();
    console.log("🔒 MongoDB connection closed");
  }
}
