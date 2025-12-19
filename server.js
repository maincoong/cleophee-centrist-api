// server.js (ESM)
// npm i express playwright cheerio
// npx playwright install chromium

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { load } from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- CORS --------------------
const ALLOWED_ORIGIN = "https://joeymakesweb.com";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

// -------------------- Cache --------------------
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // key: url::hint => {ts,data}

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
function formatMoneyCAD(n) {
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
    if (n != null) return `${formatMoneyCAD(Math.round(n / 12))} / month`;
    return t;
  }

  const n = moneyToNumber(t);
  if (n != null && n >= 1200) return `${formatMoneyCAD(Math.round(n / 12))} / month`;

  return t;
}

function detectSource(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("centris.ca")) return "centris";
  if (u.includes("duproprio.com")) return "duproprio";
  return "unknown";
}

// -------------------- Shared browser helper --------------------
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

// -------------------- Scrape: Centris --------------------
async function scrapeCentris(url) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("[itemprop='address']", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);

    // Best-effort monthly toggle
    const clickedMonthly = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("button, a, div[role='button']"));
      const monthly = els.find((el) => (el.textContent || "").trim().toLowerCase() === "monthly");
      if (monthly) {
        monthly.click();
        return true;
      }
      return false;
    });
    if (clickedMonthly) await page.waitForTimeout(650);

    const html = await page.content();
    const $ = load(html);

    // Price
    let price = "—";
    const priceText =
      cleanText($("[data-cy='price']").first().text()) ||
      cleanText($(".price, .carac-value .price").first().text());
    if (priceText) {
      const m = priceText.match(/\$[\s0-9,]+/);
      if (m) price = cleanText(m[0]);
    }

    // Caracs
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

    const bedsStr = getCarac("Number of rooms") || getCarac("Bedrooms") || getCarac("Beds");
    const bathsStr = getCarac("Number of bathrooms") || getCarac("Bathrooms") || getCarac("Baths");
    const areaStr = getCarac("Net area") || getCarac("Area");

    const beds = moneyToNumber(bedsStr) ?? (bedsStr ? Number(bedsStr) : null);
    const baths = moneyToNumber(bathsStr) ?? (bathsStr ? Number(bathsStr) : null);

    // Fees
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
      if (n != null) condoFees = `${formatMoneyCAD(n)} / month`;
    }
    condoFees = ensureMonthlyFeesString(condoFees);

    // Address
    let address =
      cleanText($("[itemprop='address']").first().text()) ||
      cleanText($("h2[itemprop='address']").first().text()) ||
      cleanText($("[data-cy='address']").first().text());

    if (!address) {
      const ogTitle = cleanText($("meta[property='og:title']").attr("content"));
      if (ogTitle) address = ogTitle;
    }

    // Contact
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
      area: areaStr ? cleanText(areaStr) : null,
      condoFees,
      contact,
    };
  });
}

// -------------------- Scrape: DuProprio --------------------
async function scrapeDuProprio(url) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(500);

    const html = await page.content();
    const $ = load(html);

    // Address: DuProprio often has it in og:title or h1
    let address =
      cleanText($("[data-testid='listing-address']").first().text()) ||
      cleanText($("h1").first().text());

    if (!address) {
      const ogTitle = cleanText($("meta[property='og:title']").attr("content"));
      if (ogTitle) address = ogTitle;
    }

    // Price: try common patterns, then fallback to any $xxx,xxx in prominent text
    let price = "—";
    const priceCandidates = [
      $("[data-testid='listing-price']").first().text(),
      $("[data-testid='price']").first().text(),
      $(".price").first().text(),
      $("meta[property='product:price:amount']").attr("content"),
      $("meta[property='og:price:amount']").attr("content"),
    ]
      .map(cleanText)
      .filter(Boolean);

    let priceText = priceCandidates[0] || "";
    if (!priceText) {
      const bigText = cleanText($("body").text());
      const m = bigText.match(/\$[\s0-9]{1,3}(?:,[0-9]{3})+/);
      if (m) priceText = m[0];
    }

    if (priceText) {
      if (/^\d+$/.test(priceText)) price = formatMoneyCAD(Number(priceText));
      else {
        const m = priceText.match(/\$[\s0-9,]+/);
        if (m) price = cleanText(m[0]);
      }
    }

    // Helper: find a "label: value" row anywhere
    function findValueByLabel(labels) {
      const allTextNodes = $("body").find("*").toArray();
      const wanted = labels.map((l) => l.toLowerCase());

      for (const el of allTextNodes) {
        const t = cleanText($(el).text());
        if (!t || t.length > 120) continue;

        const low = t.toLowerCase();
        for (const w of wanted) {
          if (low === w) {
            // Try next sibling
            const sib = cleanText($(el).next().text());
            if (sib) return sib;

            // Try parent row
            const parent = $(el).parent();
            const maybe = cleanText(parent.find("*").last().text());
            if (maybe && maybe.toLowerCase() !== w) return maybe;
          }
        }
      }
      return "";
    }

    // Beds / Baths
    const bedsStr =
      findValueByLabel(["Bedrooms", "Beds", "Chambres"]) ||
      cleanText($("[data-testid='bedrooms']").first().text());

    const bathsStr =
      findValueByLabel(["Bathrooms", "Baths", "Salles de bain"]) ||
      cleanText($("[data-testid='bathrooms']").first().text());

    const beds = moneyToNumber(bedsStr) ?? (bedsStr ? Number(bedsStr) : null);
    const baths = moneyToNumber(bathsStr) ?? (bathsStr ? Number(bathsStr) : null);

    // Area
    const areaStr =
      findValueByLabel(["Area", "Net area", "Superficie"]) ||
      cleanText($("[data-testid='area']").first().text());

    // Condo fees
    let condoFees =
      findValueByLabel(["Condo fees", "Condominium fees", "Frais de condo", "Frais de copropriété"]) ||
      cleanText($("[data-testid='condo-fees']").first().text());

    condoFees = cleanText(condoFees) || "—";
    condoFees = ensureMonthlyFeesString(condoFees);

    // Contact: DuProprio often does not expose a person, so leave as dash
    const contact = "—";

    return {
      url,
      source: "DuProprio",
      address: address || "",
      price,
      beds: Number.isFinite(beds) ? beds : null,
      baths: Number.isFinite(baths) ? baths : null,
      levels: null,
      area: areaStr ? cleanText(areaStr) : null,
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

    // Enforce: address must never be blank
    const finalListing = {
      ...listing,
      address: cleanText(listing.address) || addressHint || "—",
    };

    setCached(key, finalListing);
    return res.json({ ok: true, listing: finalListing, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Scrape failed: ${e?.message || e}` });
  }
});

// Health / homepage
app.get("/", (req, res) => {
  res.type("text").send("OK");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
