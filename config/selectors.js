// Centralized selectors with clear purpose-based names.
// NOTE: Uber Eats classes are highly dynamic; prefer resilient attributes/text where possible.
// For each entry: css (primary), xpath (fallback), notes (stability/i18n), context (state conditions).

const selectors = {
  restaurant: {
    // Hero/cover image shown at the top of the restaurant page
    heroImage: {
      css: "div img[loading='eager'][fetchpriority='high'], div img[decoding='sync']",
      xpath: "//div//img[@loading='eager' or @fetchpriority='high' or @decoding='sync']",
      notes: "Hero image container in header. Classes change frequently; use image attributes. May include multiple sources via srcset.",
      context: "Restaurant landing page (delivery/pickup both)."
    },
    // Dynamic hero/heading container (class token toggles among h8/h9/ha per reload)
    // Prefer explicit token list for CSS; XPath uses starts-with + length guard.
    heroContainer: {
      css: "div.h8, div.h9, div.ha",
      xpath: "//div[contains(concat(' ', normalize-space(@class), ' '), ' h8 ') or contains(concat(' ', normalize-space(@class), ' '), ' h9 ') or contains(concat(' ', normalize-space(@class), ' '), ' ha ')]",
      notes: "Top-level colored/hero block wrapper. Class token pattern h{n} where n ∈ {8,9,a}; changes across reloads.",
      context: "Visible near top of restaurant page as green/colored block behind title."
    },
    // Header info block inside hero container (child with class token 'id')
    headerInfo: {
      css: "div.h8 > div.id, div.h9 > div.id, div.ha > div.id, div.id",
      xpath: "(//div[(contains(concat(' ', normalize-space(@class), ' '), ' h8 ') or contains(concat(' ', normalize-space(@class), ' '), ' h9 ') or contains(concat(' ', normalize-space(@class), ' '), ' ha '))]//div[contains(concat(' ', normalize-space(@class), ' '), ' id ')])[1]",
      notes: "Container holding name, ratings, cuisines, price symbol, availability, and address line. Falls back to any 'div.id' if hero token not matched.",
      context: "Direct descendant within heroContainer."
    },
    // Restaurant description paragraph block ("About" style blurb)
    description: {
      css: "div.db.e4.ec.de.b1.iu.iv.dv",
      xpath: "//div[contains(concat(' ', normalize-space(@class), ' '), ' db ') and contains(concat(' ', normalize-space(@class), ' '), ' e4 ') and contains(concat(' ', normalize-space(@class), ' '), ' ec ') and contains(concat(' ', normalize-space(@class), ' '), ' de ') and contains(concat(' ', normalize-space(@class), ' '), ' b1 ') and contains(concat(' ', normalize-space(@class), ' '), ' iu ') and contains(concat(' ', normalize-space(@class), ' '), ' iv ') and contains(concat(' ', normalize-space(@class), ' '), ' dv ')]",
      notes: "Blurb under the title. Often followed by a 'More' link. Tokens appear stable in this snapshot but may change; keep XPath as fallback.",
      context: "Within header info region; may require clicking 'More' to expand."
    },
  },

};

export default selectors;
