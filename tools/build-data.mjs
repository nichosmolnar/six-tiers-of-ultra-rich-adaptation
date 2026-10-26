#!/usr/bin/env node
// Builds data/people.json from the Forbes 2026 CSV + tools/curated.json,
// and caches portraits into data/img/.
//
// Usage (from tools/): npm run data [-- --skip-images | --refresh-images]

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

// Lower bound of each tier; keep in sync with TIERS in app.js.
const TIERS = [1e7, 1e8, 1e9, 1e10, 1e11, 1e12].map((min, i) => ({ id: i + 1, min }));
const tierFor = (netWorth) => TIERS.findLast((t) => netWorth >= t.min) ?? TIERS[0];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSV_PATH = path.join(ROOT, "tools/raw/billionaire_individual_2026.csv");
const CURATED_PATH = path.join(ROOT, "tools/curated.json");
const OUT_PATH = path.join(ROOT, "data/people.json");
const IMG_DIR = path.join(ROOT, "data/img");

const args = new Set(process.argv.slice(2));
const SKIP_IMAGES = args.has("--skip-images");
const REFRESH_IMAGES = args.has("--refresh-images");

const GAPMINDER_ASSETS = "https://raw.githubusercontent.com/open-numbers/ddf--gapminder--billionaires/master/assets";
const GAPMINDER_TREE = "https://api.github.com/repos/open-numbers/ddf--gapminder--billionaires/git/trees/master?recursive=1";
const USER_AGENT = "billionaire-tiers-chart/0.1 (non-commercial data visualization)";

const slugify = (s) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&.*$/, "")
    .replace(/\bfamily\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const num = (v) => (v === "" || v == null ? null : Number(v));

async function loadForbes() {
  if (!existsSync(CSV_PATH)) {
    throw new Error(
      `Missing ${path.relative(ROOT, CSV_PATH)}. Download it with:\n` +
        "  kaggle datasets download kanchana1990/global-billionaire-wealth-to-gdp-2026 -p tools/raw --unzip",
    );
  }
  const rows = parse(await fs.readFile(CSV_PATH), { columns: true, bom: true, skip_empty_lines: true });
  return new Map(rows.map((r) => [r.forbes_uri, r]));
}

function fromForbes(entry, row) {
  const asOf = row.scrape_timestamp?.slice(0, 10) ?? null;
  const override = entry.netWorthOverride != null;
  return {
    id: entry.forbesUri,
    name: entry.name ?? row.person_name,
    netWorth: override ? entry.netWorthOverride : num(row.net_worth_usd),
    forbesNetWorth: num(row.net_worth_usd),
    rank: num(row.rank),
    category: entry.category ?? "Other",
    sourceOfWealth: row.source_of_wealth || null,
    industry: row.primary_industry || null,
    country: row.country || null,
    iso3: row.iso3 || null,
    age: num(row.age),
    gender: row.gender || null,
    selfMade: row.self_made === "True" ? true : row.self_made === "False" ? false : null,
    gdpPct: num(row.wealth_gdp_ratio_pct),
    asOf: override ? entry.asOf : asOf,
    source: override ? entry.source : "Forbes Real-Time Billionaires",
    override,
    manual: false,
    label: !!entry.label,
    wiki: entry.wiki ?? row.person_name.replace(/\s*&\s*family$/i, ""),
  };
}

function fromManual(entry) {
  for (const k of ["name", "netWorth", "asOf", "source"]) {
    if (entry[k] == null) throw new Error(`Manual entry ${JSON.stringify(entry.name)} is missing "${k}"`);
  }
  return {
    id: slugify(entry.name),
    name: entry.name,
    netWorth: entry.netWorth,
    forbesNetWorth: null,
    rank: null,
    category: entry.category ?? "Other",
    sourceOfWealth: entry.sourceOfWealth ?? null,
    industry: null,
    country: entry.country ?? null,
    iso3: null,
    age: null,
    gender: null,
    selfMade: entry.selfMade ?? null,
    gdpPct: null,
    asOf: entry.asOf,
    source: entry.source,
    override: false,
    manual: true,
    label: !!entry.label,
    wiki: entry.wiki ?? entry.name,
  };
}

// ---------- images ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOk(url, init = {}, retries = 4) {
  const res = await fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) } });
  if (res.status === 429 && retries > 0) {
    const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * (5 - retries);
    await sleep(wait);
    return fetchOk(url, init, retries - 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

async function gapminderIndex() {
  try {
    const tree = await (await fetchOk(GAPMINDER_TREE)).json();
    return new Set(
      tree.tree.filter((t) => t.path.startsWith("assets/") && t.path.endsWith(".png")).map((t) => t.path.slice(7, -4)),
    );
  } catch (err) {
    console.warn(`  Could not list Gapminder assets (${err.message}); using Wikipedia only.`);
    return new Set();
  }
}

async function wikipediaThumb(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}?redirect=true`;
  const json = await (await fetchOk(url)).json();
  if (json.type === "disambiguation" || !json.thumbnail?.source) return null;
  // Wikimedia only serves pre-rendered thumbnail widths, so use the URL as given.
  return { src: json.thumbnail.source, page: json.content_urls?.desktop?.page ?? null };
}

async function findCached(id) {
  for (const ext of ["jpg", "png", "webp"]) {
    const p = path.join(IMG_DIR, `${id}.${ext}`);
    if (existsSync(p)) return `data/img/${id}.${ext}`;
  }
  return null;
}

async function resolveImages(people, credits) {
  await fs.mkdir(IMG_DIR, { recursive: true });
  const gap = SKIP_IMAGES ? new Set() : await gapminderIndex();
  const missing = [];

  for (const p of people) {
    const cached = REFRESH_IMAGES ? null : await findCached(p.id);
    if (cached) {
      p.image = cached;
      p.imageCredit = credits[p.id] ?? null;
      continue;
    }
    if (SKIP_IMAGES) {
      p.image = null;
      continue;
    }

    const gapSlug = p.id.replace(/-\d+$/, "").replace(/-/g, "_");
    try {
      if (gap.has(gapSlug)) {
        const buf = Buffer.from(await (await fetchOk(`${GAPMINDER_ASSETS}/${gapSlug}.png`)).arrayBuffer());
        await fs.writeFile(path.join(IMG_DIR, `${p.id}.png`), buf);
        p.image = `data/img/${p.id}.png`;
        p.imageCredit = { source: "Gapminder", url: "https://github.com/open-numbers/ddf--gapminder--billionaires" };
      } else {
        const thumb = await wikipediaThumb(p.wiki);
        if (!thumb) throw new Error("no thumbnail");
        const res = await fetchOk(thumb.src);
        const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png" : "jpg";
        await fs.writeFile(path.join(IMG_DIR, `${p.id}.${ext}`), Buffer.from(await res.arrayBuffer()));
        p.image = `data/img/${p.id}.${ext}`;
        p.imageCredit = { source: "Wikipedia / Wikimedia Commons", url: thumb.page };
      }
      credits[p.id] = p.imageCredit;
      process.stdout.write(".");
    } catch (err) {
      p.image = null;
      missing.push(`${p.name} (${err.message})`);
      process.stdout.write("x");
    }
    await sleep(400);
  }
  process.stdout.write("\n");
  if (missing.length) console.warn(`  No portrait for ${missing.length}, will use initials:\n    ${missing.join("\n    ")}`);
}

// ---------- main ----------

async function main() {
  const [forbes, curated] = await Promise.all([loadForbes(), fs.readFile(CURATED_PATH, "utf8").then(JSON.parse)]);

  const people = [];
  const unmatched = [];
  for (const entry of curated.people) {
    if (entry.forbesUri) {
      const row = forbes.get(entry.forbesUri);
      if (!row) {
        unmatched.push(entry.forbesUri);
        continue;
      }
      people.push(fromForbes(entry, row));
    } else {
      people.push(fromManual(entry));
    }
  }

  const seen = new Set();
  for (const p of people) {
    if (seen.has(p.id)) throw new Error(`Duplicate id "${p.id}" in curated list`);
    seen.add(p.id);
    p.tier = tierFor(p.netWorth).id;
  }

  const creditsPath = path.join(IMG_DIR, "credits.json");
  const credits = existsSync(creditsPath) ? JSON.parse(await fs.readFile(creditsPath, "utf8")) : {};
  await resolveImages(people, credits);
  await fs.writeFile(creditsPath, JSON.stringify(credits, null, 2));

  people.sort((a, b) => b.netWorth - a.netWorth);
  for (const p of people) delete p.wiki;

  const forbesAsOf = [...forbes.values()][0]?.scrape_timestamp ?? null;
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(
    OUT_PATH,
    JSON.stringify({ generated: new Date().toISOString(), forbesAsOf, count: people.length, people }, null, 1),
  );

  const byTier = TIERS.map((t) => `T${t.id}:${people.filter((p) => p.tier === t.id).length}`).join("  ");
  console.log(`Wrote ${people.length} people to ${path.relative(ROOT, OUT_PATH)}  (${byTier})`);
  if (unmatched.length) {
    console.warn(`  ${unmatched.length} curated forbesUri not found in CSV:\n    ${unmatched.join("\n    ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
