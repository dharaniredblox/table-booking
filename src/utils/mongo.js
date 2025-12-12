import { MongoClient } from "mongodb";

const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const client = new MongoClient(uri);
let connected = false;

export async function getDb() {
  if (!connected) {
    await client.connect();
    connected = true;
    console.log("✅ Connected to MongoDB");
  }
  return client.db("justeat");
}

export async function closeMongo() {
  if (connected) {
    await client.close();
    connected = false;
    console.log("🧹 MongoDB connection closed");
  }
}
