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

function renderImageToPdfCanvas(image, maxDimension) {
  const limit = normalizeMaxImageDimension(maxDimension);
  const maxSide = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = limit > 0 && maxSide > limit ? limit / maxSide : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d context unavailable');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, width, height);
  return { canvas, width, height };
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
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

function normalizeMaxRetries(inputValue) {
  const parsed = Number.parseInt(String(inputValue), 10);
  if (!Number.isInteger(parsed)) {
    return 2;
  }
  return Math.max(0, Math.min(parsed, 5));
}

function normalizeMaxImageDimension(inputValue) {
  const parsed = Number.parseInt(String(inputValue), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(512, Math.min(parsed, 10000));
}

function normalizeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || 'unknown');
}

function getErrorStageLabel(stage) {
  switch (String(stage || '').trim()) {
    case 'pid':
      return 'PID获取';
    case 'image':
      return '拉图片';
    case 'pdf':
      return '生成PDF';
    default:
      return '未知阶段';
  }
}

function clearRowError(row) {
  row.lastErrorStage = '';
  row.lastErrorMessage = '';
  return row;
}

function setRowError(row, stage, error) {
  const message = normalizeErrorMessage(error);
  row.lastErrorStage = String(stage || '');
  row.lastErrorMessage = message;
  row.status = `${getErrorStageLabel(stage)}失败: ${message}`;
  return row;
}

function buildFailureRecord(row, stage, error) {
  return {
    row,
    stage,
    stageLabel: getErrorStageLabel(stage),
    message: normalizeErrorMessage(error),
  };
}

function formatFailureRecord(record) {
  return `第 ${record.row.totalPage} 页 [${record.stageLabel}] ${record.message}`;
}

function summariseFailuresByStage(failedRows) {
  const counts = new Map();
  failedRows.forEach((item) => {
    const key = String(item && item.stage ? item.stage : 'unknown');
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts.entries()).map(([stage, count]) => ({
    stage,
    stageLabel: getErrorStageLabel(stage),
    count,
  }));
}

function formatFailureStageSummary(failedRows) {
  const parts = summariseFailuresByStage(failedRows)
    .map((item) => `${item.stageLabel} ${item.count} 页`);
  return parts.join('，');
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
