// server.js (ESM)
// npm i express cheerio compression playwright
// npx playwright install chromium

import express from "express";
import compression from "compression";
import { chromium } from "playwright";
import { load } from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());

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

// -------------------- Cache + in-flight dedupe --------------------
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // key -> { ts, data }
const inflight = new Map(); // key -> Promise

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
  if (!Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  });
}

function ensureMonthlyFeesString(raw) {
  const t = cleanText(raw);
  if (!t || t === "N/A") return "N/A";

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

function normalizeAreaToFt2(areaStr) {
  const t = cleanText(areaStr);
  if (!t) return null;

  const mSqft = t.match(/([\d,]+)\s*sqft/i);
  if (mSqft) return `${mSqft[1]} ft²`;

  const mFt2 = t.match(/([\d,]+)\s*ft²/i);
  if (mFt2) return `${mFt2[1]} ft²`;

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

// -------------------- Semaphore (avoid dogpiling) --------------------
function createSemaphore(max = 1) {
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < max) {
        active += 1;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      const next = queue.shift();
      if (next) next();
    },
  };
}
const scrapeGate = createSemaphore(1);

// -------------------- Hard timeout --------------------
async function withHardTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label || "timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

// -------------------- Direct HTTP fetch (fast) --------------------
async function fetchHtmlDirect(url, timeoutMs = 6500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "en-CA,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    if (!res.ok) return { ok: false, status: res.status, html: "" };

    const html = await res.text();

    if (!html || html.length < 1500) return { ok: false, status: res.status, html };
    const looksHtml = html.includes("<html") || html.toLowerCase().includes("<!doctype html");
    if (!looksHtml) return { ok: false, status: res.status, html };

    return { ok: true, status: res.status, html };
  } catch (e) {
    return { ok: false, status: 0, html: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function looksBlocked(html) {
  const t = (html || "").toLowerCase();
  if (!t) return true;
  if (t.includes("captcha")) return true;
  if (t.includes("access denied")) return true;
  if (t.includes("please enable javascript")) return true;
  return false;
}

// -------------------- Playwright global reuse (fallback only) --------------------
let browser;
let context;

async function ensureBrowser() {
  if (browser && context) return;

  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });
}

async function enableFastRoutes(page) {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
      return route.abort();
    }
    return route.continue();
  });
}

// Retry wrapper for the exact failure you are seeing
function isExecutionContextDestroyed(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("Execution context was destroyed") || msg.includes("because of a navigation");
}

async function safeEvaluate(page, fn, { timeoutMs = 5500, retries = 2, label = "eval" } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      // tiny settle helps when sites do an immediate redirect or hydration nav
      await page.waitForTimeout(120);
      return await withHardTimeout(page.evaluate(fn), timeoutMs, `${label} timeout`);
    } catch (e) {
      lastErr = e;
      if (!isExecutionContextDestroyed(e)) throw e;
      if (i === retries) break;
      // wait a bit and try again on the new document context
      await page.waitForTimeout(250);
    }
  }
  throw lastErr;
}

async function fetchHtmlPlaywright(url, { expectSelector } = {}) {
  await ensureBrowser();
  const page = await context.newPage();

  page.setDefaultNavigationTimeout(12000);
  page.setDefaultTimeout(12000);

  await enableFastRoutes(page);

  try {
    await withHardTimeout(page.goto(url, { waitUntil: "domcontentloaded" }), 12000, "nav timeout");

    // If we know something that should exist, wait briefly for it.
    if (expectSelector) {
      await page.waitForSelector(expectSelector, { timeout: 4000 }).catch(() => {});
    } else {
      // brief settle
      await page.waitForTimeout(180);
    }

    const html = await withHardTimeout(page.content(), 6500, "content timeout");
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

// Ultra-fast DuProprio fallback: read JSON-LD + meta without serializing full HTML
async function fetchDuProprioStructuredPlaywright(url) {
  await ensureBrowser();
  const page = await context.newPage();

  page.setDefaultNavigationTimeout(12000);
  page.setDefaultTimeout(12000);

  await enableFastRoutes(page);

  try {
    await withHardTimeout(page.goto(url, { waitUntil: "domcontentloaded" }), 12000, "nav timeout");

    // If JSON-LD exists, give it a moment to appear.
    await page.waitForSelector("script[type='application/ld+json']", { timeout: 3500 }).catch(() => {});

    const data = await safeEvaluate(
      page,
      () => {
        const getMeta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
        const getText = (sel) => (document.querySelector(sel)?.textContent || "").trim();

        const metaAmount =
          getMeta("meta[property='product:price:amount']") ||
          getMeta("meta[property='og:price:amount']") ||
          getMeta("meta[name='twitter:data1']") ||
          "";

        const ld = Array.from(document.querySelectorAll("script[type='application/ld+json']"))
          .map((s) => s.textContent || "")
          .filter(Boolean);

        // Some pages also expose a usable title
        const ogTitle = getMeta("meta[property='og:title']") || "";
        const ogDesc = getMeta("meta[property='og:description']") || "";

        return {
          metaAmount,
          ldjson: ld,
          ogTitle,
          ogDesc,
          bedsText: getText(".listing-main-characteristics__icon--bedrooms ~ .listing-main-characteristics__number"),
          bathsText: getText(".listing-main-characteristics__icon--bathrooms ~ .listing-main-characteristics__number"),
          dimText: getText(
            "span.listing-main-characteristics__number.listing-main-characteristics__number--dimensions"
          ),
        };
      },
      { timeoutMs: 6000, retries: 2, label: "dp structured eval" }
    );

    return data;
  } finally {
    await page.close().catch(() => {});
  }
}

async function shutdown() {
  try {
    await context?.close();
  } catch {}
  try {
    await browser?.close();
  } catch {}
  context = null;
  browser = null;
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// -------------------- Centris parser (cheerio) --------------------
function parseCentrisFromHtml(url, html) {
  const $ = load(html);

  let price = "N/A";
  const priceText =
    cleanText($("[data-cy='buyPrice']").first().text()) ||
    cleanText($("[data-cy='price']").first().text()) ||
    cleanText($(".price").first().text());

  if (priceText) {
    const m = priceText.match(/\$[\s0-9,]+/);
    if (m) price = cleanText(m[0]);
  }

  const teaser = cleanText($(".row.teaser").first().text());
  let beds = null;
  let baths = null;
  if (teaser) {
    const bedMatch = teaser.match(/(\d+)\s*bedroom/i);
    const bathMatch = teaser.match(/(\d+)\s*bathroom/i);
    if (bedMatch) beds = Number(bedMatch[1]);
    if (bathMatch) baths = Number(bathMatch[1]);
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

  let condoFees = "N/A";
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
  if (condoFees !== "N/A") {
    const n = moneyToNumber(condoFees);
    if (n != null) condoFees = `${formatMoney(n)} / month`;
  }
  condoFees = ensureMonthlyFeesString(condoFees);

  let address =
    cleanText($("[itemprop='address']").first().text()) ||
    cleanText($("[data-cy='address']").first().text());

  let contact = "N/A";
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
}

// -------------------- DuProprio fast parser (JSON-LD first) --------------------
function parseDuProprioFromHtmlFast(url, html) {
  const $ = load(html);

  let price = "N/A";
  const metaAmount =
    cleanText($("meta[property='product:price:amount']").attr("content")) ||
    cleanText($("meta[property='og:price:amount']").attr("content")) ||
    cleanText($("meta[name='twitter:data1']").attr("content"));
  if (metaAmount) {
    const n = moneyToNumber(metaAmount);
    if (n != null) price = formatMoney(n);
  }

  let address = "";
  let beds = null;
  let baths = null;
  let area = null;

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
      const addr = node?.address || node?.location?.address || node?.offers?.itemOffered?.address || null;
      const street = addr?.streetAddress || null;
      const locality = addr?.addressLocality || "";
      const region = addr?.addressRegion || "";
      const postal = addr?.postalCode || "";

      if (!address && street) {
        const parts = [street, locality, region, postal].map(cleanText).filter(Boolean);
        const out = parts.join(", ");
        if (looksLikeRealAddress(out)) address = out;
      }

      const floorSize = node?.floorSize?.value || node?.floorSize?.amount || node?.floorSize || null;
      if (!area && floorSize != null) {
        const v = typeof floorSize === "number" ? String(floorSize) : cleanText(String(floorSize));
        if (v) area = normalizeAreaToFt2(v);
      }

      const additional = node?.additionalProperty || node?.additionalProperties || null;
      const addArr = Array.isArray(additional) ? additional : additional ? [additional] : [];

      for (const ap of addArr) {
        const name = cleanText(ap?.name || ap?.propertyID || "").toLowerCase();
        const val = ap?.value ?? ap?.valueText ?? ap?.valueReference ?? "";
        const v = cleanText(String(val));

        if (!beds && (name.includes("bed") || name.includes("bedroom"))) {
          const n = Number(v.replace(/[^\d.]/g, ""));
          if (Number.isFinite(n)) beds = n;
        }
        if (!baths && (name.includes("bath") || name.includes("bathroom"))) {
          const n = Number(v.replace(/[^\d.]/g, ""));
          if (Number.isFinite(n)) baths = n;
        }
        if (!area && (name.includes("area") || name.includes("surface") || name.includes("size"))) {
          if (v) area = normalizeAreaToFt2(v);
        }
      }

      if (!area) {
        const desc = cleanText(node?.description || "");
        const m = desc.match(/\b([\d,]+)\s*(?:ft²|sqft)\b/i);
        if (m) area = `${m[1]} ft²`;
      }
    }
  }

  let condoFees = "N/A";

  let contact = "N/A";
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
    area: area ? normalizeAreaToFt2(area) : null,
    condoFees: ensureMonthlyFeesString(condoFees),
    contact,
  };
}

function parseDuProprioFromStructured(url, structured) {
  let price = "N/A";
  const metaAmount = cleanText(structured?.metaAmount || "");
  if (metaAmount) {
    const n = moneyToNumber(metaAmount);
    if (n != null) price = formatMoney(n);
  }

  let address = "";
  let beds = null;
  let baths = null;
  let area = null;

  const blocks = Array.isArray(structured?.ldjson) ? structured.ldjson : [];
  for (const raw of blocks) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const addr = node?.address || node?.location?.address || node?.offers?.itemOffered?.address || null;
      const street = addr?.streetAddress || null;
      const locality = addr?.addressLocality || "";
      const region = addr?.addressRegion || "";
      const postal = addr?.postalCode || "";

      if (!address && street) {
        const parts = [street, locality, region, postal].map(cleanText).filter(Boolean);
        const out = parts.join(", ");
        if (looksLikeRealAddress(out)) address = out;
      }

      const desc = cleanText(node?.description || "");
      if (!area) {
        const m = desc.match(/\b([\d,]+)\s*(?:ft²|sqft)\b/i);
        if (m) area = `${m[1]} ft²`;
      }
    }
  }

  // Backup address extraction from OG if LD failed
  if (!address) {
    const og = cleanText(structured?.ogTitle || structured?.ogDesc || "");
    // Not perfect, but sometimes OG includes street + city
    if (looksLikeRealAddress(og)) address = og;
  }

  const b1 = cleanText(structured?.bedsText || "");
  const b2 = cleanText(structured?.bathsText || "");
  const d1 = cleanText(structured?.dimText || "");

  const nb = b1 ? Number(b1.replace(/[^\d.]/g, "")) : null;
  const na = b2 ? Number(b2.replace(/[^\d.]/g, "")) : null;

  if (Number.isFinite(nb)) beds = nb;
  if (Number.isFinite(na)) baths = na;
  if (d1) area = normalizeAreaToFt2(d1);

  return {
    url,
    source: "DuProprio",
    address: address || "",
    price,
    beds: Number.isFinite(beds) ? beds : null,
    baths: Number.isFinite(baths) ? baths : null,
    levels: null,
    area: area ? normalizeAreaToFt2(area) : null,
    condoFees: "N/A",
    contact: "N/A",
  };
}

// -------------------- Scrape orchestrator --------------------
async function scrapeCentris(url) {
  const direct = await fetchHtmlDirect(url, 7000);
  if (direct.ok && !looksBlocked(direct.html)) {
    return parseCentrisFromHtml(url, direct.html);
  }

  // Centris sometimes hydrates the price client-side
  const html = await fetchHtmlPlaywright(url, {
    expectSelector: "[data-cy='buyPrice'], [data-cy='price'], [data-cy='address']",
  });
  return parseCentrisFromHtml(url, html);
}

async function scrapeDuProprio(url) {
  const direct = await fetchHtmlDirect(url, 5500);
  if (direct.ok && !looksBlocked(direct.html)) {
    return parseDuProprioFromHtmlFast(url, direct.html);
  }

  // Playwright structured scrape
  const structured = await fetchDuProprioStructuredPlaywright(url);
  if (structured && (structured.metaAmount || (structured.ldjson && structured.ldjson.length))) {
    const parsed = parseDuProprioFromStructured(url, structured);
    // If price still missing, fall through to full HTML
    if (parsed.price && parsed.price !== "N/A") return parsed;
  }

  // Last resort full HTML
  const html = await fetchHtmlPlaywright(url);
  return parseDuProprioFromHtmlFast(url, html);
}

// -------------------- API --------------------
app.get("/api/listing", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const addressHint = String(req.query.addressHint || "").trim();

  if (!url) return res.status(400).json({ ok: false, error: "Missing url parameter." });

  const src = detectSource(url);
  if (src === "unknown") return res.status(400).json({ ok: false, error: "Unknown listing source." });

  const key = makeCacheKey(url, addressHint);

  const cached = getCached(key);
  if (cached) return res.json({ ok: true, listing: cached, cached: true });

  const existing = inflight.get(key);
  if (existing) {
    try {
      const listing = await withHardTimeout(existing, 20000, "inflight timeout");
      return res.json({ ok: true, listing, cached: false, deduped: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: `Scrape failed: ${e?.message || e}` });
    }
  }

  const p = (async () => {
    await scrapeGate.acquire();
    try {
      const t0 = Date.now();

      let listing;
      if (src === "centris") listing = await withHardTimeout(scrapeCentris(url), 22000, "centris timeout");
      else listing = await withHardTimeout(scrapeDuProprio(url), 20000, "duproprio timeout");

      const safeScraped = sanitizeAddressOrBlank(listing.address);
      const finalAddress = safeScraped || cleanText(addressHint) || "N/A";
      const finalListing = { ...listing, address: finalAddress };

      setCached(key, finalListing);

      console.log(`[scrape] ${src} ${Date.now() - t0}ms ${url}`);
      return finalListing;
    } finally {
      scrapeGate.release();
    }
  })();

  inflight.set(key, p);

  try {
    const listing = await p;
    return res.json({ ok: true, listing, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Scrape failed: ${e?.message || e}` });
  } finally {
    inflight.delete(key);
  }
});

// -------------------- Root --------------------
app.get("/", (req, res) => {
  res.type("text").send("OK");
});

app.listen(PORT, async () => {
  try {
    await ensureBrowser();
  } catch (e) {
    console.error("Browser warmup failed:", e?.message || e);
  }
  console.log(`Server running on port ${PORT}`);
});
