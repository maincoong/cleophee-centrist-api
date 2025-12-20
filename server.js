// server.js (ESM)
// npm i express compression cheerio playwright
// npx playwright install chromium

import express from "express";
import compression from "compression";
import { chromium } from "playwright";
import { load } from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());

/* -------------------- CORS -------------------- */
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

/* -------------------- Cache (fresh + stale) -------------------- */
const FRESH_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STALE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours: serve stale if needed

const cache = new Map(); // key -> { ts, data }
const inflight = new Map(); // key -> Promise

function makeCacheKey(url, addressHint) {
  return `${url}::hint=${(addressHint || "").trim()}`;
}

function getCachedWithState(key) {
  const hit = cache.get(key);
  if (!hit) return { hit: null, state: "miss" };

  const age = Date.now() - hit.ts;
  if (age <= FRESH_TTL_MS) return { hit: hit.data, state: "fresh" };
  if (age <= STALE_TTL_MS) return { hit: hit.data, state: "stale" };

  cache.delete(key);
  return { hit: null, state: "miss" };
}

function setCached(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

/* -------------------- Helpers -------------------- */
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

/* -------------------- Address validation -------------------- */
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

/* -------------------- Semaphore (per-host) -------------------- */
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

const gates = new Map();
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}
function getGateForUrl(url) {
  const host = hostOf(url);
  const max = 2; // allow a bit of parallelism per host
  if (!gates.has(host)) gates.set(host, createSemaphore(max));
  return gates.get(host);
}

/* -------------------- Hard timeout -------------------- */
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

/* -------------------- Direct HTTP fetch (fast path) -------------------- */
function looksLikeUsefulHtml(html, src) {
  const t = (html || "").toLowerCase();
  if (!t) return false;

  const looksHtml = t.includes("<html") || t.includes("<!doctype html");
  if (!looksHtml) return false;

  // blocks
  if (t.includes("captcha")) return false;
  if (t.includes("access denied")) return false;
  if (t.includes("please enable javascript")) return false;

  // source markers (accept smaller payloads if they contain the right signals)
  if (src === "centris") {
    if (t.includes("__next_data__")) return true;
    if (t.includes("data-cy=\"buyprice\"") || t.includes("data-cy='buyprice'")) return true;
  }
  if (src === "duproprio") {
    if (t.includes("application/ld+json")) return true;
    if (t.includes("product:price:amount") || t.includes("og:price:amount")) return true;
  }

  // fallback size threshold
  return html.length >= 900;
}

async function fetchHtmlDirect(url, src, timeoutMs = 6500) {
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
      },
    });

    const html = await res.text().catch(() => "");

    if (!res.ok) return { ok: false, status: res.status, html };
    if (!looksLikeUsefulHtml(html, src)) return { ok: false, status: res.status, html };

    return { ok: true, status: res.status, html };
  } catch (e) {
    return { ok: false, status: 0, html: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* -------------------- Playwright global reuse (fallback) -------------------- */
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
    // Do NOT block scripts/xhr/fetch or you can break data.
    if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
      return route.abort();
    }
    return route.continue();
  });
}

async function fetchHtmlPlaywright(url) {
  await ensureBrowser();
  const page = await context.newPage();

  page.setDefaultNavigationTimeout(9500);
  page.setDefaultTimeout(9500);

  await enableFastRoutes(page);

  try {
    await withHardTimeout(page.goto(url, { waitUntil: "domcontentloaded" }), 9500, "nav timeout");
    const html = await withHardTimeout(page.content(), 5500, "content timeout");
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

/* -------------------- Structured Playwright (fast) -------------------- */
async function fetchDuProprioStructuredPlaywright(url) {
  await ensureBrowser();
  const page = await context.newPage();

  page.setDefaultNavigationTimeout(9500);
  page.setDefaultTimeout(9500);

  await enableFastRoutes(page);

  try {
    await withHardTimeout(page.goto(url, { waitUntil: "domcontentloaded" }), 9500, "nav timeout");

    const data = await withHardTimeout(
      page.evaluate(() => {
        const getMeta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
        const metaAmount =
          getMeta("meta[property='product:price:amount']") ||
          getMeta("meta[property='og:price:amount']") ||
          getMeta("meta[name='twitter:data1']") ||
          "";

        const ld = Array.from(document.querySelectorAll("script[type='application/ld+json']"))
          .map((s) => s.textContent || "")
          .filter(Boolean);

        const getText = (sel) => (document.querySelector(sel)?.textContent || "").trim();

        return {
          metaAmount,
          ldjson: ld,
          bedsText: getText(".listing-main-characteristics__icon--bedrooms ~ .listing-main-characteristics__number"),
          bathsText: getText(".listing-main-characteristics__icon--bathrooms ~ .listing-main-characteristics__number"),
          dimText: getText(
            "span.listing-main-characteristics__number.listing-main-characteristics__number--dimensions"
          ),
        };
      }),
      5500,
      "dp structured eval timeout"
    );

    return data;
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchCentrisStructuredPlaywright(url) {
  await ensureBrowser();
  const page = await context.newPage();

  page.setDefaultNavigationTimeout(9500);
  page.setDefaultTimeout(9500);

  await enableFastRoutes(page);

  try {
    await withHardTimeout(page.goto(url, { waitUntil: "domcontentloaded" }), 9500, "nav timeout");
    await page.waitForTimeout(350);

    const data = await withHardTimeout(
      page.evaluate(() => {
        const txt = (sel) => (document.querySelector(sel)?.textContent || "").trim();
        const buyPrice = txt("[data-cy='buyPrice']") || txt("[data-cy='price']") || "";
        const address = txt("[data-cy='address']") || txt("[itemprop='address']") || "";
        return { buyPrice, address };
      }),
      2500,
      "centris eval timeout"
    );

    return data;
  } finally {
    await page.close().catch(() => {});
  }
}

/* -------------------- Shutdown -------------------- */
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

/* -------------------- Centris parser (cheerio) -------------------- */
function parseCentrisFromHtml(url, html) {
  const $ = load(html);

  let price = "—";
  const priceText =
    cleanText($("[data-cy='buyPrice']").first().text()) ||
    cleanText($("[data-cy='price']").first().text()) ||
    cleanText($(".price").first().text());
  if (priceText) {
    const m = priceText.match(/\$[\s0-9,]+/);
    if (m) price = cleanText(m[0]);
    else if (priceText.includes("$")) price = priceText;
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
}

/* -------------------- DuProprio fast parser (JSON-LD first) -------------------- */
function parseDuProprioFromHtmlFast(url, html) {
  const $ = load(html);

  let price = "—";
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

  const condoFees = "—";

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
    area: area ? normalizeAreaToFt2(area) : null,
    condoFees: ensureMonthlyFeesString(condoFees),
    contact,
  };
}

function parseDuProprioFromStructured(url, structured) {
  let price = "—";
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
    condoFees: "—",
    contact: "—",
  };
}

/* -------------------- Scrape orchestrators -------------------- */
async function scrapeCentris(url) {
  const direct = await fetchHtmlDirect(url, "centris", 7000);
  if (direct.ok) return parseCentrisFromHtml(url, direct.html);

  // structured Playwright first (avoid page.content most of the time)
  const structured = await fetchCentrisStructuredPlaywright(url);
  if (structured?.buyPrice) {
    return {
      url,
      source: "Centris",
      address: sanitizeAddressOrBlank(structured.address) || "",
      price: structured.buyPrice,
      beds: null,
      baths: null,
      levels: null,
      area: null,
      condoFees: "—",
      contact: "—",
    };
  }

  // last resort
  const html = await fetchHtmlPlaywright(url);
  return parseCentrisFromHtml(url, html);
}

async function scrapeDuProprio(url) {
  const direct = await fetchHtmlDirect(url, "duproprio", 5500);
  if (direct.ok) return parseDuProprioFromHtmlFast(url, direct.html);

  const structured = await fetchDuProprioStructuredPlaywright(url);
  if (structured && (structured.metaAmount || (structured.ldjson && structured.ldjson.length))) {
    return parseDuProprioFromStructured(url, structured);
  }

  const html = await fetchHtmlPlaywright(url);
  return parseDuProprioFromHtmlFast(url, html);
}

async function refreshInBackground({ key, src, url, addressHint }) {
  if (inflight.has(key)) return;

  const p = (async () => {
    const gate = getGateForUrl(url);
    await gate.acquire();
    try {
      let listing;
      if (src === "centris") listing = await withHardTimeout(scrapeCentris(url), 18000, "centris timeout");
      else listing = await withHardTimeout(scrapeDuProprio(url), 14000, "duproprio timeout");

      const safeScraped = sanitizeAddressOrBlank(listing.address);
      const finalAddress = safeScraped || cleanText(addressHint) || "—";
      const finalListing = { ...listing, address: finalAddress };

      setCached(key, finalListing);
      return finalListing;
    } finally {
      gate.release();
    }
  })();

  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
}

/* -------------------- API -------------------- */
app.get("/api/listing", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const addressHint = String(req.query.addressHint || "").trim();

  if (!url) return res.status(400).json({ ok: false, error: "Missing url parameter." });

  const src = detectSource(url);
  if (src === "unknown") return res.status(400).json({ ok: false, error: "Unknown listing source." });

  const key = makeCacheKey(url, addressHint);

  // Helpful, small CDN/browser cache for the API response itself
  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=300");

  // Serve cached immediately if available
  const { hit, state } = getCachedWithState(key);

  if (hit && state === "fresh") {
    return res.json({ ok: true, listing: hit, cached: true, cacheState: "fresh" });
  }

  if (hit && state === "stale") {
    refreshInBackground({ key, src, url, addressHint }).catch(() => {});
    return res.json({ ok: true, listing: hit, cached: true, cacheState: "stale" });
  }

  // If a scrape is already running for this key, wait briefly
  const existing = inflight.get(key);
  if (existing) {
    try {
      const listing = await withHardTimeout(existing, 16000, "inflight timeout");
      return res.json({ ok: true, listing, cached: false, deduped: true, cacheState: "miss" });
    } catch (e) {
      return res.status(500).json({ ok: false, error: `Scrape failed: ${e?.message || e}` });
    }
  }

  // Start scrape
  const p = (async () => {
    const gate = getGateForUrl(url);
    await gate.acquire();
    try {
      const t0 = Date.now();

      let listing;
      if (src === "centris") listing = await withHardTimeout(scrapeCentris(url), 18000, "centris timeout");
      else listing = await withHardTimeout(scrapeDuProprio(url), 14000, "duproprio timeout");

      const safeScraped = sanitizeAddressOrBlank(listing.address);
      const finalAddress = safeScraped || cleanText(addressHint) || "—";
      const finalListing = { ...listing, address: finalAddress };

      setCached(key, finalListing);

      console.log(`[scrape] ${src} ${Date.now() - t0}ms ${url}`);
      return finalListing;
    } finally {
      gate.release();
    }
  })();

  inflight.set(key, p);

  try {
    const listing = await p;
    return res.json({ ok: true, listing, cached: false, cacheState: "miss" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Scrape failed: ${e?.message || e}` });
  } finally {
    inflight.delete(key);
  }
});

/* -------------------- Root -------------------- */
app.get("/", (req, res) => {
  res.type("text").send("OK");
});

/* -------------------- Start -------------------- */
app.listen(PORT, async () => {
  // Warm Playwright so fallback is faster when needed
  try {
    await ensureBrowser();
  } catch (e) {
    console.error("Browser warmup failed:", e?.message || e);
  }
  console.log(`Server running on port ${PORT}`);
});
