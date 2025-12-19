import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cheerio from "cheerio";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve your /public folder
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

/* -------------------- CACHE (server-side) -------------------- */
/**
 * Cache key: listing url
 * Cache value: { savedAt, data }
 * TTL keeps things fresh but still fast.
 */
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const listingCache = new Map();

function cacheGet(url) {
  const hit = listingCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.savedAt > CACHE_TTL_MS) {
    listingCache.delete(url);
    return null;
  }
  return hit.data;
}

function cacheSet(url, data) {
  listingCache.set(url, { savedAt: Date.now(), data });
}

/* -------------------- PLAYWRIGHT REUSE (big speed win) -------------------- */
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      // These args help on many hosts
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browserPromise;
}

/* -------------------- HELPERS -------------------- */
function toMoneyNumber(str) {
  if (!str) return null;
  const s = String(str).replace(/\s/g, "");
  const m = s.match(/([\d.,]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatCAD(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
}

/**
 * Convert condo fees to monthly if they appear yearly.
 * Returns a display string like "$280 / month" or "$280/month"
 */
function normalizeCondoFees(raw) {
  if (!raw) return { display: "—", raw: "—" };

  const text = String(raw).trim();
  const lower = text.toLowerCase();
  const amt = toMoneyNumber(text);

  // If Centris gives "Condominium fees $3360" (no unit), it is often yearly.
  // If it explicitly says yearly, divide by 12.
  const looksYearly =
    lower.includes("year") ||
    lower.includes("annual") ||
    lower.includes("per year") ||
    lower.includes("/year") ||
    lower.includes("yearly");

  const looksMonthly =
    lower.includes("month") ||
    lower.includes("monthly") ||
    lower.includes("per month") ||
    lower.includes("/month");

  if (amt == null) return { display: text, raw: text };

  // If it already says month, trust it
  if (looksMonthly) return { display: `${formatCAD(amt)} / month`, raw: text };

  // If it says yearly, convert
  if (looksYearly) return { display: `${formatCAD(amt / 12)} / month`, raw: text };

  // If there is no unit at all, assume yearly for Centris-style fees (this is what you want)
  // If you ever see a real monthly number here, it will look huge and obvious and you can adjust.
  return { display: `${formatCAD(amt / 12)} / month`, raw: text };
}

function pickFirstText($, selectors) {
  for (const sel of selectors) {
    const t = $(sel).first().text().trim();
    if (t) return t;
  }
  return "";
}

function pickFirstAttr($, selectors, attr) {
  for (const sel of selectors) {
    const v = $(sel).first().attr(attr);
    if (v) return String(v).trim();
  }
  return "";
}

/* -------------------- DUPROPRIO SCRAPE (fast with fetch+cheerio) -------------------- */
async function scrapeDuProprio(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const html = await resp.text();
  const $ = cheerio.load(html);

  // This is intentionally conservative since DuProprio HTML can vary.
  // Keep whatever you already had working, but here is a baseline fallback.
  const title = $("h1").first().text().trim();

  const price =
    $('[data-testid="listing-price"]').first().text().trim() ||
    $('meta[property="og:price:amount"]').attr("content") ||
    "";

  const address =
    $('[data-testid="listing-address"]').first().text().trim() ||
    $('meta[property="og:street-address"]').attr("content") ||
    title ||
    "";

  // You likely already parse these better. Leaving placeholders if not found.
  return {
    url,
    source: "DuProprio",
    address: address || "—",
    price: price || "—",
    beds: null,
    baths: null,
    levels: null,
    area: null,
    condoFees: "—",
    contact: "—",
  };
}

/* -------------------- CENTRIS SCRAPE (Playwright, optimized) -------------------- */
async function scrapeCentris(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    viewport: { width: 1200, height: 900 },
  });

  const page = await context.newPage();

  // Block heavy stuff: images, fonts, media, analytics
  await page.route("**/*", (route) => {
    const r = route.request();
    const type = r.resourceType();
    const u = r.url();

    if (["image", "media", "font"].includes(type)) return route.abort();
    if (u.includes("google-analytics") || u.includes("doubleclick") || u.includes("gtm")) return route.abort();

    return route.continue();
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  // Some Centris pages lazy-load content. Small wait helps without being huge.
  await page.waitForTimeout(400);

  const html = await page.content();
  await page.close();
  await context.close();

  const $ = cheerio.load(html);

  // PRICE
  const price =
    pickFirstText($, [
      '[data-testid="buyPrice"]',
      '[data-testid="price"]',
      ".price",
      ".carac-value .price",
    ]) ||
    $('meta[property="og:price:amount"]').attr("content") ||
    "";

  // ADDRESS
  const address =
    pickFirstText($, [
      '[data-testid="address"]',
      ".address",
      ".property-address",
      ".location-container",
    ]) ||
    $('meta[property="og:street-address"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";

  // BEDS / BATHS
  const bedsText = pickFirstText($, [
    '[data-testid="nbChambres"]',
    '[data-testid="bedrooms"]',
    '.carac-title:contains("Bedrooms") + .carac-value',
    '.carac-title:contains("Beds") + .carac-value',
    '.carac-title:contains("Number of rooms") + .carac-value',
  ]);

  const bathsText = pickFirstText($, [
    '[data-testid="nbSallesDeBain"]',
    '[data-testid="bathrooms"]',
    '.carac-title:contains("Bathrooms") + .carac-value',
    '.carac-title:contains("Baths") + .carac-value',
  ]);

  // AREA (you showed: carac-title "Net area" then carac-value "912 sqft")
  const area =
    pickFirstText($, [
      '.carac-title:contains("Net area") + .carac-value',
      '.carac-title:contains("Living area") + .carac-value',
      '[data-testid="netArea"]',
    ]).replace(/\s+/g, " ").trim();

  // CONDO FEES (you showed: table row with "Condominium fees" + value)
  const condoFeesRaw =
    pickFirstText($, [
      'td:contains("Condominium fees") + td',
      '.carac-title:contains("Condominium fees") + .carac-value',
      '.financial-details-table td:contains("Condominium fees") + td',
    ]) || "";

  const feesNorm = normalizeCondoFees(condoFeesRaw);

  // AGENT / BROKER CONTACT (best effort, Centris HTML changes a lot)
  const agentName =
    pickFirstText($, [
      '[data-testid="brokerName"]',
      ".broker-card__name",
      ".broker-info__name",
      ".broker .name",
    ]) || "";

  const agentPhone =
    pickFirstText($, [
      '[data-testid="brokerPhone"]',
      ".broker-card__phone",
      ".broker-info__phone",
      'a[href^="tel:"]',
    ]) || "";

  const agentEmail =
    pickFirstAttr($, ['a[href^="mailto:"]'], "href")?.replace(/^mailto:/i, "") || "";

  const contactBits = [agentName, agentPhone, agentEmail].filter(Boolean);
  const contact = contactBits.length ? contactBits.join(" | ") : "—";

  return {
    url,
    source: "Centris",
    address: address || "—",
    price: price ? (String(price).includes("$") ? String(price).trim() : formatCAD(toMoneyNumber(price))) : "—",
    beds: toMoneyNumber(bedsText),
    baths: toMoneyNumber(bathsText),
    levels: null,
    area: area || "—",
    condoFees: feesNorm.display,
    contact,
    _debug: {
      condoFeesRaw: condoFeesRaw || "—",
    },
  };
}

/* -------------------- API -------------------- */
app.get("/api/listing", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    // 1) Server cache first (makes repeat clicks instant)
    const cached = cacheGet(url);
    if (cached) return res.json({ ok: true, listing: cached, cached: true });

    const host = new URL(url).hostname.replace(/^www\./, "");
    let listing;

    if (host.includes("centris.ca")) {
      listing = await scrapeCentris(url);
    } else if (host.includes("duproprio.com")) {
      listing = await scrapeDuProprio(url);
    } else {
      return res.status(400).json({ ok: false, error: "Unsupported source" });
    }

    cacheSet(url, listing);
    return res.json({ ok: true, listing, cached: false });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: `Listing scrape failed: ${e?.message || String(e)}`,
    });
  }
});

// Simple health check
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
