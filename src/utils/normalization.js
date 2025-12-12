import { parsePhoneNumberFromString } from 'libphonenumber-js';
import geohash from 'ngeohash';

class Normalizer {
  constructor() {
    // map of common abbreviations for name normalization
    this.abbreviationMap = {
      'st': 'street',
      'rd': 'road',
      'ave': 'avenue',
      'blvd': 'boulevard',
      'ln': 'lane',
      'dr': 'drive',
      'pl': 'place'
      // add more as needed
    };
  }

  /**
   * Normalize phone number to E.164
   * @param {string} phone
   * @param {string} defaultCountry - optional default country code, e.g., 'GB'
   * @returns {string|null} E.164 phone or null if invalid
   */
  normalizePhone(phone, defaultCountry = 'GB') {
    if (!phone) return null;
    try {
      const parsed = parsePhoneNumberFromString(phone, defaultCountry);
      if (parsed && parsed.isValid()) {
        return parsed.number; // E.164 format
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Normalize restaurant name
   * - lowercase, ASCII only, remove punctuation
   * - expand common abbreviations
   * - collapse multiple spaces
   * @param {string} name
   */
  normalizeName(name) {
    if (!name) return '';
    let n = name.toLowerCase();

    // remove punctuation
    n = n.replace(/[^\w\s]/g, '');

    // expand abbreviations
    Object.keys(this.abbreviationMap).forEach(abbr => {
      const regex = new RegExp(`\\b${abbr}\\b`, 'g');
      n = n.replace(regex, this.abbreviationMap[abbr]);
    });

    // collapse multiple spaces
    n = n.replace(/\s+/g, ' ').trim();

    return n;
  }

  /**
   * Normalize postal code
   * - remove spaces, uppercase
   */
  normalizePostal(postal) {
    if (!postal) return '';
    return postal.replace(/\s+/g, '').toUpperCase();
  }

  /**
   * Round latitude/longitude to 5 decimal places
   */
  roundLatLng(lat, lng) {
    if (lat == null || lng == null) return { lat: null, lng: null };
    return {
      lat: Number(lat.toFixed(5)),
      lng: Number(lng.toFixed(5))
    };
  }

  /**
   * Generate geohash from lat/lng rounded to 5 decimal places
   */
  generateGeohash(lat, lng) {
    if (lat == null || lng == null) return null;
    const { lat: rlat, lng: rlng } = this.roundLatLng(lat, lng);
    // precision 8 is ~19 meters; adjust as needed
    return geohash.encode(rlat, rlng, 6);
  }
}

const normalizer = new Normalizer();
export {
    normalizer,
}

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

// export function generateRestaurantId(name, postalCode, latitude) {
//   console.log("postalCode",postalCode);
  
//   if (!name || !postalCode || !latitude) {
//     return "unknown-restaurant";
//   }

//   // Take everything before the first "-" if it exists, else before the first space
//   let firstPart;
//   if (name.includes(" - ")) {
//     firstPart = name.split(" - ")[0];
//   } else {
//     firstPart = name.split(/\s+/)[0];
//   }

//   // Normalize: lowercase, remove special chars
//   const normalized = firstPart.toLowerCase().replace(/[^a-z0-9]/g, "");

//   // Use first 6 characters of postal, rounded latitude
//   const latInt = latitude != null ? Math.floor(latitude) : 0;
//   const safePostal = postalCode?.replace(/\s+/g, "").toUpperCase() || "NA";

//   return `${normalized}_${safePostal}_${latInt}`;
// }


export function generateRestaurantId(rawName, postalCode, latitude, cityName) {
  if (!rawName || !postalCode || !latitude) {
    return "unknown-restaurant";
  }

  const cleanedName = cleanRestaurantName(rawName, cityName);
  const normalized = cleanedName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const safePostal = postalCode?.replace(/\s+/g, "").toUpperCase() || "NA";
  const latInt = latitude != null ? Math.floor(latitude) : 0;

  return `${normalized}_${safePostal}_${latInt}`;
}
