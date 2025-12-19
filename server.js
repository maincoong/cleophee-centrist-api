// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { load } from "cheerio";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve ONLY /public (put your HTML + images + fonts in /public)
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- helpers ---------------- */

function cleanSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function firstTruthy(arr) {
  for (const v of arr) {
    if (v !== null && v !== undefined && v !== "" && v !== "—") return v;
  }
  return null;
}

function numberFromMoneyLike(s) {
  const digits = cleanSpaces(s).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function formatCAD(n) {
  if (!Number.isFinite(n)) return null;
  return "$" + n.toLocaleString("en-CA");
}

function pickReasonablePriceFromCandidates(candidates) {
  const MIN = 50000;
  const MAX = 3000000;
  for (const c of candidates) {
    const n = numberFromMoneyLike(c);
    if (n && n >= MIN && n <= MAX) return formatCAD(n);
  }
  return null;
}

function extractCountsFromText(text) {
  const t = cleanSpaces(text);

  function find(labelSingular, labelPlural) {
    const labels = [labelPlural, labelSingular].filter(Boolean);

    for (const lab of labels) {
      const m1 = t.match(new RegExp(String.raw`(\d+)\s+${lab}\b`, "i"));
      if (m1) return Number(m1[1]);
    }

    for (const lab of labels) {
      const m2 = t.match(new RegExp(String.raw`\b${lab}\s*[:\-]?\s*(\d+)\b`, "i"));
      if (m2) return Number(m2[1]);
    }

    return null;
  }

  return {
    beds: find("bedroom", "bedrooms"),
    baths: find("bathroom", "bathrooms"),
    levels: find("level", "levels"),
  };
}

function extractAreaFromText(text) {
  const t = cleanSpaces(text);

  const m = t.match(/([\d,]+)\s*ft²\s*\(([\d.]+)\s*m²\)/i);
  if (m) return `${m[1]} ft² (${m[2]} m²)`;

  const m2 = t.match(/([\d,]+)\s*ft²/i);
  if (m2) return `${m2[1]} ft²`;

  return null;
}

function extractCondoFeesFromText(text) {
  const t = cleanSpaces(text);

  const m = t.match(/Condo fees[^$]*\$\s*([\d,]+(?:\.\d+)?)/i);
  if (m) return `$${m[1]} / month`;

  const m2 = t.match(/Condo fees[^0-9]*([\d,]+)\s*\$/i);
  if (m2) return `$${m2[1]} / month`;

  const m3 = t.match(/Frais[^$]*\$\s*([\d,]+(?:\.\d+)?)/i);
  if (m3) return `$${m3[1]} / month`;

  return null;
}

function extractJsonLdFromCheerio($) {
  const out = [];
  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text();
    const parsed = safeJsonParse(raw);
    if (!parsed) return;
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  });
  return out;
}

function findPriceInJsonLd(ld) {
  for (const obj of ld) {
    if (!obj || typeof obj !== "object") continue;

    const offers = obj.offers;
    const offersArr = Array.isArray(offers) ? offers : (offers ? [offers] : []);
    for (const off of offersArr) {
      const p = off?.price ?? off?.priceSpecification?.price;
      const n = Number(String(p ?? "").replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n > 0) return formatCAD(n);
    }

    const main = obj.mainEntity;
    if (main && typeof main === "object") {
      const maybe = main?.offers?.price;
      const n2 = Number(String(maybe ?? "").replace(/[^\d]/g, ""));
      if (Number.isFinite(n2) && n2 > 0) return formatCAD(n2);
    }
  }
  return null;
}

function findAddressInJsonLd(ld) {
  for (const obj of ld) {
    const addr = obj?.address;
    if (!addr) continue;

    if (typeof addr === "string") return cleanSpaces(addr);

    if (typeof addr === "object") {
      const parts = [
        addr.streetAddress,
        addr.addressLocality,
        addr.addressRegion,
        addr.postalCode,
      ].filter(Boolean);
      if (parts.length) return cleanSpaces(parts.join(", "));
    }
  }
  return null;
}

function regexBuyPriceNearLabel(text) {
  const t = cleanSpaces(text);

  const m = t.match(/\bBuy\s*price\b[^$]{0,40}(\$[\d,]{3,})/i);
  if (m) return pickReasonablePriceFromCandidates([m[1]]);

  const m2 = t.match(/\bPrix\b[^$]{0,40}(\$[\d,]{3,})/i);
  if (m2) return pickReasonablePriceFromCandidates([m2[1]]);

  return null;
}

/* ---------------- DuProprio ---------------- */

async function scrapeDuProprio(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-CA,en;q=0.9",
    },
  });

  if (!r.ok) return { ok: false, error: `DuProprio fetch failed (${r.status})` };

  const html = await r.text();
  const $ = load(html);
  const flatText = cleanSpaces($("body").text());

  const ld = extractJsonLdFromCheerio($);
  const ldPrice = findPriceInJsonLd(ld);
  const ldAddr = findAddressInJsonLd(ld);

  const metaItemPrice = $('meta[itemprop="price"]').attr("content") || "";
  const metaOgTitle = $('meta[property="og:title"]').attr("content") || "";
  const metaOgDesc = $('meta[property="og:description"]').attr("content") || "";

  const ogTitlePrice = (metaOgTitle.match(/\$[\d,]{3,}/) || [null])[0];

  const metaPrice = pickReasonablePriceFromCandidates([
    metaItemPrice,
    ogTitlePrice,
  ]);

  const moneyMatches = flatText.match(/\$[\d,]{3,}/g) || [];

  const price =
    firstTruthy([
      ldPrice,
      metaPrice,
      pickReasonablePriceFromCandidates(moneyMatches),
    ]) || "—";

  const address =
    firstTruthy([ldAddr, cleanSpaces(metaOgDesc)]) || "—";

  const counts = extractCountsFromText(flatText);
  const area = extractAreaFromText(flatText);
  const fees = extractCondoFeesFromText(flatText);

  return {
    ok: true,
    listing: {
      url,
      source: "DuProprio",
      address,
      price,
      beds: counts.beds ?? null,
      baths: counts.baths ?? null,
      levels: counts.levels ?? null,
      area: area || null,
      condoFees: fees || null,
      contact: "1 866 387-7677",
    },
  };
}

/* ---------------- Centris (Playwright) ---------------- */

async function scrapeCentris(url) {
  let browser = null;

  try {
    const { chromium } = await import("playwright");

    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      locale: "en-CA",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Try to dismiss cookie/consent overlays if present
    const consentSelectors = [
      "button:has-text('Accept')",
      "button:has-text('I accept')",
      "button:has-text('Agree')",
      "button:has-text('Continue')",
      "button:has-text('OK')",
      "button:has-text('Tout accepter')",
      "button:has-text('Accepter')",
    ];
    for (const sel of consentSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count()) {
          await btn.click({ timeout: 1000 }).catch(() => {});
          break;
        }
      } catch {}
    }

    // Let the page hydrate and tables render
    await page.waitForTimeout(800);
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    await page.waitForSelector("table tr td", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);

    const data = await page.evaluate(() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

      // 1) TABLE KV: "Label | Value"
      const kv = {};
      const rows = Array.from(document.querySelectorAll("table tr"));
      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll("td, th"));
        if (cells.length < 2) continue;

        const key = clean(cells[0].textContent);
        const val = clean(cells[cells.length - 1].textContent);

        if (!key || !val) continue;
        if (!kv[key] || String(val).length > String(kv[key]).length) kv[key] = val;
      }

      // 2) CARAC KV: blocks like "Net area" -> "912 sqft"
      const carac = {};
      const titles = Array.from(document.querySelectorAll(".carac-title"));
      for (const titleEl of titles) {
        const key = clean(titleEl.textContent);
        const wrap = titleEl.parentElement;
        if (!wrap) continue;

        const valEl = wrap.querySelector(".carac-value");
        const val = clean(valEl?.textContent || "");
        if (!key || !val) continue;

        carac[key] = val;
      }

      // Price candidates
      const buyEl =
        document.querySelector("#BuyPrice") ||
        document.querySelector("[id*='BuyPrice']") ||
        document.querySelector("[data-testid*='BuyPrice']");

      const buyPriceText = clean(buyEl?.textContent || "");

      const metaItemPrice =
        document.querySelector("meta[itemprop='price']")?.getAttribute("content") || "";

      const metaOgPrice =
        document.querySelector("meta[property='og:price:amount']")?.getAttribute("content") ||
        document.querySelector("meta[property='product:price:amount']")?.getAttribute("content") ||
        "";

      // JSON-LD
      const ld = [];
      document.querySelectorAll("script[type='application/ld+json']").forEach((s) => {
        try {
          const parsed = JSON.parse(s.textContent || "");
          if (Array.isArray(parsed)) ld.push(...parsed);
          else ld.push(parsed);
        } catch {}
      });

      const bodyText = clean(document.body?.innerText || "");
      return { kv, carac, buyPriceText, metaItemPrice, metaOgPrice, ld, bodyText };
    });

    const kv = data.kv || {};
    const carac = data.carac || {};

    const norm = (s) =>
      cleanSpaces(String(s || ""))
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

    function findFromMapsStrict(possibleKeys) {
      const targets = possibleKeys.map(norm);

      // exact-ish match first (after normalization)
      for (const [k, v] of Object.entries(kv)) {
        const nk = norm(k);
        if (targets.includes(nk)) return cleanSpaces(v);
      }
      for (const [k, v] of Object.entries(carac)) {
        const nk = norm(k);
        if (targets.includes(nk)) return cleanSpaces(v);
      }

      // fallback: contains match
      for (const [k, v] of Object.entries(kv)) {
        const nk = norm(k);
        if (targets.some((t) => nk.includes(t))) return cleanSpaces(v);
      }
      for (const [k, v] of Object.entries(carac)) {
        const nk = norm(k);
        if (targets.some((t) => nk.includes(t))) return cleanSpaces(v);
      }

      return null;
    }

    // Price from JSON-LD offers.price
    let ldPrice = null;
    for (const obj of data.ld || []) {
      const offers = obj?.offers;
      const offersArr = Array.isArray(offers) ? offers : offers ? [offers] : [];
      for (const off of offersArr) {
        const p = off?.price ?? off?.priceSpecification?.price;
        const n = Number(String(p ?? "").replace(/[^\d]/g, ""));
        if (Number.isFinite(n) && n > 0) {
          ldPrice = formatCAD(n);
          break;
        }
      }
      if (ldPrice) break;
    }

    const targeted = regexBuyPriceNearLabel(data.bodyText);

    const price =
      firstTruthy([
        pickReasonablePriceFromCandidates([data.buyPriceText]),
        pickReasonablePriceFromCandidates([data.metaItemPrice, data.metaOgPrice]),
        ldPrice,
        targeted,
        pickReasonablePriceFromCandidates(data.bodyText.match(/\$[\d,]{3,}/g) || []),
      ]) || "—";

    // STRICT condo fee key
    const rawFees = findFromMapsStrict([
      "Condominium fees",
      "Condo fees",
      "Frais de copropriété",
    ]);

    let condoFees = null;
    if (rawFees) {
      const feeNum = numberFromMoneyLike(rawFees);
      if (feeNum && feeNum > 0) condoFees = `$${feeNum.toLocaleString("en-CA")} / month`;
    }
    if (!condoFees) condoFees = extractCondoFeesFromText(data.bodyText);

    // Net area from carac blocks
    const rawArea = findFromMapsStrict([
      "Net area",
      "Living area",
      "Floor area",
      "Superficie",
      "Surface habitable",
    ]);

    let area = null;
    if (rawArea) {
      const t = cleanSpaces(rawArea);

      const sf = t.match(/([\d,.]+)\s*(sq\s*ft|sqft|sq\s*feet|ft²|sqf)/i);
      const m2 = t.match(/([\d,.]+)\s*(m²|sqm|sq\s*m)/i);

      if (sf && m2) {
        area = `${sf[1]} ft² (${m2[1]} m²)`;
      } else if (sf) {
        area = `${sf[1]} ft²`;
      } else if (m2) {
        area = `${m2[1]} m²`;
      }
    }
    if (!area) area = extractAreaFromText(data.bodyText);

    // Beds/baths from tables or carac blocks, then fallback to body text
    const rawBeds = findFromMapsStrict(["Bedrooms", "Bedroom", "Chambres", "Rooms"]);
    const rawBaths = findFromMapsStrict(["Bathrooms", "Bathroom", "Salle de bain", "Salles de bain"]);

    const countsFromText = extractCountsFromText(data.bodyText);

    const beds =
      firstTruthy([
        rawBeds && Number(String(rawBeds).replace(/[^\d]/g, "")),
        countsFromText.beds,
      ]) ?? null;

    const baths =
      firstTruthy([
        rawBaths && Number(String(rawBaths).replace(/[^\d]/g, "")),
        countsFromText.baths,
      ]) ?? null;

    const levels = countsFromText.levels ?? null;

    return {
      ok: true,
      listing: {
        url,
        source: "Centris",
        address: "—", // UI overwrites with addressHint
        price,
        beds,
        baths,
        levels,
        area: area || null,
        condoFees: condoFees || null,
        contact: "—",
      },
    };
  } catch (e) {
    return { ok: false, error: `Centris scrape failed: ${e?.message || String(e)}` };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

/* ---------------- Unified endpoint ---------------- */

app.get("/api/listing", async (req, res) => {
  const url = String(req.query.url || "");
  const addressHint = cleanSpaces(req.query.addressHint || "");

  if (!url) return res.status(400).json({ ok: false, error: "Missing ?url=" });

  const isDuProprio = /^https:\/\/duproprio\.com\/en\//i.test(url);
  const isCentris = /^https:\/\/(www\.)?centris\.ca\/en\//i.test(url);

  if (!isDuProprio && !isCentris) {
    return res.status(400).json({
      ok: false,
      error: "URL must be a duproprio.com/en or centris.ca/en listing.",
    });
  }

  try {
    const result = isDuProprio ? await scrapeDuProprio(url) : await scrapeCentris(url);

    if (!result.ok) return res.status(502).json(result);

    // Always show your clean address label in the UI
    result.listing.address = addressHint || result.listing.address || "—";

    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
