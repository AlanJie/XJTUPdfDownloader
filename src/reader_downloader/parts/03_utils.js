function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function padPageStr(pageNum, prefix) {
  let pad = '';
  for (let i = prefix.length + String(pageNum).length; i < 6; i += 1) {
    pad += '0';
  }
  return prefix + pad + pageNum;
}

function imageToJpegDataUrl(image, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d context unavailable');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  return canvas.toDataURL('image/jpeg', quality);
}

function sanitizeFileName(name) {
  const base = String(name || 'reader').trim() || 'reader';
  return base.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
}

function normalizeRequestDelayMs(inputValue) {
  const parsed = Number.parseInt(String(inputValue), 10);
  if (!Number.isInteger(parsed)) {
    return CONFIG.requestDelayMs;
  }
  return Math.max(0, Math.min(parsed, 60000));
}

function normalizeChapterTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim();
}

function isLikelyChapterTitle(title) {
  const normalized = normalizeChapterTitle(title);
  if (!normalized) return false;
  return /第\s*[一二三四五六七八九十百千0-9]+\s*章/i.test(normalized)
    || /\bchapter\b/i.test(normalized);
}

function getPublicationPageNumber(row) {
  const pageInType = Number.parseInt(String(row && row.pageInType), 10);
  if (Number.isInteger(pageInType) && pageInType > 0) return pageInType;
  const totalPage = Number.parseInt(String(row && row.totalPage), 10);
  return Number.isInteger(totalPage) && totalPage > 0 ? totalPage : 1;
}
