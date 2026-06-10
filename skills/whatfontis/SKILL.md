---
name: whatfontis
description: >
  Identify fonts from images using the WhatFontIs API (990K+ font catalog).
  Use when the user wants to identify a font from a screenshot, image file,
  or image URL. Covers base64 upload and URL-based requests via curl.
---

# WhatFontIs API

Identify fonts from images using the WhatFontIs.com REST API. Searches a catalog of 990K+ fonts (commercial and free). Returns up to 20 ranked matches with font name, type (free/commercial), and source.

API docs: https://ggp.whatfontis.com/API-identify-fonts-from-image.html

## Auth

`WHATFONTISKEY` is already set in the environment. Just use `$WHATFONTISKEY` in curl commands. Free tier: 200 requests/day.

## Identify font from a local image file

Encode the image as base64 and send it with `IMAGEBASE64=1`:

```bash
IMG_B64=$(base64 -i /path/to/image.png)

curl -s -X POST "https://www.whatfontis.com/api2/" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "API_KEY=$WHATFONTISKEY" \
  --data-urlencode "IMAGEBASE64=1" \
  --data-urlencode "urlimagebase64=$IMG_B64" \
  --data-urlencode "limit=10" | python3 -m json.tool
```

## Identify font from an image URL

Pass the URL directly with `IMAGEBASE64=0`:

```bash
curl -s -X POST "https://www.whatfontis.com/api2/" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "API_KEY=$WHATFONTISKEY" \
  --data-urlencode "IMAGEBASE64=0" \
  --data-urlencode "urlimage=https://example.com/screenshot.png" \
  --data-urlencode "limit=10" | python3 -m json.tool
```

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `API_KEY` (required) | str | Your API key from env var `WHATFONTISKEY` |
| `IMAGEBASE64` | int | `0` = use `urlimage`, `1` = use `urlimagebase64` |
| `urlimage` | str | Public URL to an image (when `IMAGEBASE64=0`) |
| `urlimagebase64` | str | Base64-encoded image data (when `IMAGEBASE64=1`) |
| `NOTTEXTBOXSDETECTION` | int | `0` = auto-detect text box, `1` = search whole image |
| `FREEFONTS` | int | `0` = all fonts, `1` = only free fonts |
| `limit` | int | Number of results, 1-20 (default: 2) |

## Response shape

```json
[
  {
    "title": "Red Rock Regular",
    "url": "https://www.whatfontis.com/NMY_Red-Rock-Regular.font",
    "image": "https://d1ly52g9wjvbd2.cloudfront.net/img16/...",
    "type": "Commercial",
    "site": "Myfonts.com"
  }
]
```

- **title**: font name
- **url**: font page on WhatFontIs (shareable link)
- **type**: `Commercial` or `Free`
- **site**: where the font is available

## Tips

- For images with small or overlapping text, try `NOTTEXTBOXSDETECTION=1` to scan the whole image.
- Use `FREEFONTS=1` to filter results to only free fonts.
- Discord CDN URLs expire after ~24h. For Discord images, download the file first and use base64 upload.
- Present results as a table with font name, type, and source for easy scanning.
