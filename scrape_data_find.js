import dotenv from "dotenv";
dotenv.config();

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import fs from "fs";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "eu-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function getRecentlyScrapedCities() {
  const TABLE = "restaurant_url_scrapper";

  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);

  console.log("threeDaysAgo",threeDaysAgo);
  
  const threeDaysAgoISO = threeDaysAgo.toISOString();

  console.log("🔍 Checking items scraped in last 3 days...");
  console.log("From:", threeDaysAgoISO);

  const result = await client.send(
    new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: "city_name, justeat_scraped_at, restaurant_id"
    })
  );

  if (!result.Items || result.Items.length === 0) {
    console.log("❌ No items found.");
    return;
  }

  // Normalize DynamoDB format
  const cleaned = result.Items.map(item => ({
    restaurant_id: item.restaurant_id?.S,
    city: item.city_name?.S,
    scrapedAt: item.justeat_scraped_at?.S
      ? new Date(item.justeat_scraped_at.S)
      : null,
  })).filter(x => x.scrapedAt !== null);

  // Filter last 3 days
  const recent = cleaned.filter(x => x.scrapedAt >= threeDaysAgo);

  // Sort by time (oldest → newest)
  recent.sort((a, b) => a.scrapedAt - b.scrapedAt);

  console.log("\n========== 📅 LAST 3 DAYS SCRAPED CITY LIST ==========\n");

  recent.forEach((r, i) => {
    console.log(
      `${i + 1}. city: ${r.city} — scrapedAt: ${r.scrapedAt.toISOString()} — restaurant_id: ${r.restaurant_id}`
    );
  });

  console.log(`\n✅ Total: ${recent.length} cities scraped in last 3 days\n`);

  // -----------------------------
  // SAVE JSON (Optional)
  // -----------------------------
  const output = {
    generated_at: new Date().toISOString(),
    total: recent.length,
    data: recent.map(r => ({
      restaurant_id: r.restaurant_id,
      city: r.city,
      scrapedAt: r.scrapedAt.toISOString(),
    }))
  };

  fs.writeFileSync("recent_cities.json", JSON.stringify(output, null, 2));
  console.log("💾 Saved → recent_cities.json");
}

getRecentlyScrapedCities();
