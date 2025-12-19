// server.js (ESM)
// npm i express playwright cheerio
// npx playwright install chromium

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- Static --------------------
app.use(express.static(path.join(__dirname, "public")));

// -------------------- Simple in-memory cache --------------------
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // key: url, value: { ts, data }

function getCached(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return hit.data;
}

function setCached(url, data) {
  cache.set(url, { ts: Date.now(), data });
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

// If we ever accidentally get a yearly number, convert it safely.
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
  if (n != null && n >= 1200) {
    return `${formatMoney(Math.round(n / 12))} / month`;
  }

  return t;
}

// -------------------- Scrapers --------------------
async function scrapeCentris(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  try {
    // Let JS run, Centris renders content client-side.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Wait for address if it appears (best-effort).
    await page.waitForSelector("[itemprop='address']", { timeout: 8000 }).catch(() => {});

    // Small extra wait helps stabilize price/fees blocks.
    await page.waitForTimeout(400);

    // Try to click "Monthly" toggle (best effort).
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
    const $ = cheerio.load(html);

    // ---------------- Price ----------------
    let price = "—";
    const priceText =
      cleanText($("[data-cy='price']").first().text()) ||
      cleanText($(".price, .carac-value .price").first().text());
    if (priceText) {
      const m = priceText.match(/\$[\s0-9,]+/);
      if (m) price = cleanText(m[0]);
    }

    // ---------------- Caracs ----------------
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

    // ---------------- Fees ----------------
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

    // ---------------- Address (FIX) ----------------
    let address = "";

    // 1) Centris DOM (matches your screenshot)
    address =
      cleanText($("[itemprop='address']").first().text()) ||
      cleanText($("h2[itemprop='address']").first().text()) ||
      cleanText($("[data-cy='address']").first().text());

    // 2) Fallback: OG title
    if (!address) {
      const ogTitle = cleanText($("meta[property='og:title']").attr("content"));
      if (ogTitle) address = ogTitle;
    }

    // 3) Fallback: JSON-LD
    if (!address) {
      const scripts = $("script[type='application/ld+json']").toArray();
      for (const s of scripts) {
        try {
          const json = JSON.parse($(s).text());
          const items = Array.isArray(json) ? json : [json];

          for (const it of items) {
            const addr =
              it?.address?.streetAddress ||
              it?.address?.name ||
              it?.location?.address?.streetAddress;

            if (addr) {
              address = cleanText(addr);
              break;
            }
          }
        } catch {
          // ignore
        }
        if (address) break;
      }
    }

    // ---------------- Contact ----------------
    let contact = "—";
    const agentName =
      cleanText($("[data-cy='broker-name']").text()) ||
      cleanText($(".broker-name, .brokerName, .realtor-name").first().text());
    const phone =
      cleanText($("[data-cy='broker-phone']").text()) || cleanText($("a[href^='tel:']").first().text());

    if (agentName || phone) contact = cleanText([agentName, phone].filter(Boolean).join(" - "));

    return {
      url,
      source: "Centris",
      address: address || "—",
      price,
      beds: Number.isFinite(beds) ? beds : null,
      baths: Number.isFinite(baths) ? baths : null,
      levels: null,
      area: areaStr ? cleanText(areaStr) : null,
      condoFees,
      contact,
    };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function scrapeDuProprio(url) {
  // Keep your own working DuProprio scraper if you have one.
  return {
    url,
    source: "DuProprio",
    address: "—",
    price: "—",
    beds: null,
    baths: null,
    levels: null,
    area: null,
    condoFees: "—",
    contact: "—",
  };
}

function detectSource(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("centris.ca")) return "centris";
  if (u.includes("duproprio.com")) return "duproprio";
  return "unknown";
}

// -------------------- API --------------------
app.get("/api/listing", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url) return res.status(400).json({ ok: false, error: "Missing url parameter." });

  // cache
  const cached = getCached(url);
  if (cached) return res.json({ ok: true, listing: cached, cached: true });

  try {
    const src = detectSource(url);
    let listing;

    if (src === "centris") listing = await scrapeCentris(url);
    else if (src === "duproprio") listing = await scrapeDuProprio(url);
    else return res.status(400).json({ ok: false, error: "Unknown listing source." });

    setCached(url, listing);
    return res.json({ ok: true, listing, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Scrape failed: ${e?.message || e}` });
  }
});

// -------------------- Default route --------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
