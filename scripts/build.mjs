#!/usr/bin/env node
// Scans assets/wallpapers, makes WebP thumbnails and writes data/wallpapers.json
//   npm run build               thumbnails + manifest
//   npm run check               validation only (used on pull requests)
//   npm run build -- --force    regenerate every thumbnail

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = {
  srcDir: 'assets/wallpapers',
  thumbDir: 'assets/thumbs',
  metaFile: 'data/meta.json',
  outFile: 'data/wallpapers.json',
  thumbWidth: 480,
  thumbQuality: 72,
  maxFileMB: 20,
  minLongSide: 1280,
  exts: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']),
};
const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');

const abs = (...p) => path.join(ROOT, ...p);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const exists = (p) => fs.access(p).then(() => true, () => false);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

const STOP = new Set(['the', 'and', 'for', 'with', 'wall', 'wallpaper', 'wallpapers', 'image', 'img', 'idk', 'some', 'something']);

function titleFrom(base) {
  const t = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function tagsFrom(category, base) {
  const words = [...category.split(/[\s_-]+/), ...base.split(/[-_\s.]+/)]
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !STOP.has(w));
  return [...new Set(words)].slice(0, 8);
}

function orientationOf(w, h) {
  const r = w / h;
  if (r >= 2.0) return 'ultrawide';
  if (r > 1.15) return 'desktop';
  if (r >= 0.87) return 'square';
  return 'mobile';
}

function tierOf(w, h) {
  const long = Math.max(w, h);
  if (long >= 3840) return '4K';
  if (long >= 2560) return '2K';
  if (long >= 1920) return 'FHD';
  if (long >= 1280) return 'HD';
  return 'SD';
}

// Rough colour family from the dominant colour, good enough for a filter.
function colorName(hexStr) {
  const n = parseInt(hexStr.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (l < 0.12) return 'black';
  if (l > 0.92) return 'white';
  const s = d / (1 - Math.abs(2 * l - 1));
  if (s < 0.14) return 'gray';
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return l < 0.4 ? 'brown' : 'orange';
  if (h < 65) return 'yellow';
  if (h < 165) return 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

async function walk(dir, base = '') {
  const out = [];
  for (const e of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, rel)));
    else out.push(rel);
  }
  return out;
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      res[k] = await fn(items[k]);
    }
  }));
  return res;
}

// Date each file was first committed (oldest commit wins). Needs full git history.
function gitAddDates() {
  const map = new Map();
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.quotepath=false', 'log', '--diff-filter=A', '--name-only', '--format=@@%aI', '--', CFG.srcDir],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let date = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('@@')) date = line.slice(2, 12);
      else if (line.trim()) map.set(line.trim(), date);
    }
  } catch { /* not a git repo, fall back to today */ }
  return map;
}

async function main() {
  const srcAbs = abs(CFG.srcDir);
  if (!(await exists(srcAbs))) {
    console.error(`Missing folder: ${CFG.srcDir}`);
    process.exit(1);
  }

  let meta = {};
  try { meta = JSON.parse(await fs.readFile(abs(CFG.metaFile), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') { console.error(`${CFG.metaFile} is not valid JSON: ${e.message}`); process.exit(1); }
  }

  let prev = null, prevText = null;
  try { prevText = await fs.readFile(abs(CFG.outFile), 'utf8'); prev = JSON.parse(prevText); } catch { /* first run */ }
  const prevByPath = new Map((prev?.items ?? []).map((i) => [i.path, i]));
  const hasPrev = prev !== null;

  const errors = [], warnings = [];
  const err = (f, m) => errors.push(`${f}: ${m}`);
  const warn = (f, m) => warnings.push(`${f}: ${m}`);
  const addDates = gitAddDates();
  const today = new Date().toISOString().slice(0, 10);
  const files = (await walk(srcAbs)).sort(cmp);
  let made = 0, reused = 0;

  const records = (await pool(files, 4, async (rel) => {
    const ext = path.extname(rel).toLowerCase();
    if (!CFG.exts.has(ext)) { warn(rel, 'not a supported image, skipped'); return null; }
    const [category, ...rest] = rel.split('/');
    if (rest.length === 0) { err(rel, 'put the file inside a category folder, e.g. Nord/'); return null; }

    const m = { ...(meta[`${category}/`] ?? {}), ...(meta[rel] ?? {}) };
    if (m.hidden) return null;

    const isNew = hasPrev && !prevByPath.has(rel);
    const buf = await fs.readFile(abs(CFG.srcDir, rel));
    if (buf.length > CFG.maxFileMB * 1024 * 1024) {
      err(rel, `${(buf.length / 1048576).toFixed(1)} MB is over the ${CFG.maxFileMB} MB limit (jsDelivr serves files up to 20 MB)`);
      return null;
    }
    if (isNew && !/^[a-z0-9][a-z0-9._-]*$/.test(path.basename(rel))) {
      err(rel, 'new files must be lowercase kebab-case: letters, numbers, - _ . only, no spaces');
    }

    const hash = createHash('sha1').update(buf).digest('hex');
    const prevItem = prevByPath.get(rel);
    const thumbRel = `${category}/${rest.join('/')}.webp`;
    const thumbAbs = abs(CFG.thumbDir, thumbRel);

    let info;
    if (prevItem && prevItem.hash === hash.slice(0, 16) && !FORCE && (CHECK || (await exists(thumbAbs)))) {
      info = { width: prevItem.width, height: prevItem.height, color: prevItem.color };
      reused++;
    } else {
      try {
        const md = await sharp(buf, { animated: false, failOn: 'error' }).metadata();
        let w = md.width, h = md.height;
        if (md.orientation >= 5) [w, h] = [h, w];
        info = { width: w, height: h };
        if (!CHECK) {
          const thumbBuf = await sharp(buf, { animated: false, failOn: 'error' })
            .rotate()
            .resize({ width: CFG.thumbWidth, withoutEnlargement: true })
            .webp({ quality: CFG.thumbQuality })
            .toBuffer();
          await fs.mkdir(path.dirname(thumbAbs), { recursive: true });
          await fs.writeFile(thumbAbs, thumbBuf);
          const { channels } = await sharp(thumbBuf).stats();
          info.color = hex({ r: Math.round(channels[0].mean), g: Math.round(channels[1].mean), b: Math.round(channels[2].mean) });
          made++;
        }
      } catch (e) {
        err(rel, `cannot read image (${e.message})`);
        return null;
      }
    }

    if (Math.max(info.width, info.height) < CFG.minLongSide) {
      warn(rel, `only ${info.width}x${info.height}, wallpapers should be at least ${CFG.minLongSide}px on the long side`);
    }
    if (isNew && !m.author && !m.source) warn(rel, `no author/source in ${CFG.metaFile}`);

    return { rel, ext, category, rest, m, isNew, fullHash: hash, hash: hash.slice(0, 16), thumbRel, prevItem, ...info };
  })).filter(Boolean);

  // Duplicates: the oldest existing file is the canonical one, the rest point to it.
  const canonical = new Map();
  for (const r of records) {
    const cur = canonical.get(r.fullHash);
    if (!cur || (cur.isNew && !r.isNew)) canonical.set(r.fullHash, r);
  }

  const usedIds = new Set();
  const dupes = [];
  const items = records.map((r) => {
    const stemPath = r.rest.join('/').replace(/\.[^.]+$/, '');
    const base = path.basename(stemPath);
    let id = slug(`${r.category}/${stemPath}`);
    if (usedIds.has(id)) id += `-${r.ext.slice(1)}`;
    while (usedIds.has(id)) id += '-x';
    usedIds.add(id);
    r.id = id;

    const first = canonical.get(r.fullHash);
    if (first !== r) {
      dupes.push([r.rel, first.rel]);
      if (r.isNew) err(r.rel, `identical to existing file ${first.rel}`);
    }

    return {
      id,
      path: r.rel,
      thumb: r.thumbRel,
      title: r.m.title ?? titleFrom(base),
      category: r.category,
      tags: r.m.tags ?? tagsFrom(r.category, base),
      width: r.width,
      height: r.height,
      orientation: orientationOf(r.width, r.height),
      tier: tierOf(r.width, r.height),
      size: r.size ?? undefined,
      color: r.color,
      colorName: r.color ? colorName(r.color) : undefined,
      animated: r.ext === '.gif' || undefined,
      author: r.m.author ?? null,
      source: r.m.source ?? null,
      license: r.m.license ?? null,
      added: r.prevItem?.added ?? addDates.get(`${CFG.srcDir}/${r.rel}`) ?? today,
      hash: r.hash,
      _first: first,
      _r: r,
    };
  });

  // fill in dupOf + size after ids exist
  const byRecord = new Map(items.map((i) => [i._r, i]));
  const sizes = await pool(records, 8, async (r) => (await fs.stat(abs(CFG.srcDir, r.rel))).size);
  items.forEach((it, i) => {
    it.size = sizes[i];
    if (it._first !== it._r) it.dupOf = byRecord.get(it._first).id;
    delete it._first;
    delete it._r;
  });

  for (const key of Object.keys(meta)) {
    if (key.startsWith('_')) continue;
    const ok = key.endsWith('/')
      ? files.some((f) => f.startsWith(key))
      : files.includes(key);
    if (!ok) warn(`${CFG.metaFile}`, `"${key}" does not match any file`);
  }

  const visible = items.filter((i) => !i.dupOf);
  const counts = new Map();
  for (const i of visible) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
  const categories = [...counts].sort((a, b) => cmp(a[0], b[0])).map(([name, count]) => ({ name, count }));

  const render = (gen) =>
    `{\n  "schema": 1,\n  "generated": "${gen}",\n  "count": ${visible.length},\n  "categories": ${JSON.stringify(categories)},\n  "items": [\n` +
    items.map((i) => '    ' + JSON.stringify(i)).join(',\n') +
    '\n  ]\n}\n';
  const normalize = (t) => t.replace(/"generated": ".*?"/, '"generated": ""');

  let manifestChanged = false;
  if (!CHECK && errors.length === 0) {
    if (!prevText || normalize(prevText) !== normalize(render(''))) {
      await fs.mkdir(path.dirname(abs(CFG.outFile)), { recursive: true });
      await fs.writeFile(abs(CFG.outFile), render(new Date().toISOString()));
      manifestChanged = true;
    }
    // remove thumbnails whose source is gone or hidden
    const keep = new Set(records.map((r) => r.thumbRel));
    let removed = 0;
    if (await exists(abs(CFG.thumbDir))) {
      for (const t of await walk(abs(CFG.thumbDir))) {
        if (!keep.has(t)) { await fs.unlink(abs(CFG.thumbDir, t)); removed++; }
      }
    }
    if (removed) console.log(`Removed ${removed} orphan thumbnail(s)`);
  }

  console.log(`${files.length} files, ${visible.length} unique wallpapers in ${categories.length} categories`);
  if (!CHECK) console.log(`Thumbnails: ${made} created, ${reused} reused. Manifest ${manifestChanged ? 'updated' : 'unchanged'}.`);
  if (dupes.length) {
    console.log(`\nDuplicates (${dupes.length}), flagged with "dupOf", files are not deleted:`);
    dupes.forEach(([a, b]) => console.log(`  ${a}  ==  ${b}`));
  }
  if (warnings.length) { console.log(`\nWarnings (${warnings.length}):`); warnings.forEach((w) => console.log('  - ' + w)); }
  if (errors.length) {
    console.error(`\nErrors (${errors.length}):`);
    errors.forEach((e) => console.error('  x ' + e));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
