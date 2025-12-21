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
// NOTE: cache can preserve bad scrapes. Provide refresh=1 to bypass.
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
  const m = t.match(/\$\s*[\d\s,]{3,}/); // "$579,000"
  return m ? cleanText(m[0]) : "";
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

// -------------------- Playwright global reuse --------------------
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
    locale: "en-CA",
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

// -------------------- Playwright safety helpers --------------------
function isExecutionContextDestroyed(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("Execution context was destroyed") || msg.includes("because of a navigation");
}

async function safeEvaluate(page, fn, { timeoutMs = 8000, retries = 2, label = "eval" } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      await page.waitForTimeout(120);
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

async function gotoWithRetries(page, url, opts = {}) {
  const { navTimeoutMs = 28000, tries = 2, waitUntil = "domcontentloaded" } = opts;
  let lastErr;

  for (let attempt = 0; attempt <= tries; attempt += 1) {
    try {
      await withHardTimeout(page.goto(url, { waitUntil }), navTimeoutMs, "nav timeout");
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e || "");
      const isTimeout = msg.toLowerCase().includes("timeout");
      if (!isTimeout) throw e;

      try {
        await page.waitForTimeout(300);
        await page.evaluate(() => (window.stop ? window.stop() : null)).catch(() => {});
      } catch {}

      if (attempt < tries) {
        await page.waitForTimeout(600);
        try {
          await withHardTimeout(page.goto(url, { waitUntil: "commit" }), navTimeoutMs, "nav timeout");
          return;
        } catch (e2) {
          lastErr = e2;
        }
      }
    }
  }

  throw lastErr;
}

// -------------------- Playwright fetchers --------------------
async function fetchHtmlPlaywright(url, { expectSelector, waitUntil = "domcontentloaded" } = {}) {
  await ensureBrowser();
  const page = await context.newPage();

  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(30000);

  await enableFastRoutes(page);

  try {
    await gotoWithRetries(page, url, { navTimeoutMs: 28000, tries: 2, waitUntil });

    if (expectSelector) {
      await page.waitForSelector(expectSelector, { timeout: 15000 });
      await page.waitForTimeout(150); // settle
    } else {
      await page.waitForTimeout(250);
    }

    const html = await withHardTimeout(page.content(), 12000, "content timeout");
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

// Structured DuProprio scrape: uses *real* DOM selectors (price + characteristics + fees best-effort)
async function fetchDuProprioStructuredPlaywright(url) {
  await ensureBrowser();
  const page = await context.newPage();

  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(30000);

  await enableFastRoutes(page);

  try {
    await gotoWithRetries(page, url, { navTimeoutMs: 28000, tries: 2, waitUntil: "domcontentloaded" });

    // STRICT waits (do not swallow). If these don't appear, we want to fall back.
    await page.waitForSelector(".listing-price__amount", { timeout: 15000 });
    await page.waitForSelector(".listing-main-characteristics__item", { timeout: 15000 });
    await page.waitForTimeout(150);

    const data = await safeEvaluate(
      page,
      () => {
        const getMeta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
        const getText = (sel) => (document.querySelector(sel)?.textContent || "").trim();
        const toLine = (s) => (s || "").replace(/\s+/g, " ").trim();

        const metaAmount =
          getMeta("meta[property='product:price:amount']") ||
          getMeta("meta[property='og:price:amount']") ||
          getMeta("meta[name='twitter:data1']") ||
          "";

        const domPriceText = toLine(getText(".listing-price__amount"));

        // Characteristics: parse the blocks exactly like your devtools screenshots
        let bedsText = "";
        let bathsText = "";
        let dimText = "";

        const items = Array.from(document.querySelectorAll(".listing-main-characteristics__item"));
        for (const item of items) {
          const number = toLine(item.querySelector(".listing-main-characteristics__number")?.textContent || "");
          const title = toLine(item.querySelector(".listing-main-characteristics__title")?.textContent || "");
          const titleLower = title.toLowerCase();
          const cls = (item.getAttribute("class") || "").toLowerCase();

          if (!bedsText && (titleLower === "bedrooms" || titleLower.includes("bedroom"))) bedsText = number;
          if (!bathsText && (titleLower === "bathrooms" || titleLower.includes("bathroom") || titleLower === "bath"))
            bathsText = number;

          // dimensions block: either class contains item-dimensions or number includes ft²/sqft
          const isDim = cls.includes("item-dimensions");
          if (!dimText && (isDim || number.includes("ft²") || number.toLowerCase().includes("sqft"))) dimText = number;
        }

        // Condo fees (best effort):
        // Try a few likely elements first (cheap), then a limited scan.
        let condoFeesText =
          toLine(getText(".listing-fees__amount")) ||
          toLine(getText(".listing-financial__amount")) ||
          toLine(getText("[data-testid*='condo']")) ||
          "";

        if (!condoFeesText) {
          const nodes = Array.from(document.querySelectorAll("div, span, li, p")).slice(0, 2500);
          for (let i = 0; i < nodes.length; i += 1) {
            const line = toLine(nodes[i].textContent || "");
            const low = line.toLowerCase();
            if (!line) continue;

            if (low.includes("condo fees") || low.includes("condominium fees") || low.includes("frais de condo")) {
              const m = line.match(/\$\s*[\d\s,]{2,}(?:\.\d{2})?/);
              if (m) {
                condoFeesText = m[0];
                break;
              }
              // look ahead
              const next = toLine(nodes[i + 1]?.textContent || "");
              const m2 = next.match(/\$\s*[\d\s,]{2,}(?:\.\d{2})?/);
              if (m2) {
                condoFeesText = m2[0];
                break;
              }
            }
          }
        }

        // JSON-LD kept as optional (sometimes useful for address)
        const ld = Array.from(document.querySelectorAll("script[type='application/ld+json']"))
          .map((s) => s.textContent || "")
          .filter(Boolean);

        return {
          metaAmount,
          domPriceText,
          bedsText,
          bathsText,
          dimText,
          condoFeesText,
          ldjson: ld,
        };
      },
      { timeoutMs: 9000, retries: 2, label: "dp structured eval" }
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

// -------------------- DuProprio parser (cheerio) --------------------
function parseDuProprioFromHtml(url, html) {
  const $ = load(html);

  // Price: DOM first, then meta
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

  // Characteristics
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

  // Condo fees: selector + text fallback
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

  // Address + contact
  let address =
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

function parseDuProprioFromStructured(url, structured) {
  // Price: DOM first
  let price = "N/A";
  const domPrice = cleanText(structured?.domPriceText || "");
  if (domPrice) price = domPrice;

  if (price === "N/A") {
    const metaAmount = cleanText(structured?.metaAmount || "");
    if (metaAmount) {
      const n = moneyToNumber(metaAmount);
      if (n != null) price = formatMoney(n);
    }
  }

  // Beds/baths/area
  const b1 = cleanText(structured?.bedsText || "");
  const b2 = cleanText(structured?.bathsText || "");
  const d1 = cleanText(structured?.dimText || "");

  const nb = b1 ? Number(b1.replace(/[^\d.]/g, "")) : null;
  const na = b2 ? Number(b2.replace(/[^\d.]/g, "")) : null;

  const beds = Number.isFinite(nb) ? nb : null;
  const baths = Number.isFinite(na) ? na : null;

  const area = d1 ? normalizeAreaToFt2(d1) : null;

  // Condo fees
  let condoFees = cleanText(structured?.condoFeesText || "") || "N/A";
  if (condoFees && condoFees !== "N/A" && !condoFees.includes("$")) {
    const maybe = extractMoneyFromText(condoFees);
    if (maybe) condoFees = maybe;
  }
  condoFees = ensureMonthlyFeesString(condoFees);

  return {
    url,
    source: "DuProprio",
    address: "",
    price,
    beds,
    baths,
    levels: null,
    area,
    condoFees,
    contact: "N/A",
  };
}

// -------------------- Scrape orchestrator --------------------
async function scrapeCentris(url) {
  const direct = await fetchHtmlDirect(url, 7000);
  if (direct.ok && !looksBlocked(direct.html)) {
    return parseCentrisFromHtml(url, direct.html);
  }

  const html = await fetchHtmlPlaywright(url, {
    expectSelector: "[data-cy='buyPrice'], [data-cy='price'], [data-cy='address']",
    waitUntil: "domcontentloaded",
  });
  return parseCentrisFromHtml(url, html);
}

async function scrapeDuProprio(url) {
  // 1) Direct fetch: cheap
  const direct = await fetchHtmlDirect(url, 6500);
  if (direct.ok && !looksBlocked(direct.html)) {
    const parsed = parseDuProprioFromHtml(url, direct.html);
    if (parsed.price !== "N/A" || parsed.beds != null || parsed.area != null) return parsed;
  }

  // 2) Structured Playwright (best)
  try {
    const structured = await fetchDuProprioStructuredPlaywright(url);
    const parsed = parseDuProprioFromStructured(url, structured);
    // Helpful debug (comment out later)
    // console.log("[dp structured]", structured);
    if (parsed.price !== "N/A" || parsed.beds != null || parsed.area != null) return parsed;
  } catch {
    // fall through
  }

  // 3) Full HTML Playwright with selector wait
  const html = await fetchHtmlPlaywright(url, {
    expectSelector: ".listing-price__amount, .listing-main-characteristics__item",
    waitUntil: "domcontentloaded",
  });
  return parseDuProprioFromHtml(url, html);
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
      return res.status(500).json({ ok: false, error: `Scrape failed: ${e?.message || e}` });
    }
  }

  const p = (async () => {
    await scrapeGate.acquire();
    try {
      const t0 = Date.now();

      let listing;
      if (src === "centris") listing = await withHardTimeout(scrapeCentris(url), 38000, "centris timeout");
      else listing = await withHardTimeout(scrapeDuProprio(url), 36000, "duproprio timeout");

      const safeScraped = sanitizeAddressOrBlank(listing.address);
      const finalAddress = safeScraped || cleanText(addressHint) || "N/A";
      const finalListing = { ...listing, address: finalAddress };

      // Only cache if it looks like a "real" scrape (prevents caching empty garbage)
      const looksGood =
        finalListing.price !== "N/A" ||
        finalListing.beds != null ||
        finalListing.baths != null ||
        (finalListing.area && finalListing.area !== "N/A");

      if (looksGood) {
        setCached(key, finalListing);
      } else {
        // If you want: cache short for errors instead of 6 hours.
        // Here we simply do not cache bad results.
      }

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
  // Warm Playwright
  try {
    await ensureBrowser();
  } catch (e) {
    console.error("Browser warmup failed:", e?.message || e);
  }
  console.log(`Server running on port ${PORT}`);
});
