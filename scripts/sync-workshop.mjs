#!/usr/bin/env node
/**
 * bravofiveniner.com — Workshop sync
 *
 * 1. Pages the public Arma Reforger Workshop search for "BravoFiveNine".
 * 2. Keeps ONLY items whose author is exactly BravoFiveNine (the search also
 *    returns other people's mods that merely credit or depend on B59).
 * 3. Fetches each mod page and pulls version / rating / downloads / dates /
 *    tags / dependencies / gallery images out of Next.js's embedded JSON,
 *    with an HTML-regex fallback if Bohemia changes the page shape.
 * 4. Rehosts gallery images into public/mods/<id>/ as WebP.
 *    Images are content-addressed: a source URL that is already recorded in
 *    data/mods.json AND present on disk is NEVER re-downloaded.
 * 5. Writes data/mods.json (the single source of truth for the site) and
 *    appends any real changes to data/updates.json.
 *
 * Usage:  node scripts/sync-workshop.mjs [--dry] [--force-images]
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data', 'mods.json');
const UPDATES = path.join(ROOT, 'data', 'updates.json');
const IMG_ROOT = path.join(ROOT, 'public', 'mods');

const AUTHOR = 'BravoFiveNine';
const BASE = 'https://reforger.armaplatform.com';
const SEARCH = `${BASE}/workshop?search=${encodeURIComponent(AUTHOR)}`;
const CDN_IMAGE_RE = /https:\/\/ar-gcp-cdn\.bistudio\.com\/image\/[A-Za-z0-9/_-]+\.(?:jpg|jpeg|png|webp)/g;

const UA = 'bravofiveniner.com sync/1.0 (+https://bravofiveniner.com; contact via site)';
const THROTTLE_MS = 500;
const MAX_PAGES = 12;

const DRY = process.argv.includes('--dry');
const FORCE_IMAGES = process.argv.includes('--force-images');

/* ---------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[sync]', ...a);
const warn = (...a) => console.warn('[sync] !', ...a);

async function getText(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(1500 * attempt);
    return getText(url, attempt + 1);
  }
}

/** Next.js pages-router embeds all page props here. */
function nextData(html) {
  const m = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Depth-first walk of any JSON value. */
function* walk(node) {
  if (node && typeof node === 'object') {
    yield node;
    for (const v of Object.values(node)) yield* walk(v);
  }
}

/** First object in the tree that looks like a workshop asset record. */
function findAsset(tree, id) {
  if (!tree) return null;
  for (const node of walk(tree)) {
    if (Array.isArray(node)) continue;
    const nodeId = node.id ?? node.assetId ?? node.uuid;
    if (typeof nodeId === 'string' && nodeId.toUpperCase() === id.toUpperCase() && (node.name || node.summary)) {
      return node;
    }
  }
  return null;
}

const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

/** "100.11 MB" -> bytes */
function sizeToBytes(label) {
  if (typeof label === 'number') return label;
  const m = /([\d.]+)\s*(B|KB|MB|GB)/i.exec(String(label ?? ''));
  if (!m) return null;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

function bytesToLabel(bytes) {
  if (!bytes) return null;
  const units = [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]];
  for (const [u, m] of units) if (bytes >= m) return `${(bytes / m).toFixed(2)} ${u}`;
  return `${bytes} B`;
}

/** Workshop prints dates as DD.MM.YYYY; ISO also passes through. */
function toIsoDate(value) {
  if (!value) return null;
  const s = String(value);
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const d = new Date(s);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString().slice(0, 10);
}

/** Label -> value scrape from the rendered detail page, as a fallback. */
function scrapeLabel(html, label) {
  const re = new RegExp(`>${label}<\\/[^>]+>\\s*<[^>]*>([^<]{1,64})<`, 'i');
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

/* ------------------------------------------------------------ discovery */

/** Returns [{id, name, slug, author}] for every BravoFiveNine-authored mod. */
async function discover() {
  const found = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await getText(`${SEARCH}&page=${page}`);
    const tree = nextData(html);
    let items = [];

    if (tree) {
      for (const node of walk(tree)) {
        if (!Array.isArray(node)) continue;
        const looksLikeList = node.length && node.every(
          (x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id.length >= 16,
        );
        if (looksLikeList && node.length > items.length) items = node;
      }
    }

    if (items.length) {
      for (const it of items) {
        const author = String(
          pick(it, 'author', 'authorName', 'author.name', 'owner', 'owner.name') ?? '',
        ).trim();
        if (author.toLowerCase() !== AUTHOR.toLowerCase()) continue;
        found.set(it.id, {
          id: it.id,
          name: String(pick(it, 'name', 'title') ?? '').trim(),
          slug: null,
          author,
        });
      }
    } else {
      // Fallback: anchors carry "<title>by <author>" in their accessible text.
      const anchor = /href="\/workshop\/([0-9A-F]{16})([^"]*)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
      let m;
      while ((m = anchor.exec(html))) {
        const [, id, suffix, inner] = m;
        const byMatch = /by\s+([^<]{1,48})$/i.exec(inner.replace(/<[^>]+>/g, '').trim());
        const author = byMatch ? byMatch[1].trim() : '';
        if (author.toLowerCase() !== AUTHOR.toLowerCase()) continue;
        found.set(id, { id, name: '', slug: id + suffix, author });
      }
      if (!/href="\/workshop\/[0-9A-F]{16}/i.test(html)) break;
    }

    if (/Showing\s+\d+\s+to\s+(\d+)\s+of\s+(\d+)/i.test(html)) {
      const [, to, total] = /Showing\s+\d+\s+to\s+(\d+)\s+of\s+(\d+)/i.exec(html);
      if (Number(to) >= Number(total)) break;
    }
    await sleep(THROTTLE_MS);
  }
  return [...found.values()];
}

/* --------------------------------------------------------------- detail */

async function fetchDetail(id, slug) {
  const url = `${BASE}/workshop/${slug || id}`;
  const html = await getText(url);
  const tree = nextData(html);
  const a = findAsset(tree, id) ?? {};

  const images = [];
  const seen = new Set();
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); images.push(u); } };
  // Prefer structured gallery order, then sweep the raw HTML for anything missed.
  for (const key of ['previewImages', 'gallery', 'screenshots', 'images', 'media']) {
    const v = a[key];
    if (Array.isArray(v)) for (const item of v) push(typeof item === 'string' ? item : pick(item, 'url', 'src', 'link'));
  }
  push(pick(a, 'thumbnailUrl', 'previewUrl', 'imageUrl'));
  for (const u of html.match(CDN_IMAGE_RE) ?? []) push(u);

  const sizeLabel = pick(a, 'sizeLabel') ?? scrapeLabel(html, 'Version size');
  const sizeBytes = sizeToBytes(pick(a, 'sizeBytes', 'size', 'versionSize') ?? sizeLabel);

  const ratingRaw = pick(a, 'rating', 'averageRating', 'ratingPercentage') ?? scrapeLabel(html, 'Rating');
  const rating = ratingRaw == null ? null : Math.round(parseFloat(String(ratingRaw).replace('%', '')));

  const dl = pick(a, 'downloads', 'downloadCount', 'subscriberCount') ?? scrapeLabel(html, 'Downloads');
  const licenseName = pick(a, 'license.name', 'licenseName', 'license');

  return {
    name: String(pick(a, 'name', 'title') ?? '').trim() || null,
    workshopUrl: url,
    version: pick(a, 'revision.version', 'version', 'currentVersion') ?? scrapeLabel(html, 'Version'),
    gameVersion: pick(a, 'gameVersion', 'requiredGameVersion') ?? scrapeLabel(html, 'Game Version'),
    rating: Number.isFinite(rating) ? rating : null,
    downloads: dl == null ? null : Number(String(dl).replace(/[^\d]/g, '')) || null,
    sizeBytes,
    sizeLabel: bytesToLabel(sizeBytes) ?? sizeLabel ?? null,
    created: toIsoDate(pick(a, 'createdAt', 'created', 'firstPublishedAt')) ?? toIsoDate(scrapeLabel(html, 'Created')),
    updated: toIsoDate(pick(a, 'updatedAt', 'lastModified', 'modifiedAt')) ?? toIsoDate(scrapeLabel(html, 'Last Modified')),
    summary: (pick(a, 'summary', 'shortDescription') ?? '').toString().trim() || null,
    description: (pick(a, 'description', 'longDescription') ?? '').toString().trim() || null,
    license: licenseName ? { name: String(licenseName), short: /\(([^)]+)\)/.exec(String(licenseName))?.[1] ?? null } : null,
    tags: (Array.isArray(a.tags) ? a.tags : []).map((t) => String(t.name ?? t)).filter(Boolean),
    dependencies: (Array.isArray(a.dependencies) ? a.dependencies : [])
      .map((d) => String(pick(d, 'name', 'title') ?? d)).filter(Boolean),
    imageSources: images.slice(0, 12),
  };
}

/* --------------------------------------------------------------- images */

const hashOf = (url) => createHash('sha1').update(url).digest('hex').slice(0, 12);

/**
 * Rehosts one source image as two WebPs (full + 640w card thumb).
 * Returns the manifest entry. Never re-downloads when both files exist and the
 * recorded hash still matches the source URL.
 */
async function rehostImage(modId, index, sourceUrl, previous) {
  const hash = hashOf(sourceUrl);
  const stem = `${String(index).padStart(2, '0')}-${hash}`;
  const dir = path.join(IMG_ROOT, modId);
  const fullFs = path.join(dir, `${stem}.webp`);
  const thumbFs = path.join(dir, `${stem}-640.webp`);
  const entry = {
    source: sourceUrl,
    hash,
    local: `/mods/${modId}/${stem}.webp`,
    thumb: `/mods/${modId}/${stem}-640.webp`,
    width: previous?.width ?? null,
    height: previous?.height ?? null,
  };

  const cached = previous?.hash === hash && existsSync(fullFs) && existsSync(thumbFs);
  if (cached && !FORCE_IMAGES) return { entry, downloaded: false };
  if (DRY) return { entry, downloaded: false };

  const res = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
  if (!res.ok) {
    warn(`image ${sourceUrl} -> HTTP ${res.status}`);
    return { entry: previous ?? entry, downloaded: false };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(dir, { recursive: true });

  const full = sharp(buf).rotate().resize({ width: 1600, withoutEnlargement: true });
  const meta = await full.clone().webp({ quality: 78, effort: 5 }).toFile(fullFs);
  await sharp(buf).rotate().resize({ width: 640, withoutEnlargement: true })
    .webp({ quality: 72, effort: 5 }).toFile(thumbFs);

  entry.width = meta.width;
  entry.height = meta.height;
  return { entry, downloaded: true };
}

/* ----------------------------------------------------------------- main */

async function main() {
  const prevDoc = JSON.parse(await fs.readFile(DATA, 'utf8'));
  const prevById = new Map(prevDoc.mods.map((m) => [m.id, m]));

  log(`discovering mods by ${AUTHOR}…`);
  const discovered = await discover();
  if (discovered.length === 0) {
    warn('discovery returned nothing — refusing to overwrite data/mods.json');
    process.exitCode = 1;
    return;
  }
  log(`found ${discovered.length} authored mods`);

  const events = [];
  const mods = [];
  let downloads = 0;

  for (const found of discovered) {
    const prev = prevById.get(found.id);
    const slug = found.slug ?? prev?.slug ?? found.id;
    let d;
    try {
      d = await fetchDetail(found.id, slug);
    } catch (err) {
      warn(`detail ${found.id} failed (${err.message}) — keeping previous record`);
      if (prev) mods.push(prev);
      continue;
    }

    const images = [];
    for (let i = 0; i < d.imageSources.length; i++) {
      const src = d.imageSources[i];
      const prevEntry = prev?.images?.find((im) => im.source === src) ?? prev?.images?.[i];
      const { entry, downloaded } = await rehostImage(found.id, i, src, prevEntry);
      images.push(entry);
      if (downloaded) downloads++;
    }

    const mod = {
      id: found.id,
      name: d.name || found.name || prev?.name || found.id,
      slug,
      workshopUrl: d.workshopUrl,
      author: AUTHOR,
      // Hand-curated in data/mods.json — never overwritten by a sync.
      category: prev?.category ?? 'rifles',
      categoryLabel: prev?.categoryLabel ?? null,
      featured: prev?.featured ?? null,
      rating: d.rating ?? prev?.rating ?? null,
      version: d.version ?? prev?.version ?? null,
      gameVersion: d.gameVersion ?? prev?.gameVersion ?? null,
      sizeLabel: d.sizeLabel ?? prev?.sizeLabel ?? null,
      sizeBytes: d.sizeBytes ?? prev?.sizeBytes ?? null,
      downloads: d.downloads ?? prev?.downloads ?? null,
      created: d.created ?? prev?.created ?? null,
      updated: d.updated ?? prev?.updated ?? null,
      license: d.license ?? prev?.license ?? null,
      summary: d.summary ?? prev?.summary ?? null,
      description: d.description ?? prev?.description ?? null,
      tags: d.tags.length ? d.tags : prev?.tags ?? [],
      dependencies: d.dependencies.length ? d.dependencies : prev?.dependencies ?? [],
      images: images.length ? images : prev?.images ?? [],
      detailSynced: true,
    };
    mods.push(mod);

    if (!prev) events.push({ at: new Date().toISOString(), type: 'added', id: mod.id, name: mod.name });
    else if (prev.version && mod.version && prev.version !== mod.version) {
      events.push({ at: new Date().toISOString(), type: 'version', id: mod.id, name: mod.name, from: prev.version, to: mod.version });
    } else if (prev.updated !== mod.updated && mod.updated) {
      events.push({ at: new Date().toISOString(), type: 'updated', id: mod.id, name: mod.name, to: mod.updated });
    }

    await sleep(THROTTLE_MS);
  }

  for (const prev of prevDoc.mods) {
    if (!mods.some((m) => m.id === prev.id)) {
      events.push({ at: new Date().toISOString(), type: 'removed', id: prev.id, name: prev.name });
    }
  }

  const cats = prevDoc.categories ?? [];
  const doc = {
    ...prevDoc,
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/sync-workshop.mjs',
    imagesRehosted: mods.some((m) => m.images.some((i) => existsSync(path.join(ROOT, 'public', i.local.slice(1))))),
    categories: cats,
    counts: {
      total: mods.length,
      withDetail: mods.filter((m) => m.detailSynced).length,
      byCategory: Object.fromEntries(cats.map((c) => [c.id, mods.filter((m) => m.category === c.id).length])),
      totalDownloads: mods.reduce((n, m) => n + (m.downloads ?? 0), 0),
    },
    mods: mods.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0) || a.name.localeCompare(b.name)),
  };

  const next = JSON.stringify(doc, null, 2);
  const prevComparable = JSON.stringify({ ...prevDoc, generatedAt: null, generatedBy: null }, null, 2);
  const nextComparable = JSON.stringify({ ...doc, generatedAt: null, generatedBy: null }, null, 2);

  if (prevComparable === nextComparable) {
    log('no changes — leaving files untouched');
    return;
  }

  if (DRY) {
    log(`DRY RUN: would write ${mods.length} mods, ${events.length} events, ${downloads} new images`);
    return;
  }

  await fs.writeFile(DATA, next + '\n');
  const history = existsSync(UPDATES) ? JSON.parse(await fs.readFile(UPDATES, 'utf8')) : { events: [] };
  history.events = [...events, ...history.events].slice(0, 100);
  await fs.writeFile(UPDATES, JSON.stringify(history, null, 2) + '\n');

  log(`wrote ${mods.length} mods · ${downloads} new image(s) rehosted · ${events.length} change event(s)`);
  for (const e of events) log(' ·', e.type, e.name, e.from ? `${e.from} → ${e.to}` : e.to ?? '');
}

main().catch((err) => { console.error(err); process.exit(1); });
