// src/utils/dynamo.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || "";
export const BOOKING_TABLE_NAME = process.env.DYNAMO_BOOKING_TABLE_NAME || "";
console.log("BOOKING_TABLE_NAME",BOOKING_TABLE_NAME)

if (!process.env.AWS_REGION) {
  console.error("❌ AWS_REGION missing in .env");
}

// Create a DynamoDB v3 client; credentials are picked up automatically from env/instance role
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "eu-west-2",
});

export const docClient = DynamoDBDocumentClient.from(client);

/**
 * Scan the booking table and return all items (paginated).
 * @param {string} bookingTableName
 * @param {number} [limitPerScan]
 * @returns {Promise<Array>}
 */


// ---------- UPSERT FUNCTION ----------
export async function upsertRestaurant(restaurantDoc) {
  const { restaurant_id } = restaurantDoc;
  if (!restaurant_id) {
    console.error("⚠️ Missing restaurant_id");
    return;
  }

  try {
    // Get existing record if any
    const existing = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { restaurant_id },
      })
    );

    const oldData = existing.Item || {};

    // ✅ Merge old + new data dynamically
    const mergedDoc = {
      ...oldData,
      ...restaurantDoc,
      updated_at: new Date().toISOString(),
    };

    // ✅ Save merged data (upsert)
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: mergedDoc,
      })
    );

    console.log(`✅ Upserted restaurant: ${restaurant_id}`);
  } catch (err) {
    console.error(`❌ Failed to upsert restaurant: ${restaurant_id}`, err);
  }
}

// ---------- FETCH ALL ----------
export async function getAllRestaurants(limit) {

  try {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAME, Limit: limit })
    );
    return result.Items || [];
  } catch (err) {
    console.error("❌ DynamoDB scan error:", err.message);
    return [];
  }
}


export async function getAllBookingItems(bookingTableName = BOOKING_TABLE_NAME, limitPerScan = 100) {
  if (!bookingTableName) throw new Error("Missing booking table name");
  const items = [];
  let ExclusiveStartKey = undefined;

  try {
    do {
      const res = await docClient.send(
        new ScanCommand({
          TableName: bookingTableName,
          Limit: limitPerScan,
          ExclusiveStartKey,
        })
      );
      if (res.Items) items.push(...res.Items);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);

     console.log(`📦 Loaded ${items.length} booking items`);
  } catch (err) {
    console.error("❌ Error scanning booking table:", err.message);
  }

  return items;
}

/**
 * Generic scan for an arbitrary table using params
 */
export async function scanDynamoTable(params) {
  const items = [];
  let lastEvaluatedKey;
  try {
    do {
      const data = await docClient.send(
        new ScanCommand({
          ...params,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );
      if (data.Items) items.push(...data.Items);
      lastEvaluatedKey = data.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  } catch (err) {
    console.error("❌ scanDynamoTable error:", err.message);
  }
  return items;
}

/**
 * Upsert a booking URL item into booking table
 */

// export async function upsertTableBooking(item) {
//   const restaurant_id = item.restaurant_id || item.restaurantId;
//   if (!restaurant_id) throw new Error("Missing restaurant_id for table booking upsert");

//   try {
//     await docClient.send(
//       new PutCommand({
//         TableName: BOOKING_TABLE_NAME,
//         Item: { ...item, restaurant_id ,
//         },
//       })
//     );
//     console.log(`✅ Upserted Booking URL for ${restaurant_id}`);
//   } catch (err) {
//     console.error(`❌ upsertTableBooking failed for ${restaurant_id}:`, err.message);
//     throw err;
//   }
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
        restaurant_id,
        opentable_updated_at: new Date().toISOString(),
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
          Item: { ...item, restaurant_id,opentable_updated_at: new Date().toISOString() },
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
         UpdateExpression: "SET opentable_status = :status, opentable_scraped_at = :scrapedAt",
        // ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":scrapedAt": new Date().toISOString(),
        },
        ConditionExpression: "attribute_exists(restaurant_id)", // ✅ prevents overwriting new
      })
    );
    console.log(`✅ Updated status for ${restaurant_id}: ${status}`);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.warn(
        `⚠️ Skipped status update — item not found for ${restaurant_id}`
      );
    } else {
      console.error(
        `⚠️ Failed to update status for ${restaurant_id}: ${err.message}`
      );
    }
  }
}


/**
 * Small helper: get a single item by key (optional)
 */
export async function getItemByKey(tableName, key) {
  try {
    const res = await docClient.send(new GetCommand({ TableName: tableName, Key: key }));
    return res.Item || null;
  } catch (err) {
    console.error("❌ getItemByKey error:", err.message);
    return null;
  }
}
