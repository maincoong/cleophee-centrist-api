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
  "https://www.joeymakesweb.com",
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

function extractMoneyFromText(s) {
  const t = cleanText(s);
  const m = t.match(/\$\s*[\d\s,]{3,}/);
  return m ? cleanText(m[0]) : "";
}

function ensureMonthlyFeesString(raw) {
  const t = cleanText(raw);
  if (!t || t === "N/A" || t === "—") return "N/A";

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
  if (words.length > 22) return false;

  if (/\b(take a look|discover|invites you|for sale|commission[- ]?free)\b/i.test(t)) return false;

  return true;
}

function sanitizeAddressOrBlank(s) {
  const t = cleanText(s);
  return looksLikeRealAddress(t) ? t : "";
}

// -------------------- Semaphore --------------------
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

function looksBlocked(html) {
  const t = (html || "").toLowerCase();
  if (!t) return true;
  if (t.includes("captcha")) return true;
  if (t.includes("access denied")) return true;
  if (t.includes("please enable javascript")) return true;
  if (t.includes("unusual traffic")) return true;
  return false;
}

// -------------------- Direct HTTP fetch (fast path) --------------------
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
        "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: "https://www.centris.ca/",
      },
    });

    if (!res.ok) return { ok: false, status: res.status, html: "" };

    const html = await res.text();

    if (!html || html.length < 1200) return { ok: false, status: res.status, html };
    const looksHtml = html.toLowerCase().includes("<html") || html.toLowerCase().includes("<!doctype html");
    if (!looksHtml) return { ok: false, status: res.status, html };

    return { ok: true, status: res.status, html };
  } catch (e) {
    return { ok: false, status: 0, html: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// -------------------- Playwright global reuse --------------------
let browser;
let context;

async function ensureBrowser() {
  if (browser && context) return;

  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "en-CA",
    extraHTTPHeaders: {
      "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7",
    },
  });

  // tiny stealth
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
}

// For DuProprio we keep speed optimizations.
// For Centris we DO NOT block images/fonts because it often triggers bot/challenge pages.
async function enableFastRoutesDuProprio(page) {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") return route.abort();
    return route.continue();
  });
}

async function gotoWithRetries(page, url, opts = {}) {
  const { navTimeoutMs = 25000, tries = 1, waitUntil = "domcontentloaded" } = opts;
  let lastErr;

  for (let attempt = 0; attempt <= tries; attempt += 1) {
    try {
      await withHardTimeout(page.goto(url, { waitUntil }), navTimeoutMs, "nav timeout");
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e || "").toLowerCase();
      if (!msg.includes("timeout")) throw e;
      try {
        await page.evaluate(() => (window.stop ? window.stop() : null)).catch(() => {});
      } catch {}
      if (attempt < tries) await page.waitForTimeout(600);
    }
  }

  throw lastErr;
}

async function waitForAny(page, selectors, timeoutMs) {
  const tasks = selectors.map((sel) =>
    page
      .waitForSelector(sel, { timeout: timeoutMs })
      .then(() => sel)
      .catch(() => null)
  );
  const winner = await Promise.race(tasks);
  return winner || "";
}

function isExecutionContextDestroyed(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("Execution context was destroyed") || msg.includes("because of a navigation");
}

async function safeEvaluate(page, fn, { timeoutMs = 9000, retries = 1, label = "eval" } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      await page.waitForTimeout(100);
      return await withHardTimeout(page.evaluate(fn), timeoutMs, `${label} timeout`);
    } catch (e) {
      lastErr = e;
      if (!isExecutionContextDestroyed(e)) throw e;
      if (i === retries) break;
      await page.waitForTimeout(300);
    }
  }
  throw lastErr;
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

// -------------------- Centris parsing (cheerio) --------------------
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
        const val = cleanText($(t).closest(".carac-container, .carac").find(".carac-value").first().text());
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
  condoFees = ensureMonthlyFeesString(condoFees);

  // ✅ screenshot shows h2[itemprop="address"]
  const address =
    cleanText($("h2[itemprop='address']").first().text()) ||
    cleanText($("[itemprop='address']").first().text()) ||
    cleanText($("[data-cy='address']").first().text()) ||
    "";

  let contact = "N/A";
  const agentName =
    cleanText($("[data-cy='broker-name']").text()) ||
    cleanText($(".broker-name, .brokerName, .realtor-name").first().text());
  const phone =
    cleanText($("[data-cy='broker-phone']").text()) || cleanText($("a[href^='tel:']").first().text());
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

// -------------------- Centris session-style Playwright (key fix) --------------------
async function fetchCentrisHtmlPlaywrightSession(url) {
  await ensureBrowser();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(30000);

  try {
    // Step 1: visit homepage to get cookies/session
    await gotoWithRetries(page, "https://www.centris.ca/en", { navTimeoutMs: 25000, tries: 1, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(250);

    // Step 2: visit listing with referer
    await page.setExtraHTTPHeaders({
      Referer: "https://www.centris.ca/en",
    });

    // networkidle helps Centris pages that fetch data after DOMContentLoaded
    await gotoWithRetries(page, url, { navTimeoutMs: 30000, tries: 1, waitUntil: "networkidle" });

    // wait for key signals
    await waitForAny(
      page,
      ["[data-cy='buyPrice']", "[data-cy='price']", "h2[itemprop='address']", ".row.teaser", "body"],
      14000
    ).catch(() => "");

    await page.waitForTimeout(250);

    const html = await withHardTimeout(page.content(), 14000, "content timeout");
    const title = await page.title().catch(() => "");
    const finalUrl = page.url();

    return { ok: true, html, title, finalUrl };
  } finally {
    await page.close().catch(() => {});
  }
}

// -------------------- DuProprio parsing (cheerio) --------------------
function parseDuProprioFromHtml(url, html) {
  const $ = load(html);

  let price = cleanText($(".listing-price__amount").first().text()) || "N/A";

  if (price === "N/A") {
    const metaAmount =
      cleanText($("meta[property='product:price:amount']").attr("content")) ||
      cleanText($("meta[property='og:price:amount']").attr("content")) ||
      cleanText($("meta[name='twitter:data1']").attr("content"));
    if (metaAmount) {
      const n = moneyToNumber(metaAmount);
      if (n != null) price = formatMoney(n);
    }
  }

  if (price === "N/A") {
    const metaText =
      cleanText($("meta[property='og:description']").attr("content")) ||
      cleanText($("meta[property='og:title']").attr("content")) ||
      "";
    const p = extractMoneyFromText(metaText);
    if (p) price = p;
  }

  let beds = null;
  let baths = null;
  let area = null;

  const items = $(".listing-main-characteristics__item").toArray();
  for (const el of items) {
    const $el = $(el);
    const number = cleanText($el.find(".listing-main-characteristics__number").first().text());
    const title = cleanText($el.find(".listing-main-characteristics__title").first().text()).toLowerCase();
    const cls = ($el.attr("class") || "").toLowerCase();

    if (!beds && (title.includes("bedroom") || title.includes("bedrooms"))) {
      const n = Number(number.replace(/[^\d.]/g, ""));
      if (Number.isFinite(n)) beds = n;
    }
    if (!baths && (title.includes("bathroom") || title.includes("bathrooms") || title === "bath")) {
      const n = Number(number.replace(/[^\d.]/g, ""));
      if (Number.isFinite(n)) baths = n;
    }
    if (!area && (cls.includes("item-dimensions") || number.includes("ft²") || number.toLowerCase().includes("sqft"))) {
      area = normalizeAreaToFt2(number);
    }
  }

  let condoFees =
    cleanText($(".listing-fees__amount").first().text()) ||
    cleanText($(".listing-financial__amount").first().text()) ||
    "N/A";

  if (condoFees === "N/A") {
    const body = cleanText($("body").text());
    const m = body.match(/condo fees[^$]{0,60}(\$\s*[\d\s,]{2,}(?:\.\d{2})?)/i);
    if (m && m[1]) condoFees = m[1];
    const mFr = body.match(/frais de condo[^$]{0,60}(\$\s*[\d\s,]{2,}(?:\.\d{2})?)/i);
    if (condoFees === "N/A" && mFr && mFr[1]) condoFees = mFr[1];
  }
  condoFees = ensureMonthlyFeesString(condoFees);

  const address =
    cleanText($(".listing-address").first().text()) ||
    cleanText($("[class*='listing-address']").first().text()) ||
    "";

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
    condoFees,
    contact,
  };
}

// -------------------- Scrapers --------------------
async function scrapeCentris(url, addressHint) {
  // 1) FAST direct fetch
  const direct = await fetchHtmlDirect(url, 7000);
  if (direct.ok && !looksBlocked(direct.html)) {
    const parsed = parseCentrisFromHtml(url, direct.html);
    if (parsed.price !== "N/A" || parsed.beds != null || parsed.baths != null || parsed.address) return parsed;
  }

  // 2) Playwright "real session" fetch (cookies + networkidle)
  const pw = await fetchCentrisHtmlPlaywrightSession(url);

  // If blocked, DO NOT throw.
  // Return a best-effort listing so your frontend can still show something.
  if (!pw?.html || pw.html.length < 1200 || looksBlocked(pw.html)) {
    return {
      url,
      source: "Centris",
      address: cleanText(addressHint || "") || "",
      price: "N/A",
      beds: null,
      baths: null,
      levels: null,
      area: null,
      condoFees: "N/A",
      contact: "N/A",
      _blocked: true,
      _diag: {
        title: pw?.title || "",
        finalUrl: pw?.finalUrl || "",
      },
    };
  }

  const parsed = parseCentrisFromHtml(url, pw.html);
  return parsed;
}

async function scrapeDuProprio(url) {
  // Direct
  const direct = await fetchHtmlDirect(url, 6500);
  if (direct.ok && !looksBlocked(direct.html)) {
    const parsed = parseDuProprioFromHtml(url, direct.html);
    if (parsed.price !== "N/A" || parsed.beds != null || parsed.area != null) return parsed;
  }

  // Playwright (fast routes ok for DP)
  await ensureBrowser();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(25000);
  page.setDefaultTimeout(25000);
  await enableFastRoutesDuProprio(page);

  try {
    await gotoWithRetries(page, url, { navTimeoutMs: 25000, tries: 1, waitUntil: "domcontentloaded" });
    await waitForAny(
      page,
      [
        ".listing-price__amount",
        ".listing-main-characteristics__item",
        "meta[property='product:price:amount']",
        "script[type='application/ld+json']",
        "body",
      ],
      12000
    ).catch(() => "");
    await page.waitForTimeout(180);

    const html = await withHardTimeout(page.content(), 12000, "content timeout");
    const title = await page.title().catch(() => "");
    const finalUrl = page.url();

    if (!html || html.length < 1200 || looksBlocked(html)) {
      throw new Error(`duproprio blocked/empty (title="${title}" url="${finalUrl}")`);
    }

    const parsed = parseDuProprioFromHtml(url, html);
    if (parsed.price === "N/A" && parsed.beds == null && parsed.area == null) {
      throw new Error(`duproprio missing fields (title="${title}" url="${finalUrl}")`);
    }
    return parsed;
  } finally {
    await page.close().catch(() => {});
  }
}

// -------------------- API --------------------
app.get("/api/listing", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const addressHint = String(req.query.addressHint || "").trim();
  const refresh = String(req.query.refresh || "").trim() === "1";

  if (!url) return res.status(400).json({ ok: false, error: "Missing url parameter." });

  const src = detectSource(url);
  if (src === "unknown") return res.status(400).json({ ok: false, error: "Unknown listing source." });

  const key = makeCacheKey(url, addressHint);

  const cached = !refresh ? getCached(key) : null;
  if (cached) return res.json({ ok: true, listing: cached, cached: true });

  const existing = !refresh ? inflight.get(key) : null;
  if (existing) {
    try {
      const listing = await withHardTimeout(existing, 30000, "inflight timeout");
      return res.json({ ok: true, listing, cached: false, deduped: true });
    } catch (e) {
      // return best-effort instead of 500
      return res.json({
        ok: true,
        listing: {
          url,
          source: src === "centris" ? "Centris" : "DuProprio",
          address: cleanText(addressHint) || "N/A",
          price: "N/A",
          beds: null,
          baths: null,
          levels: null,
          area: null,
          condoFees: "N/A",
          contact: "N/A",
          _error: `Scrape failed: ${e?.message || e}`,
        },
        cached: false,
      });
    }
  }

  const p = (async () => {
    await scrapeGate.acquire();
    try {
      const t0 = Date.now();

      let listing;
      if (src === "centris") listing = await withHardTimeout(scrapeCentris(url, addressHint), 42000, "centris timeout");
      else listing = await withHardTimeout(scrapeDuProprio(url), 42000, "duproprio timeout");

      const safeScraped = sanitizeAddressOrBlank(listing.address);
      const finalAddress = safeScraped || cleanText(addressHint) || "N/A";
      const finalListing = { ...listing, address: finalAddress };

      const looksGood =
        finalListing.price !== "N/A" ||
        finalListing.beds != null ||
        finalListing.baths != null ||
        (finalListing.area && finalListing.area !== "N/A") ||
        (finalListing.condoFees && finalListing.condoFees !== "N/A") ||
        (finalListing.address && finalListing.address !== "N/A");

      if (looksGood && !finalListing._blocked) setCached(key, finalListing);

      console.log(`[scrape] ${src} ${Date.now() - t0}ms refresh=${refresh ? "1" : "0"} ${url}`);
      return finalListing;
    } finally {
      scrapeGate.release();
    }
  })();

  inflight.set(key, p);

  try {
    const listing = await p;
    return res.json({ ok: true, listing, cached: false, refresh });
  } catch (e) {
    // IMPORTANT: never 500 for Centris blocks. Return something usable.
    return res.json({
      ok: true,
      listing: {
        url,
        source: src === "centris" ? "Centris" : "DuProprio",
        address: cleanText(addressHint) || "N/A",
        price: "N/A",
        beds: null,
        baths: null,
        levels: null,
        area: null,
        condoFees: "N/A",
        contact: "N/A",
        _error: `Scrape failed: ${e?.message || e}`,
      },
      cached: false,
      refresh,
    });
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
    await ensureBrowser(); // warm-up
  } catch (e) {
    console.error("Browser warmup failed:", e?.message || e);
  }
  console.log(`Server running on port ${PORT}`);
});
