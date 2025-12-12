import { saveToMongo } from "./db.js";
import { scrape } from "./mcdonals_Extractor.js";

export async function main() {
  const fileName = process.argv[2];
  const output = await scrape(fileName);
  await saveToMongo(output);
}

