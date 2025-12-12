import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI || 'mongodb://localhost:27017';
const client = new MongoClient(uri);

let db;

export async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db('ubereats'); // your DB name
    console.log('✅ Connected to MongoDB: ubereats');
  }
  return db;
}

export async function insertOrUpdateStore(store) {
  const database = await connectDB();
  const collection = database.collection('stores'); // collection name
  const filter = { restaurant_id: store.restaurant_id };
  const updateDoc = { $set: store };
  const options = { upsert: true };
  await collection.updateOne(filter, updateDoc, options);
}
