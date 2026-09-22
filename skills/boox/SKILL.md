---
name: boox
description: >
  how to send documents to the user boox e ink tablet. Use when the user
  mentions boox, eink, e-ink tablet, USB file transfer to the tablet, or
  wants a PDF on the Boox.
---

# boox

Send files to Tommy's **ONYX Boox Go 10.3**. Prefer USB when the tablet is
plugged in. Use Google Drive when it is not.

## USB upload with gphoto2

macOS **Finder does not mount** the Boox. It uses **MTP**. Do not wait for a
volume in `/Volumes`.

Check the tablet is on USB:

```bash
ioreg -p IOUSB -l -w0 | awk -F'"' '/USB Product Name|USB Vendor Name/ {print $4}'
```

A connected Go 10.3 shows vendor **ONYX**. Product name is often
`KHAJE-IDP _SN:...`. libmtp/gphoto2 may label it `Google Inc Nexus/Pixel (MTP)`.

Upload into **Books**:

```bash
gphoto2 --folder '/store_00010001/Books' --upload-file "/path/to/file.pdf"
gphoto2 --folder '/store_00010001/Books' --list-files
```

`gphoto2` is on Homebrew (`brew install gphoto2`). Install it if missing.

### USB gotchas

- Unlock the tablet. Keep the screen on. Set USB to **File Transfer**.
- Use a **data** cable. Plug **direct into the Mac**, not a hub.
- If File Transfer is missing: Developer Options → Default USB configuration
  → File Transfer.
- `mtp-sendfile` / `mtp-connect --sendfile` fail on this device
  (`PTP Invalid Object Handle`). Always use **gphoto2**.
- `adb` only works if USB debugging is on. Do not depend on it.
- If `ioreg` has no ONYX device, USB is not enumerating. Switch cable or
  skip to Drive.

## Google Drive fallback

If USB is not connected, copy PDFs to:

`/Users/morse/Documents/googledrive/`

Drive syncs them. Example with critique:

```bash
critique --pdf /Users/morse/Documents/googledrive/changes-name.pdf
```
