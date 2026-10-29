# Contributing wallpapers

Thanks for adding to the collection. You only need to add the image, everything else is automatic.

## Quick start

1. Fork this repo.
2. Put your image in `assets/wallpapers/<Category>/`.
   Use an existing category (`Nord`, `Gruv`, `Flowers`, ...) or create a new folder.
3. Open a pull request. A check runs on your PR and tells you if something needs fixing.

When the PR is merged, a GitHub Action creates the thumbnail and updates `data/wallpapers.json`.
**Do not edit `data/wallpapers.json` or anything in `assets/thumbs/`.**

## Rules

| Rule | Why |
|------|-----|
| File name: lowercase, `a-z 0-9 - _ .` only, no spaces (`misty-forest.jpg`) | Clean URLs |
| Formats: jpg, png, webp, gif, avif | Works everywhere |
| Max 20 MB per file | jsDelivr's per-file limit |
| At least 1280 px on the long side | Smaller images look bad as wallpapers |
| No watermarks, screenshots of other sites, or NSFW | Quality and safety |
| No duplicates | The check compares file contents, not names |
| You made it, or you have the right to share it | See [NOTICE.md](NOTICE.md) |

## Adding credit and details (recommended)

Add an entry to `data/meta.json`:

```json
{
  "Nord/misty-forest.jpg": {
    "title": "Misty Forest",
    "tags": ["nord", "forest", "fog"],
    "author": "Your Name",
    "source": "https://example.com/original-post",
    "license": "CC BY 4.0"
  },
  "Flowers/": { "author": "Some Photographer", "license": "Unsplash License" }
}
```

- A key that ends with `/` is a default for every file in that folder.
- Anything you skip is filled in automatically (title and tags come from the file name).
- Set `"hidden": true` on a file to remove it from the site without deleting it.

## Run the check locally (optional)

Needs Node 18.17 or newer.

```bash
npm install
npm run check    # validate only
npm run build    # also creates thumbnails and the manifest
```

## Orientation and resolution labels

Detected automatically from the image size:
`mobile` (portrait), `desktop`, `ultrawide` (2:1 or wider), `square`, and `HD / FHD / 2K / 4K`.

## Removal and credit requests

See [NOTICE.md](NOTICE.md).
