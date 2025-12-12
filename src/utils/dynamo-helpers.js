// src/utils/dynamo-helpers.js
import { docClient, TABLE_NAME } from "./dynamo.js";
import { PutCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

export async function upsertRestaurant(item) {
  if (!item || !item.restaurant_id) throw new Error("Missing restaurant_id for DynamoDB item");

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
