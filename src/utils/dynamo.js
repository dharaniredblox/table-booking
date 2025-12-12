import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const TABLE_NAME = process.env.DYNAMO_TABLE_NAME;

// ---------- New Table for Table Booking URLs ----------
export const BOOKING_TABLE_NAME = process.env.DYNAMO_BOOKING_TABLE_NAME;


const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "eu-west-2",
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

export const docClient = DynamoDBDocumentClient.from(client);

// ---------- Upsert ----------
export async function upsertRestaurant(item, retries = 3) {
  if (!item || !item.restaurant_id) throw new Error("Missing restaurant_id");
  while (retries > 0) {
    try {
      await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
      console.log(`✅ Upserted ${item.restaurant_name || item.restaurant_id}`);
      return;
    } catch (err) {
      retries--;
      console.error(`❌ DynamoDB error: ${err.message}. Retries left: ${retries}`);
      if (retries > 0) await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

// ---------- Scan ----------
export async function getAllRestaurants(limit = 1000) {
  const scanParams = { TableName: TABLE_NAME, Limit: limit };
  let items = [];
  let lastKey;
  do {
    if (lastKey) scanParams.ExclusiveStartKey = lastKey;
    const res = await docClient.send(new ScanCommand(scanParams));
    items = items.concat(res.Items || []);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey && items.length < limit);
  return items.slice(0, limit);
}

// ---------- Update Scrape Status ----------
export async function updateRestaurantStatus(restaurant_id, status) {
  if (!restaurant_id) throw new Error("Missing restaurant_id for status update");

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { restaurant_id },
        UpdateExpression:
          "SET ubereats_scraped_at = :scrapedAt, ubereats_scraping_status = :status",
        ExpressionAttributeValues: {
          ":scrapedAt": new Date().toISOString(),
          ":status": status,
        },
      })
    );
    console.log(`✅ Updated status for ${restaurant_id}: ${status}`);
  } catch (err) {
    console.error(`⚠️ Failed to update status for ${restaurant_id}: ${err.message}`);
  }
}


// ---------- New Table for Table Booking URLs ----------




// export async function upsertTableBooking(item) {
//   // console.log("BOOKING_TABLE_NAME......",BOOKING_TABLE_NAME);
  
//   const restaurant_id = item.restaurant_id || item.restaurantId;
//   // console.log("restaurant_id",restaurant_id);
  
//   if (!restaurant_id) throw new Error("Missing restaurant_id for table booking upsert");

//   await docClient.send(
//     new PutCommand({
//       TableName: BOOKING_TABLE_NAME,
//       Item: { ...item, restaurant_id },
//     })
//   );
//   console.log(`✅ Upserted Booking URL for ${restaurant_id}`);
// }

/**
 * Upsert a booking URL item into booking table (Opentable)
 * - Merge if item exists, else insert new
 */

export async function upsertTableBooking(item) {
  const restaurant_id = item.restaurant_id || item.restaurantId;
  if (!restaurant_id) throw new Error("Missing restaurant_id for table booking upsert");

  try {
    // Check if restaurant already exists
    const existing = await docClient.send(
      new GetCommand({
        TableName: BOOKING_TABLE_NAME,
        Key: { restaurant_id },
      })
    );

    if (existing.Item) {
      // Merge existing fields with new data
      const mergedItem = {
        ...existing.Item,
        ...item,
        quandoo_updated_at: new Date().toISOString(),
      };

      await docClient.send(
        new PutCommand({
          TableName: BOOKING_TABLE_NAME,
          Item: mergedItem,
        })
      );
      console.log(`✅ Merged & updated Opentable restaurant: ${restaurant_id}`);
    } else {
      // Insert as new
      await docClient.send(
        new PutCommand({
          TableName: BOOKING_TABLE_NAME,
          Item: { ...item, restaurant_id,quandoo_updated_at: new Date().toISOString() },
        })
      );
      console.log(`✅ Inserted new Opentable restaurant: ${restaurant_id}`);
    }
  } catch (err) {
    console.error(`❌ Failed to upsert Opentable restaurant: ${restaurant_id}`, err);
  }
}


/**
 * Update scrape status (booking table) for a restaurant_id
 */

export async function updateScrapeStatus(restaurant_id, status) {
  if (!restaurant_id) throw new Error("Missing restaurant_id for status update");

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: process.env.DYNAMO_BOOKING_TABLE_NAME,
        Key: { restaurant_id },
        UpdateExpression: "SET quandoo_status = :status, quandoo_scraped_at = :scrapedAt",
        // ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":scrapedAt": new Date().toISOString(),
        },
      })
    );
    console.log(`✅ Updated status for ${restaurant_id}: ${status}`);
  } catch (err) {
    console.error(`⚠️ Failed to update status for ${restaurant_id}: ${err.message}`);
  }
}


export async function scanDynamoTable(params) {
  const items = [];
  let lastEvaluatedKey;
  do {
    const data = await client.send(
      new ScanCommand({
        ...params,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    if (data.Items) items.push(...data.Items);
    lastEvaluatedKey = data.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}


