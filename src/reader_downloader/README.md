# ReaderDownloader Split Source

This directory stores the maintainable source parts for the userscript.

## Layout

- `parts/00_userscript_header.js`: Tampermonkey metadata block
- `parts/01_bootstrap_start.js`: IIFE start
- `parts/02_constants.js`: shared config/constants
- `parts/03_utils.js`: utility helpers
- `parts/04_network.js`: request and blob helpers
- `parts/05_bookmarks.js`: PDF bookmark extraction/build logic
- `parts/06_pdf_download.js`: PDF download pipeline
- `parts/07_reader_mapping.js`: page map + PID resolve logic
- `parts/08_panel.js`: panel rendering/UI helpers
- `parts/09_main_and_bootstrap_end.js`: app entry + IIFE end

## Build

From repo root:

```bash
node scripts/build-reader-downloader.js
```

Outputs:

- `ReaderDownloader.js`
- `dist/ReaderDownloader.user.js`
