# bravofiveniner.com

Static catalogue of BravoFiveNiner's Arma Reforger mods. Every screenshot on the site is
served from **this repository** as WebP — Bohemia's CDN is only ever touched by the sync
script, never by a visitor's browser.

## First run (fills the repo with images)

```bash
npm install          # pulls sharp for the WebP encode
npm run sync         # scrapes the Workshop, writes data/mods.json, downloads + encodes
                     # every gallery image into public/mods/<modId>/
git add -A && git commit -m "chore(sync): initial workshop pull" && git push
```

Expect the first run to take a few minutes (28 mods, up to 12 shots each). Every later run
is near-instant: an image whose source URL is already recorded in `data/mods.json` **and**
present on disk is never re-downloaded. Force a re-encode with `npm run sync:images`.

```bash
npm run sync:dry     # scrape and diff, write nothing
```

## Automation

`.github/workflows/sync-workshop.yml` runs at 08:00 UTC daily — 02:00 CST / 03:00 CDT —
and commits `data/` + `public/mods/` only when something actually changed. It can also be
triggered by hand from the Actions tab (with an optional force-image rebuild).

## Layout

| Path | What it is |
| --- | --- |
| `BravoFiveNine.dc.html` | Landing page — hero + image grid, reads `data/mods.json` |
| `Mod Page.dc.html` | Per-mod page, opened as `?id=<workshopId>` |
| `data/mods.json` | Single source of truth: mod metadata + repo-relative image paths |
| `public/mods/<id>/` | Rehosted WebP (full 1600w + `-640` card thumb) |
| `scripts/sync-workshop.mjs` | The scraper / image rehoster |

Vercel serves `public/` at the root, so `/mods/<id>/00-<hash>.webp` in `data/mods.json`
resolves directly. Those files are immutable and cached for a year; `mods.json` is revalidated hourly.
