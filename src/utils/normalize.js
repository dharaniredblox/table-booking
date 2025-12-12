// ---------------------------
// Normalize latitude & longitude
// ---------------------------
export function normalizeLatLon(lat, lon, precision = 3) {
  const normLat = lat != null ? Number(lat).toFixed(precision) : "0.000";
  const normLon = lon != null ? Number(lon).toFixed(precision) : "0.000";
  return { normLat, normLon };
}

// ---------------------------
// Clean restaurant name
// ---------------------------
function cleanRestaurantName(rawName, cityName) {
  if (!rawName) return "unknown";

  let name = rawName;

  // Remove everything after "-" or "("
  name = name.split(" - ")[0];
  name = name.split("(")[0];

  // Remove trailing city name if present
  if (cityName) {
    const regexCity = new RegExp(`\\b${cityName}\\b`, "i");
    name = name.replace(regexCity, "");
  }

  // Remove trailing numbers
  name = name.replace(/\d+$/, "").trim();

  // Remove any remaining special characters
  name = name.replace(/[^\w\s]/g, "").trim();

  // Collapse multiple spaces
  name = name.replace(/\s+/g, " ").trim();

  return name;
}


// ---------------------------
// Generate restaurant ID
// ---------------------------
export function generateRestaurantId(rawName, postalCode, latitude, cityName) {
  if (!rawName || !postalCode || !latitude) {
    return "unknown-restaurant";
  }

  const cleanedName = cleanRestaurantName(rawName, cityName);
  // console.log("cleanedNamecleanedName....",cleanedName);
  
  const normalized = cleanedName.toLowerCase().replace(/[^a-z0-9]/g, "");
  // console.log("normalizedn name", normalized);
  
  const safePostal = postalCode?.replace(/\s+/g, "").toUpperCase() || "NA";
  console.log("safePostal",safePostal);
  
  const latInt = latitude != null ? Math.floor(latitude) : 0;

  // console.log("latInt",latInt);
  

  return `${normalized}_${safePostal}_${latInt}`;
}

