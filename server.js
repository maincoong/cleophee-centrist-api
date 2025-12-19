// server.js (ESM)
// npm i express playwright cheerio
// npx playwright install chromium

import express from "express";
import { chromium } from "playwright";
import { load } from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------- CORS --------------------
const ALLOWED_ORIGINS = new Set([
  "https://joeymakesweb.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

// -------------------- Simple in-memory cache --------------------
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // key: url::hint, value: { ts, data }

function makeCacheKey(url, addressHint) {
  return `${url}::hint=${(addressHint || "").trim()}`;
}
function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function setCached(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

// -------------------- Helpers --------------------
function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function moneyToNumber(s) {
  const n = Number(String(s || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatMoney(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  });
}

function ensureMonthlyFeesString(raw) {
  const t = cleanText(raw);
  if (!t || t === "—") return "—";

  if (/\/\s*month/i.test(t) || /\bmonthly\b/i.test(t)) return t;

  if (/\/\s*year/i.test(t) || /\byearly\b/i.test(t) || /\byear\b/i.test(t)) {
    const n = moneyToNumber(t);
    if (n != null) return `${formatMoney(Math.round(n / 12))} / month`;
    return t;
  }

  const n = moneyToNumber(t);
  if (n != null && n >= 1200) return `${formatMoney(Math.round(n / 12))} / month`;

  return t;
}

function parseCountFromText(s) {
  const m = String(s || "").match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function normalizeAreaToFt2(areaStr) {
  const t = cleanText(areaStr);
  if (!t) return null;

  // "912 sqft" -> "912 ft²"
  const mSqft = t.match(/([\d,]+)\s*sqft/i);
  if (mSqft) return `${mSqft[1]} ft²`;

  // already "ft²"
  const mFt2 = t.match(/([\d,]+)\s*ft²/i);
  if (mFt2) return `${mFt2[1]} ft²`;

  // if it contains both like "977 ft² (90.77 m²)" keep as-is
  if (/ft²/i.test(t) || /m²/i.test(t)) return t;

  return t;
}

function detectSource(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("centris.ca")) return "centris";
  if (u.includes("duproprio.com")) return "duproprio";
  return "unknown";
}

// -------------------- Address validation --------------------
function looksLikeRealAddress(s) {
  const t = cleanText(s);
  if (!t) return false;

  if (/[!?]/.test(t)) return false;

  const sentenceDots = (t.match(/\./g) || []).length;
  if (sentenceDots >= 2) return false;

  if (!/\d/.test(t)) return false;

  const streetWord =
    /\b(rue|av(?:enue)?|boulevard|boul|chemin|ch|route|rang|place|allee|allée|impasse|cote|côte|street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|way)\b/i;

  if (!streetWord.test(t)) return false;

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 18) return false;

  if (/\b(take a look|discover|invites you|for sale|commission[- ]?free)\b/i.test(t)) return false;

  return true;
}

function sanitizeAddressOrBlank(s) {
  const t = cleanText(s);
  return looksLikeRealAddress(t) ? t : "";
}

async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// -------------------- Scraper: Centris --------------------
async function scrapeCentris(url) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(700);

    const counts = await page.evaluate(() => {
      const rowText = document.querySelector(".row.teaser")?.innerText || "";
      return { rowText };
    });

    let beds = null;
    let baths = null;

    if (counts?.rowText) {
      const bedMatch = counts.rowText.match(/(\d+)\s*bedroom/i);
      const bathMatch = counts.rowText.match(/(\d+)\s*bathroom/i);
      if (bedMatch) beds = Number(bedMatch[1]);
      if (bathMatch) baths = Number(bathMatch[1]);
    }

    const html = await page.content();
    const $ = load(html);

    let price = "—";
    const priceText =
      cleanText($("[data-cy='price']").first().text()) ||
      cleanText($(".price, .carac-value .price").first().text());
    if (priceText) {
      const m = priceText.match(/\$[\s0-9,]+/);
      if (m) price = cleanText(m[0]);
    }

    const getCarac = (label) => {
      const titles = $(".carac-title").toArray();
      for (const t of titles) {
        const tt = cleanText($(t).text()).toLowerCase();
        if (tt === label.toLowerCase()) {
          const val = cleanText(
            $(t).closest(".carac-container, .carac").find(".carac-value").first().text()
          );
          if (val) return val;
        }
      }
      return "";
    };

    const rawArea = getCarac("Net area") || getCarac("Area");
    const area = rawArea ? normalizeAreaToFt2(rawArea) : null;

    let condoFees = "—";
    const feeRows = $("table tr").toArray();
    for (const r of feeRows) {
      const rowText = cleanText($(r).text()).toLowerCase();
      if (rowText.includes("condominium fees")) {
        const tds = $(r).find("td").toArray();
        if (tds.length) {
          const last = cleanText($(tds[tds.length - 1]).text());
          if (last) condoFees = last;
        }
      }
    }
    if (condoFees !== "—") {
      const n = moneyToNumber(condoFees);
      if (n != null) condoFees = `${formatMoney(n)} / month`;
    }
    condoFees = ensureMonthlyFeesString(condoFees);

    let address =
      cleanText($("[itemprop='address']").first().text()) ||
      cleanText($("h2[itemprop='address']").first().text()) ||
      cleanText($("[data-cy='address']").first().text());

    let contact = "—";
    const agentName =
      cleanText($("[data-cy='broker-name']").text()) ||
      cleanText($(".broker-name, .brokerName, .realtor-name").first().text());
    const phone =
      cleanText($("[data-cy='broker-phone']").text()) ||
      cleanText($("a[href^='tel:']").first().text());
    if (agentName || phone) contact = cleanText([agentName, phone].filter(Boolean).join(" - "));

    return {
      url,
      source: "Centris",
      address: address || "",
      price,
      beds: Number.isFinite(beds) ? beds : null,
      baths: Number.isFinite(baths) ? baths : null,
      levels: null,
      area,
      condoFees,
      contact,
    };
  });
}

// -------------------- DuProprio address extraction --------------------
function extractDuProprioAddress($) {
  // JSON-LD first
  const scripts = $("script[type='application/ld+json']").toArray();
  for (const s of scripts) {
    const raw = $(s).text();
    if (!raw) continue;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const addr = node?.address || node?.location?.address || null;
      const street = addr?.streetAddress || null;
      const locality = addr?.addressLocality || "";
      const region = addr?.addressRegion || "";
      const postal = addr?.postalCode || "";

      if (street) {
        const parts = [street, locality, region, postal].map(cleanText).filter(Boolean);
        const out = parts.join(", ");
        if (looksLikeRealAddress(out)) return out;
      }
    }
  }

  // meta description often includes street
  const desc = cleanText($("meta[name='description']").attr("content"));
  if (desc) {
    const dash = "[\\-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015]";
    const re = new RegExp(`\\b\\d{1,6}(?:${dash}\\d{1,6})?\\s*rue\\s*[^.,]+`, "i");
    const m = desc.match(re);
    if (m && m[0]) {
      const candidate = cleanText(m[0]) + (/\b(Montréal|Montreal)\b/i.test(desc) ? ", Montréal" : "");
      if (looksLikeRealAddress(candidate)) return candidate;
      if (looksLikeRealAddress(cleanText(m[0]))) return cleanText(m[0]);
    }
  }

  const ogStreet = cleanText($("meta[property='og:street-address']").attr("content"));
  if (ogStreet && looksLikeRealAddress(ogStreet)) return ogStreet;

  return "";
}

// -------------------- Scraper: DuProprio --------------------
async function scrapeDuProprio(url) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(900);

    // ✅ Beds/Baths from your DOM icons
    // ✅ Living space from the exact element you showed:
    // span.listing-main-characteristics__number.listing-main-characteristics__number--dimensions
    const dom = await page.evaluate(() => {
      function findNumberByIcon(iconClass) {
        const icon = document.querySelector(iconClass);
        if (!icon) return null;

        const item =
          icon.closest(".listing-main-characteristics__item") ||
          icon.closest("[class*='listing-main-characteristics__item']") ||
          icon.parentElement;

        if (!item) return null;

        const num =
          item.querySelector(".listing-main-characteristics__number") ||
          item.querySelector("[class*='listing-main-characteristics__number']");
        return num ? (num.textContent || "").trim() : null;
      }

      const bedsText = findNumberByIcon(".listing-main-characteristics__icon--bedrooms");
      const bathsText = findNumberByIcon(".listing-main-characteristics__icon--bathrooms");

      // Living space / dimensions
      const dim =
        document.querySelector(
          "span.listing-main-characteristics__number.listing-main-characteristics__number--dimensions"
        )?.textContent || "";

      return { bedsText, bathsText, dimText: (dim || "").trim() };
    });

    const html = await page.content();
    const $ = load(html);

    // Price (meta is most reliable)
    let price = "—";
    const metaAmount =
      cleanText($("meta[property='product:price:amount']").attr("content")) ||
      cleanText($("meta[property='og:price:amount']").attr("content")) ||
      cleanText($("meta[name='twitter:data1']").attr("content"));
    if (metaAmount) {
      const n = moneyToNumber(metaAmount);
      if (n != null) price = formatMoney(n);
    }
    if (price === "—") {
      const t = cleanText($("body").text());
      const m = t.match(/\$[\s0-9,]+/);
      if (m) price = cleanText(m[0]);
    }

    const address = extractDuProprioAddress($);

    const beds = parseCountFromText(dom?.bedsText);
    const baths = parseCountFromText(dom?.bathsText);

    // Living space: normalize (keeps "977 ft² (90.77 m²)" as-is)
    const area = dom?.dimText ? normalizeAreaToFt2(dom.dimText) : null;

    // Fees (best effort)
    const bodyText = cleanText($("body").text());
    let condoFees = "—";
    const feesMatch =
      bodyText.match(/\$[\s0-9,]+\s*\/\s*(?:month|mo)\b/i) ||
      bodyText.match(/Condo(?:minium)?\s*fees?.{0,30}(\$[\s0-9,]+)/i) ||
      bodyText.match(/Fees?.{0,30}(\$[\s0-9,]+)/i);

    if (feesMatch) {
      condoFees = cleanText(feesMatch[0]);
      const n = moneyToNumber(condoFees);
      if (n != null && !/\/\s*(month|mo)\b/i.test(condoFees)) condoFees = `${formatMoney(n)} / month`;
    }
    condoFees = ensureMonthlyFeesString(condoFees);

    let contact = "—";
    const tel = cleanText($("a[href^='tel:']").first().text());
    if (tel) contact = tel;

    return {
      url,
      source: "DuProprio",
      address: address || "",
      price,
      beds: Number.isFinite(beds) ? beds : null,
      baths: Number.isFinite(baths) ? baths : null,
      levels: null,
      area,
      condoFees,
      contact,
    };
  });
}

// -------------------- API --------------------
app.get("/api/listing", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const addressHint = String(req.query.addressHint || "").trim();

  if (!url) return res.status(400).json({ ok: false, error: "Missing url parameter." });

  const key = makeCacheKey(url, addressHint);
  const cached = getCached(key);
  if (cached) return res.json({ ok: true, listing: cached, cached: true });

  try {
    const src = detectSource(url);
    let listing;

    if (src === "centris") listing = await scrapeCentris(url);
    else if (src === "duproprio") listing = await scrapeDuProprio(url);
    else return res.status(400).json({ ok: false, error: "Unknown listing source." });

    const safeScraped = sanitizeAddressOrBlank(listing.address);
    const finalAddress = safeScraped || cleanText(addressHint) || "—";

    const finalListing = { ...listing, address: finalAddress };

    setCached(key, finalListing);
    return res.json({ ok: true, listing: finalListing, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Scrape failed: ${e?.message || e}` });
  }
});

// -------------------- Root (API-only) --------------------
app.get("/", (req, res) => {
  res.type("text").send("OK");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
