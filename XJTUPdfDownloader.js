// ==UserScript==
// @name         XJTUPdfDownloader
// @namespace    xjtu-pdf-downloader
// @version      0.6.0
// @description  在阅读器页面显示页码、文件名与 png.dll?pid 的对应关系，并支持导出 PDF
// @match        http://jiaocai1.lib.xjtu.edu.cn:9088/jpath/reader/reader.shtml*
// @require      https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
// @connect      jiaocai1.lib.xjtu.edu.cn
// @connect      202.117.24.155
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

const CONFIG = {
  requestDelayMs: 200,
  requestTimeoutMs: 12000,
  maxRowsRendered: 400,
  pdfRequestRetryModes: ['arraybuffer', 'blob', 'binary-text'],
};

const PAGE_TYPE_INFO = [
  { key: 'cov', name: '封面' },
  { key: 'bok', name: '书名' },
  { key: 'leg', name: '版权' },
  { key: 'fow', name: '前言' },
  { key: '!', name: '目录' },
  { key: '', name: '正文' },
  { key: 'att', name: '附录' },
  { key: 'cov', name: '封底' },
];

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

function buildReaderRequestHeaders(extraHeaders) {
  return {
    // png.dll 在缺少 Referer 时常返回 200 + 空包，这里显式带上来源页。
    Referer: location.href,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    ...(extraHeaders || {}),
  };
}

function buildRequestOptions(url, timeoutMs, options) {
  const nextOptions = options || {};
  const requestOptions = {
    method: 'GET',
    url,
    timeout: timeoutMs,
    anonymous: false,
    withCredentials: true,
    redirect: 'follow',
  };

  if (nextOptions.headers && Object.keys(nextOptions.headers).length > 0) {
    requestOptions.headers = nextOptions.headers;
  }

  if (nextOptions.mode === 'arraybuffer') {
    requestOptions.responseType = 'arraybuffer';
  } else if (nextOptions.mode === 'blob') {
    requestOptions.responseType = 'blob';
  } else if (nextOptions.mode === 'binary-text') {
    requestOptions.overrideMimeType = 'text/plain; charset=x-user-defined';
  }

  return requestOptions;
}

function requestGet(url, timeoutMs, options) {
  const requestOptions = buildRequestOptions(url, timeoutMs, options);
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      ...requestOptions,
      onload(response) {
        resolve(response);
      },
      ontimeout() {
        reject(new Error(`timeout after ${timeoutMs}ms`));
      },
      onerror(error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    });
  });
}

function requestReaderResource(url, timeoutMs, options) {
  const nextOptions = options || {};
  return requestGet(url, timeoutMs, {
    ...nextOptions,
    headers: buildReaderRequestHeaders(nextOptions.headers),
  });
}

function parseHeaderValue(headersText, headerName) {
  const text = String(headersText || '');
  const match = text.match(new RegExp(`^${headerName}:\\s*([^\\r\\n;]+)`, 'im'));
  return match ? match[1].trim() : '';
}

function binaryTextToBlob(binaryText, contentType) {
  const text = String(binaryText || '');
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return new Blob([bytes], { type: contentType || 'application/octet-stream' });
}

function responseToBlob(response, mode) {
  const contentType = parseHeaderValue(response.responseHeaders, 'content-type').toLowerCase();
  if (mode === 'arraybuffer') {
    const data = response.response;
    if (!(data instanceof ArrayBuffer)) {
      return {
        blob: new Blob([], { type: contentType || 'application/octet-stream' }),
        contentType,
        size: 0,
      };
    }
    const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
    return { blob, contentType, size: data.byteLength || blob.size || 0 };
  }

  if (mode === 'blob') {
    const blob = response.response instanceof Blob
      ? response.response
      : new Blob([], { type: contentType || 'application/octet-stream' });
    return { blob, contentType: contentType || blob.type || '', size: blob.size || 0 };
  }

  const blob = binaryTextToBlob(response.responseText, contentType);
  return { blob, contentType, size: blob.size || 0 };
}

function normalizePngUrl(row) {
  if (row.redirectUrl && row.redirectUrl.includes('/png/png.dll?')) {
    return row.redirectUrl;
  }
  if (row.pid) {
    return `http://202.117.24.155:98/png/png.dll?pid=${encodeURIComponent(row.pid)}`;
  }
  return '';
}

function extractPidFromUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text, location.href);
    return parsed.searchParams.get('pid') || '';
  } catch {
    return '';
  }
}

function buildImageUrlCandidates(row) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (url) => {
    const normalized = String(url || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  addCandidate(normalizePngUrl(row));
  addCandidate(row.localUrl);
  return candidates;
}

async function requestImageBlob(url, timeoutMs) {
  const errors = [];

  for (const mode of CONFIG.pdfRequestRetryModes) {
    try {
      const response = await requestReaderResource(url, timeoutMs, { mode });
      const status = Number(response.status || 0);
      if (status < 200 || status >= 300) {
        errors.push(`${mode}:http-${status || 'unknown'}`);
        continue;
      }

      const blobInfo = responseToBlob(response, mode);
      if ((blobInfo.size || 0) <= 0 || (blobInfo.blob && blobInfo.blob.size <= 0)) {
        const finalUrl = response.finalUrl || url;
        errors.push(`${mode}:empty(size=0,status=${status},type=${blobInfo.contentType || 'unknown'},final=${finalUrl})`);
        continue;
      }

      return {
        blob: blobInfo.blob,
        contentType: blobInfo.contentType,
        finalUrl: response.finalUrl || url,
        requestMode: mode,
      };
    } catch (error) {
      errors.push(`${mode}:${String(error)}`);
    }
  }

  throw new Error(`image request failed: ${errors.join(' | ')}`);
}

async function requestRowImageBlob(row, timeoutMs) {
  const candidates = buildImageUrlCandidates(row);
  const candidateErrors = [];

  for (const candidateUrl of candidates) {
    try {
      return await requestImageBlob(candidateUrl, timeoutMs);
    } catch (error) {
      const candidateType = candidateUrl === row.localUrl ? 'reader-url' : 'png-url';
      candidateErrors.push(`${candidateType}: ${normalizeErrorMessage(error)}`);
    }
  }

  throw new Error(candidateErrors.join(' | ') || 'image request failed');
}

function loadImageFromBlob(blob) {
  const triedTypes = new Set();
  const candidateTypes = [blob.type, 'image/jpeg', 'image/png', 'image/webp']
    .map((v) => String(v || '').trim().toLowerCase())
    .filter((v) => v && !triedTypes.has(v) && triedTypes.add(v));

  return new Promise((resolve, reject) => {
    let current = 0;

    const tryNext = () => {
      if (current >= candidateTypes.length) {
        reject(new Error(`decode image failed (blob.type=${blob.type || 'unknown'}, size=${blob.size})`));
        return;
      }

      const tryType = candidateTypes[current];
      current += 1;

      const candidateBlob = blob.type === tryType ? blob : blob.slice(0, blob.size, tryType);
      const objectUrl = URL.createObjectURL(candidateBlob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        tryNext();
      };
      image.src = objectUrl;
    };

    tryNext();
  });
}

const SETTINGS_STORAGE_KEY = 'xjtu_pdf_downloader_settings';
const CACHE_DB_NAME = 'xjtu_pdf_downloader_cache';
const CACHE_DB_VERSION = 1;
const JOB_STORE_NAME = 'jobs';
const PAGE_STORE_NAME = 'pages';
const BLOB_STORE_NAME = 'page_blobs';

const DEFAULT_SETTINGS = Object.freeze({
  requestDelayMs: CONFIG.requestDelayMs,
  maxRetries: 2,
  continueOnError: true,
  maxImageDimension: 0,
});

let cacheDbPromise = null;

function normalizeSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    requestDelayMs: normalizeRequestDelayMs(raw.requestDelayMs),
    maxRetries: normalizeMaxRetries(raw.maxRetries),
    continueOnError: raw.continueOnError === undefined
      ? DEFAULT_SETTINGS.continueOnError
      : Boolean(raw.continueOnError),
    maxImageDimension: normalizeMaxImageDimension(raw.maxImageDimension),
  };
}

function loadSettings() {
  if (typeof GM_getValue !== 'function') {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
  return normalizeSettings(GM_getValue(SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS));
}

function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  if (typeof GM_setValue === 'function') {
    GM_setValue(SETTINGS_STORAGE_KEY, normalized);
  }
  return normalized;
}

function applySettingsToConfig(settings) {
  CONFIG.requestDelayMs = settings.requestDelayMs;
}

function readReaderIdentityFromLocation() {
  try {
    const url = new URL(location.href);
    return {
      ssno: String(url.searchParams.get('ssno') || '').trim(),
      channel: String(url.searchParams.get('channel') || '').trim(),
    };
  } catch {
    return { ssno: '', channel: '' };
  }
}

function buildLegacyJobKey(config) {
  return `${location.origin}/jpath/${config.jpgPath}`;
}

function buildJobKey(config) {
  const identity = readReaderIdentityFromLocation();
  if (identity.ssno) {
    return `${location.origin}::reader::ssno=${identity.ssno}::channel=${identity.channel || 'unknown'}`;
  }
  return buildLegacyJobKey(config);
}

function buildJobKeys(config) {
  const keys = [];
  const seen = new Set();
  const add = (value) => {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  add(buildJobKey(config));
  add(buildLegacyJobKey(config));
  return keys;
}

function buildPageKey(jobKey, totalPage) {
  return `${jobKey}::${totalPage}`;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB request failed'));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('indexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('indexedDB transaction aborted'));
  });
}

function openCacheDatabase() {
  if (cacheDbPromise) return cacheDbPromise;

  cacheDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }

    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(JOB_STORE_NAME)) {
        db.createObjectStore(JOB_STORE_NAME, { keyPath: 'jobKey' });
      }

      if (!db.objectStoreNames.contains(PAGE_STORE_NAME)) {
        const pageStore = db.createObjectStore(PAGE_STORE_NAME, { keyPath: 'pageKey' });
        pageStore.createIndex('jobKey', 'jobKey', { unique: false });
      }

      if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) {
        db.createObjectStore(BLOB_STORE_NAME, { keyPath: 'blobKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB open failed'));
  }).catch((error) => {
    cacheDbPromise = null;
    throw error;
  });

  return cacheDbPromise;
}

async function getStoreValue(storeName, key) {
  const db = await openCacheDatabase();
  const transaction = db.transaction(storeName, 'readonly');
  const store = transaction.objectStore(storeName);
  const result = await requestToPromise(store.get(key));
  await transactionToPromise(transaction);
  return result || null;
}

async function getIndexValues(storeName, indexName, key) {
  const db = await openCacheDatabase();
  const transaction = db.transaction(storeName, 'readonly');
  const store = transaction.objectStore(storeName);
  const result = await requestToPromise(store.index(indexName).getAll(IDBKeyRange.only(key)));
  await transactionToPromise(transaction);
  return Array.isArray(result) ? result : [];
}

async function getIndexValuesByKeys(storeName, indexName, keys) {
  const values = [];
  for (const key of keys) {
    const result = await getIndexValues(storeName, indexName, key);
    values.push(...result);
  }
  return values;
}

function sortPageMetasByJobKeyPriority(pageMetas, preferredKeys) {
  const priority = new Map(preferredKeys.map((key, index) => [key, index]));
  return pageMetas.slice().sort((a, b) => {
    const aPriority = priority.has(a.jobKey) ? priority.get(a.jobKey) : Number.MAX_SAFE_INTEGER;
    const bPriority = priority.has(b.jobKey) ? priority.get(b.jobKey) : Number.MAX_SAFE_INTEGER;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });
}

function dedupePageMetasByTotalPage(pageMetas, preferredKeys) {
  const deduped = [];
  const seen = new Set();
  sortPageMetasByJobKeyPriority(pageMetas, preferredKeys).forEach((pageMeta) => {
    const key = Number(pageMeta.totalPage || 0);
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(pageMeta);
  });
  return deduped;
}

async function ensureJobRecord(state) {
  const existing = await getStoreValue(JOB_STORE_NAME, state.jobKey);
  const now = Date.now();
  const nextRecord = {
    jobKey: state.jobKey,
    title: state.title,
    jpgPath: state.jpgPath,
    totalRows: state.rows.length,
    updatedAt: now,
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
  };

  const db = await openCacheDatabase();
  const transaction = db.transaction(JOB_STORE_NAME, 'readwrite');
  transaction.objectStore(JOB_STORE_NAME).put(nextRecord);
  await transactionToPromise(transaction);
  return nextRecord;
}

function buildPageMeta(state, row, overrides) {
  const pageKey = buildPageKey(state.jobKey, row.totalPage);
  return {
    pageKey,
    blobKey: pageKey,
    jobKey: state.jobKey,
    totalPage: row.totalPage,
    pageType: row.pageType,
    pageTypeName: row.pageTypeName,
    pageInType: row.pageInType,
    fileName: row.fileName,
    localUrl: row.localUrl,
    redirectUrl: row.redirectUrl || '',
    pid: row.pid || '',
    lastErrorStage: row.lastErrorStage || '',
    lastErrorMessage: row.lastErrorMessage || '',
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function storeSuccessfulPageCache(state, row, imageResponse, attemptsUsed) {
  const pageMeta = buildPageMeta(state, row, {
    downloadStatus: 'success',
    attemptsUsed,
    lastError: '',
    contentType: imageResponse.contentType || '',
    finalUrl: imageResponse.finalUrl || row.redirectUrl || '',
    requestMode: imageResponse.requestMode || '',
  });

  const db = await openCacheDatabase();
  const transaction = db.transaction([JOB_STORE_NAME, PAGE_STORE_NAME, BLOB_STORE_NAME], 'readwrite');
  transaction.objectStore(JOB_STORE_NAME).put({
    jobKey: state.jobKey,
    title: state.title,
    jpgPath: state.jpgPath,
    totalRows: state.rows.length,
    updatedAt: Date.now(),
    createdAt: state.jobCreatedAt || Date.now(),
  });
  transaction.objectStore(PAGE_STORE_NAME).put(pageMeta);
  transaction.objectStore(BLOB_STORE_NAME).put({
    blobKey: pageMeta.blobKey,
    blob: imageResponse.blob,
    updatedAt: Date.now(),
  });
  await transactionToPromise(transaction);
  return pageMeta;
}

async function storeFailedPageCache(state, row, attemptsUsed, lastError) {
  const pageMeta = buildPageMeta(state, row, {
    downloadStatus: 'error',
    attemptsUsed,
    lastError: normalizeErrorMessage(lastError),
    contentType: '',
    finalUrl: row.redirectUrl || '',
    requestMode: '',
  });

  const db = await openCacheDatabase();
  const transaction = db.transaction([JOB_STORE_NAME, PAGE_STORE_NAME, BLOB_STORE_NAME], 'readwrite');
  transaction.objectStore(JOB_STORE_NAME).put({
    jobKey: state.jobKey,
    title: state.title,
    jpgPath: state.jpgPath,
    totalRows: state.rows.length,
    updatedAt: Date.now(),
    createdAt: state.jobCreatedAt || Date.now(),
  });
  transaction.objectStore(PAGE_STORE_NAME).put(pageMeta);
  transaction.objectStore(BLOB_STORE_NAME).delete(pageMeta.blobKey);
  await transactionToPromise(transaction);
  return pageMeta;
}

async function getCachedPageBundle(jobKeys, totalPage) {
  const keys = Array.isArray(jobKeys) ? jobKeys : [jobKeys];

  for (const jobKey of keys) {
    const pageKey = buildPageKey(jobKey, totalPage);
    const [pageMeta, blobRecord] = await Promise.all([
      getStoreValue(PAGE_STORE_NAME, pageKey),
      getStoreValue(BLOB_STORE_NAME, pageKey),
    ]);

    if (!pageMeta) continue;
    return {
      pageMeta,
      blob: blobRecord && blobRecord.blob ? blobRecord.blob : null,
    };
  }

  return null;
}

function applyPageMetaToRow(row, pageMeta) {
  if (!pageMeta) return row;
  row.redirectUrl = pageMeta.redirectUrl || row.redirectUrl;
  row.pid = pageMeta.pid || row.pid;
  row.lastErrorStage = pageMeta.lastErrorStage || '';
  row.lastErrorMessage = pageMeta.lastErrorMessage || '';
  if (pageMeta.downloadStatus === 'success') {
    row.status = 'cached';
  } else if (pageMeta.downloadStatus === 'error') {
    const stageLabel = getErrorStageLabel(pageMeta.lastErrorStage);
    row.status = `缓存失败记录(${stageLabel}): ${pageMeta.lastErrorMessage || pageMeta.lastError || 'unknown'}`;
  }
  return row;
}

async function getJobCacheSummary(jobKeys, totalRows) {
  const keys = Array.isArray(jobKeys) ? jobKeys : [jobKeys];
  const rawPageMetas = await getIndexValuesByKeys(PAGE_STORE_NAME, 'jobKey', keys);
  const pageMetas = dedupePageMetasByTotalPage(rawPageMetas, keys);
  let cachedCount = 0;
  let errorCount = 0;
  let latestUpdatedAt = 0;

  pageMetas.forEach((pageMeta) => {
    latestUpdatedAt = Math.max(latestUpdatedAt, Number(pageMeta.updatedAt || 0));
    if (pageMeta.downloadStatus === 'success') {
      cachedCount += 1;
    } else if (pageMeta.downloadStatus === 'error') {
      errorCount += 1;
    }
  });

  return {
    totalRows,
    cachedCount,
    errorCount,
    latestUpdatedAt,
    pageMetas,
  };
}

async function clearJobCache(jobKeys) {
  const keys = Array.isArray(jobKeys) ? jobKeys : [jobKeys];
  const pageMetas = await getIndexValuesByKeys(PAGE_STORE_NAME, 'jobKey', keys);
  const db = await openCacheDatabase();
  const transaction = db.transaction([JOB_STORE_NAME, PAGE_STORE_NAME, BLOB_STORE_NAME], 'readwrite');
  const pageStore = transaction.objectStore(PAGE_STORE_NAME);
  const blobStore = transaction.objectStore(BLOB_STORE_NAME);

  pageMetas.forEach((pageMeta) => {
    pageStore.delete(pageMeta.pageKey);
    blobStore.delete(pageMeta.blobKey);
  });
  keys.forEach((jobKey) => {
    transaction.objectStore(JOB_STORE_NAME).delete(jobKey);
  });
  await transactionToPromise(transaction);
}

function formatCacheSummary(summary) {
  const cachedPart = `已缓存 ${summary.cachedCount}/${summary.totalRows} 页`;
  if (summary.errorCount > 0) {
    return `缓存: ${cachedPart}，失败 ${summary.errorCount} 页`;
  }
  return `缓存: ${cachedPart}`;
}

function extractChapterEntriesFromZTree(rows) {
  const jq = window.jQuery;
  if (!jq || !jq.fn || !jq.fn.zTree || typeof jq.fn.zTree.getZTreeObj !== 'function') {
    return [];
  }

  const contentTotalPages = new Set(
    rows.filter((row) => row.pageType === 5).map((row) => row.totalPage),
  );
  if (contentTotalPages.size === 0) return [];

  const chapterEntries = [];
  const seenByStartPage = new Set();
  const candidateIds = new Set([
    ...Array.from(document.querySelectorAll('.ztree[id]')).map((el) => el.id),
    ...Array.from(document.querySelectorAll('[id]'))
      .map((el) => el.id)
      .filter((id) => /tree|dir/i.test(id)),
  ]);

  const walkNodes = (nodes) => {
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    nodes.forEach((node) => {
      if (!node || typeof node !== 'object') return;
      const title = normalizeChapterTitle(node.name || node.title || node.text || '');
      const startTotalPage = Number.parseInt(String(node.pageNumber), 10);
      if (
        isLikelyChapterTitle(title)
        && Number.isInteger(startTotalPage)
        && startTotalPage > 0
        && contentTotalPages.has(startTotalPage)
        && !seenByStartPage.has(startTotalPage)
      ) {
        seenByStartPage.add(startTotalPage);
        chapterEntries.push({ title, startTotalPage });
      }

      if (Array.isArray(node.children) && node.children.length > 0) {
        walkNodes(node.children);
      }
    });
  };

  candidateIds.forEach((id) => {
    try {
      const ztree = jq.fn.zTree.getZTreeObj(id);
      if (!ztree || typeof ztree.getNodes !== 'function') return;
      walkNodes(ztree.getNodes());
    } catch {
      // ignore invalid tree id
    }
  });

  chapterEntries.sort((a, b) => a.startTotalPage - b.startTotalPage);
  return chapterEntries;
}

function buildPdfBookmarkGroups(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const chapterEntries = extractChapterEntriesFromZTree(rows);
  if (chapterEntries.length === 0) {
    // 不做分章回退：拿不到真实章节信息就直接使用页码书签。
    return [];
  }

  const groups = [];
  const pushGroup = (title, groupRows) => {
    if (!groupRows || groupRows.length === 0) return;
    groups.push({ title, rows: groupRows });
  };

  pushGroup('封面', rows.filter((row) => row.pageType >= 0 && row.pageType <= 3));
  pushGroup('目录', rows.filter((row) => row.pageType === 4));

  const contentRows = rows
    .filter((row) => row.pageType === 5)
    .sort((a, b) => a.totalPage - b.totalPage);
  if (contentRows.length > 0) {
    const firstContentTotalPage = contentRows[0].totalPage;
    for (let i = 0; i < chapterEntries.length; i += 1) {
      const chapter = chapterEntries[i];
      const nextChapter = chapterEntries[i + 1];
      const rangeStart = i === 0 ? firstContentTotalPage : chapter.startTotalPage;
      const rangeEndExclusive = nextChapter ? nextChapter.startTotalPage : Number.MAX_SAFE_INTEGER;
      const chapterRows = contentRows.filter(
        (row) => row.totalPage >= rangeStart && row.totalPage < rangeEndExclusive,
      );
      pushGroup(chapter.title, chapterRows);
    }
  }

  pushGroup('附录', rows.filter((row) => row.pageType === 6));
  pushGroup('封底', rows.filter((row) => row.pageType === 7));
  return groups;
}

function buildBookmarkPageLabel(row) {
  return `第${getPublicationPageNumber(row)}页`;
}

function addPdfBookmarks(pdf, rows) {
  if (!pdf || !pdf.outline || typeof pdf.outline.add !== 'function') {
    return;
  }

  const pageNumByTotalPage = new Map();
  rows.forEach((row, idx) => {
    pageNumByTotalPage.set(row.totalPage, idx + 1);
  });

  const groups = buildPdfBookmarkGroups(rows);
  if (groups.length === 0) {
    rows.forEach((row) => {
      const rowPdfPage = pageNumByTotalPage.get(row.totalPage);
      if (!rowPdfPage) return;
      const label = `${row.pageTypeName} ${buildBookmarkPageLabel(row)}`;
      pdf.outline.add(null, label, { pageNumber: rowPdfPage });
    });
    if (typeof pdf.setDisplayMode === 'function') {
      pdf.setDisplayMode(undefined, undefined, 'UseOutlines');
    }
    return;
  }

  groups.forEach((group) => {
    const first = group.rows[0];
    const firstPdfPage = pageNumByTotalPage.get(first.totalPage);
    if (!firstPdfPage) return;

    const parent = pdf.outline.add(null, group.title, { pageNumber: firstPdfPage });
    group.rows.forEach((row) => {
      const rowPdfPage = pageNumByTotalPage.get(row.totalPage);
      if (!rowPdfPage) return;
      pdf.outline.add(parent, buildBookmarkPageLabel(row), { pageNumber: rowPdfPage });
    });
  });

  if (typeof pdf.setDisplayMode === 'function') {
    pdf.setDisplayMode(undefined, undefined, 'UseOutlines');
  }
}

function createRequestThrottle() {
  let lastRequestAt = 0;

  return async function throttle() {
    const delayMs = Math.max(0, Number(CONFIG.requestDelayMs) || 0);
    if (delayMs <= 0) {
      lastRequestAt = Date.now();
      return;
    }

    const now = Date.now();
    const waitMs = Math.max(0, lastRequestAt + delayMs - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = Date.now();
  };
}

function updateRowFromImageResponse(row, imageResponse) {
  row.redirectUrl = imageResponse.finalUrl || row.redirectUrl;
  const pid = extractPidFromUrl(imageResponse.finalUrl);
  if (pid) {
    row.pid = pid;
  }
  clearRowError(row);
  row.status = 'ok';
}

async function tryGetCachedPreparedPage(state, row) {
  try {
    const cachedBundle = await getCachedPageBundle(state.jobKeys, row.totalPage);
    if (!cachedBundle || !cachedBundle.pageMeta) return null;
    applyPageMetaToRow(row, cachedBundle.pageMeta);
    if (cachedBundle.pageMeta.downloadStatus !== 'success' || !cachedBundle.blob) {
      return null;
    }
    return {
      row,
      blob: cachedBundle.blob,
      source: 'cache',
      attemptsUsed: Number(cachedBundle.pageMeta.attemptsUsed || 0),
    };
  } catch (error) {
    console.warn('[xjtu-pdf-downloader] read cache failed', error);
    return null;
  }
}

async function tryStoreSuccessfulPreparedPage(state, row, imageResponse, attemptsUsed) {
  try {
    await storeSuccessfulPageCache(state, row, imageResponse, attemptsUsed);
    return true;
  } catch (error) {
    console.warn('[xjtu-pdf-downloader] write cache failed', error);
    return false;
  }
}

async function tryStoreFailedPreparedPage(state, row, attemptsUsed, error) {
  try {
    await storeFailedPageCache(state, row, attemptsUsed, error);
  } catch (storageError) {
    console.warn('[xjtu-pdf-downloader] write failure cache failed', storageError);
  }
}

async function downloadPreparedPage(state, row, throttle) {
  let attemptsUsed = 0;
  let lastError = null;

  for (let attempt = 0; attempt <= state.settings.maxRetries; attempt += 1) {
    attemptsUsed = attempt + 1;
    try {
      await throttle();
      const imageResponse = await requestRowImageBlob(row, CONFIG.requestTimeoutMs);
      updateRowFromImageResponse(row, imageResponse);
      const cached = await tryStoreSuccessfulPreparedPage(state, row, imageResponse, attemptsUsed);
      row.status = cached ? 'cached' : 'ok';
      return {
        row,
        blob: imageResponse.blob,
        source: 'network',
        attemptsUsed,
      };
    } catch (error) {
      lastError = error;
    }
  }

  setRowError(row, 'image', lastError || 'unknown');
  await tryStoreFailedPreparedPage(state, row, attemptsUsed, lastError);
  throw new Error(normalizeErrorMessage(lastError) || `第 ${row.totalPage} 页下载失败`);
}

async function preparePdfPages(rows, state, panel, throttle) {
  const preparedPages = [];
  const failedRows = [];
  let cachedCount = 0;
  let downloadedCount = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    setPanelProgress(panel, `资源准备中 ${i + 1}/${rows.length}: 第 ${row.totalPage} 页`);

    try {
      const cachedPreparedPage = await tryGetCachedPreparedPage(state, row);
      if (cachedPreparedPage) {
        cachedCount += 1;
        preparedPages.push(cachedPreparedPage);
        continue;
      }

      const downloadedPreparedPage = await downloadPreparedPage(state, row, throttle);
      downloadedCount += 1;
      preparedPages.push(downloadedPreparedPage);
    } catch (error) {
      const failure = buildFailureRecord(row, 'image', error);
      failedRows.push(failure);
      if (!state.settings.continueOnError) {
        throw new Error(formatFailureRecord(failure));
      }
    }
  }

  return {
    preparedPages,
    failedRows,
    cachedCount,
    downloadedCount,
  };
}

async function appendPreparedPagesToPdf(preparedPages, state, panel, failedRows) {
  const JsPdfCtor = window.jspdf && window.jspdf.jsPDF;
  if (!JsPdfCtor) {
    throw new Error('jsPDF 未加载，无法导出 PDF');
  }

  let pdf = null;
  const successfulRows = [];

  for (let i = 0; i < preparedPages.length; i += 1) {
    const preparedPage = preparedPages[i];
    const row = preparedPage.row;
    setPanelProgress(panel, `PDF 生成中 ${i + 1}/${preparedPages.length}: 第 ${row.totalPage} 页`);

    try {
      const image = await loadImageFromBlob(preparedPage.blob);
      const rendered = renderImageToPdfCanvas(image, state.settings.maxImageDimension);
      const orientation = rendered.width >= rendered.height ? 'landscape' : 'portrait';

      if (!pdf) {
        pdf = new JsPdfCtor({
          orientation,
          unit: 'pt',
          format: [rendered.width, rendered.height],
          compress: true,
        });
      } else {
        pdf.addPage([rendered.width, rendered.height], orientation);
      }

      pdf.addImage(rendered.canvas, 'JPEG', 0, 0, rendered.width, rendered.height, undefined, 'FAST');
      successfulRows.push(row);

      image.src = '';
      releaseCanvas(rendered.canvas);
    } catch (error) {
      setRowError(row, 'pdf', error);
      const failure = buildFailureRecord(row, 'pdf', error);
      failedRows.push(failure);
      await tryStoreFailedPreparedPage(state, row, preparedPage.attemptsUsed, error);
      if (!state.settings.continueOnError) {
        throw new Error(formatFailureRecord(failure));
      }
    }
  }

  if (!pdf || successfulRows.length === 0) {
    throw new Error('没有可导出的页面');
  }

  return { pdf, successfulRows };
}

function buildPdfFileName(titlePrefix, rangeStart, rangeEnd, failedRows) {
  const partialSuffix = failedRows.length > 0 ? '_partial' : '';
  return `${sanitizeFileName(titlePrefix)}_${rangeStart}-${rangeEnd}${partialSuffix}.pdf`;
}

function buildPdfCompletionMessage(fileName, successfulRows, failedRows, cachedCount, downloadedCount) {
  const parts = [
    `PDF 下载已触发：${fileName}`,
    `成功 ${successfulRows.length} 页`,
    `失败 ${failedRows.length} 页`,
    `缓存复用 ${cachedCount} 页`,
    `新下载 ${downloadedCount} 页`,
  ];

  if (failedRows.length > 0) {
    parts.push(`失败分布: ${formatFailureStageSummary(failedRows)}`);
    parts.push(`首个失败: ${formatFailureRecord(failedRows[0])}`);
  }

  return parts.join('，');
}

async function downloadRowsAsPdf(rows, state, panel, rangeStart, rangeEnd) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('没有可下载的页面');
  }

  const throttle = createRequestThrottle();
  const preparation = await preparePdfPages(rows, state, panel, throttle);
  if (preparation.preparedPages.length === 0) {
    throw new Error(preparation.failedRows[0] ? formatFailureRecord(preparation.failedRows[0]) : '没有可导出的页面');
  }

  const failedRows = preparation.failedRows.slice();
  const pdfResult = await appendPreparedPagesToPdf(preparation.preparedPages, state, panel, failedRows);
  addPdfBookmarks(pdfResult.pdf, pdfResult.successfulRows);

  const fileName = buildPdfFileName(state.title, rangeStart, rangeEnd, failedRows);
  pdfResult.pdf.save(fileName);
  setPanelProgress(
    panel,
    buildPdfCompletionMessage(
      fileName,
      pdfResult.successfulRows,
      failedRows,
      preparation.cachedCount,
      preparation.downloadedCount,
    ),
  );

  return {
    fileName,
    successfulRows: pdfResult.successfulRows,
    failedRows,
    cachedCount: preparation.cachedCount,
    downloadedCount: preparation.downloadedCount,
  };
}

function parseInlineReaderConfig() {
  const scripts = Array.from(document.scripts)
    .filter((s) => !s.src)
    .map((s) => s.textContent);

  const text = scripts.find((t) => t.includes('var pages =') && t.includes('jpgPath:'));
  if (!text) return null;

  const pagesMatch = text.match(/var pages = (\[[\s\S]*?\]);/);
  const jpgPathMatch = text.match(/jpgPath:\s*"([^"]+)"/);
  const watermarkMatch = text.match(/waterMark:\s*"([^"]*)"/);

  if (!pagesMatch || !jpgPathMatch) return null;

  let pages;
  try {
    pages = JSON.parse(pagesMatch[1]);
  } catch {
    return null;
  }

  return {
    pages,
    jpgPath: jpgPathMatch[1],
    waterMark: watermarkMatch ? watermarkMatch[1] : '',
  };
}

function buildPageMap(pages, jpgPath) {
  const rows = [];
  let totalPage = 1;

  pages.forEach((range, pageType) => {
    const [start, end] = range;
    if (start > end || start <= 0) return;

    for (let page = start; page <= end; page += 1) {
      let realPage = page;
      if (pageType === 0) realPage = 1;
      if (pageType === 7) realPage = 2;

      const prefix = PAGE_TYPE_INFO[pageType].key;
      const fileName = `${padPageStr(realPage, prefix)}.jpg`;
      const localUrl = `${location.origin}/jpath/${jpgPath}${fileName}?zoom=0`;

      rows.push({
        totalPage,
        pageType,
        pageTypeName: PAGE_TYPE_INFO[pageType].name,
        pageInType: page,
        fileName,
        localUrl,
        redirectUrl: '',
        pid: '',
        lastErrorStage: '',
        lastErrorMessage: '',
        status: 'pending',
      });

      totalPage += 1;
    }
  });

  return rows;
}

async function resolvePid(row) {
  try {
    const response = await requestReaderResource(row.localUrl, CONFIG.requestTimeoutMs);
    const finalUrl = response.finalUrl || '';
    row.redirectUrl = finalUrl;

    if (!finalUrl) {
      setRowError(row, 'pid', `未获取到 finalUrl (HTTP ${response.status || 'unknown'})`);
      return row;
    }

    const remoteUrl = new URL(finalUrl, location.href);
    row.pid = remoteUrl.searchParams.get('pid') || '';
    if (!finalUrl.includes('/png/png.dll?')) {
      setRowError(row, 'pid', `最终地址不是 png.dll: ${remoteUrl.pathname}`);
      return row;
    }
    if (!row.pid) {
      setRowError(row, 'pid', '最终地址中未找到 pid');
      return row;
    }
    clearRowError(row);
    row.status = 'pid-ok';
    return row;
  } catch (error) {
    setRowError(row, 'pid', error);
    return row;
  }
}

async function resolveRowsSerially(rows, onProgress) {
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) {
      await sleep(CONFIG.requestDelayMs);
    }

    const row = await resolvePid(rows[i]);
    if (onProgress) {
      onProgress(i + 1, rows.length, row);
    }
  }
}

function summarisePidRanges(rows) {
  const validRows = rows.filter((row) => row.pid);
  if (validRows.length === 0) return [];

  const ranges = [];
  let current = {
    start: validRows[0].totalPage,
    end: validRows[0].totalPage,
    pid: validRows[0].pid,
  };

  for (let i = 1; i < validRows.length; i += 1) {
    const row = validRows[i];
    if (row.pid === current.pid && row.totalPage === current.end + 1) {
      current.end = row.totalPage;
      continue;
    }
    ranges.push(current);
    current = {
      start: row.totalPage,
      end: row.totalPage,
      pid: row.pid,
    };
  }

  ranges.push(current);
  return ranges;
}

function createPanelLauncher() {
  const launcher = document.createElement('button');
  launcher.id = 'tm-panel-launcher';
  launcher.type = 'button';
  launcher.textContent = '打开下载面板';
  launcher.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'justify-content:center',
    'padding:8px 12px',
    'border:1px solid #d0d7de',
    'border-radius:999px',
    'background:#fff',
    'box-shadow:0 8px 24px rgba(0,0,0,0.14)',
    'font:12px/1.2 monospace',
    'color:#24292f',
    'cursor:pointer',
  ].join(';');
  return launcher;
}

function createPanelContainer(title, totalRows, settings) {
  const panel = document.createElement('section');
  panel.id = 'tm-reader-pid-panel';
  panel.hidden = true;
  panel.style.cssText = [
    'width:560px',
    'max-height:82vh',
    'overflow:auto',
    'background:#fff',
    'border:1px solid #d0d7de',
    'box-shadow:0 8px 24px rgba(0,0,0,0.18)',
    'border-radius:10px',
    'padding:12px',
    'font:12px/1.5 monospace',
    'color:#24292f',
  ].join(';');

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
      <div style="font-weight:700;font-size:13px;">XJTUPdfDownloader</div>
      <button id="tm-panel-close" type="button" style="padding:4px 8px;cursor:pointer;">收起</button>
    </div>
    <div><b>书名:</b> ${escapeHtml(title || '未知书名')}</div>
    <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span><b>限速:</b></span>
      <input id="tm-request-delay" type="number" min="0" max="60000" step="50" value="${settings.requestDelayMs}" style="width:90px;" />
      <span>ms/请求（PID 解析 + PDF 下载）</span>
    </div>
    <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span><b>失败重试:</b></span>
      <input id="tm-max-retries" type="number" min="0" max="5" step="1" value="${settings.maxRetries}" style="width:70px;" />
      <label style="display:inline-flex;align-items:center;gap:4px;">
        <input id="tm-continue-on-error" type="checkbox" ${settings.continueOnError ? 'checked' : ''} />
        <span>失败后继续生成 PDF</span>
      </label>
    </div>
    <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span><b>最大边长:</b></span>
      <input id="tm-max-image-dimension" type="number" min="0" max="10000" step="100" value="${settings.maxImageDimension}" style="width:90px;" />
      <span>px，0 表示保持原始尺寸</span>
    </div>
    <div id="tm-cache-summary" style="margin-top:8px;color:#57606a;">缓存: 读取中...</div>
    <div id="tm-progress" style="margin-top:8px;color:#57606a;">准备就绪</div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span>PDF 页码范围:</span>
      <input id="tm-pdf-start" type="number" min="1" value="1" style="width:70px;" />
      <span>-</span>
      <input id="tm-pdf-end" type="number" min="1" value="${totalRows}" style="width:70px;" />
      <button id="tm-download-pdf" type="button" style="padding:4px 8px;cursor:pointer;">下载 PDF</button>
      <button id="tm-clear-cache" type="button" style="padding:4px 8px;cursor:pointer;">清理当前书缓存</button>
    </div>
  `;

  return panel;
}

function createPanel(title, totalRows, settings) {
  const existing = document.getElementById('tm-reader-pid-root');
  if (existing) existing.remove();

  const root = document.createElement('div');
  root.id = 'tm-reader-pid-root';
  root.style.cssText = [
    'position:fixed',
    'top:16px',
    'right:16px',
    'z-index:999999',
    'display:flex',
    'flex-direction:column',
    'align-items:flex-end',
    'gap:8px',
  ].join(';');

  const launcherEl = createPanelLauncher();
  const panelEl = createPanelContainer(title, totalRows, settings);
  root.appendChild(launcherEl);
  root.appendChild(panelEl);

  document.body.appendChild(root);

  const panel = {
    rootEl: root,
    launcherEl,
    panelEl,
    collapseButton: panelEl.querySelector('#tm-panel-close'),
    cacheSummaryEl: panelEl.querySelector('#tm-cache-summary'),
    progressEl: panelEl.querySelector('#tm-progress'),
    requestDelayInput: panelEl.querySelector('#tm-request-delay'),
    maxRetriesInput: panelEl.querySelector('#tm-max-retries'),
    continueOnErrorInput: panelEl.querySelector('#tm-continue-on-error'),
    maxImageDimensionInput: panelEl.querySelector('#tm-max-image-dimension'),
    pdfStartInput: panelEl.querySelector('#tm-pdf-start'),
    pdfEndInput: panelEl.querySelector('#tm-pdf-end'),
    downloadButton: panelEl.querySelector('#tm-download-pdf'),
    clearCacheButton: panelEl.querySelector('#tm-clear-cache'),
  };

  setPanelCollapsed(panel, true);
  setPanelBusy(panel, false);
  return panel;
}

function setPanelCollapsed(panel, collapsed) {
  panel.launcherEl.hidden = !collapsed;
  panel.panelEl.hidden = collapsed;
}

function setPanelProgress(panel, message) {
  panel.progressEl.textContent = String(message || '');
}

function setPanelCacheSummary(panel, message) {
  panel.cacheSummaryEl.textContent = String(message || '');
}

function setPanelBusy(panel, busy) {
  panel.collapseButton.disabled = !!busy;
  panel.requestDelayInput.disabled = !!busy;
  panel.maxRetriesInput.disabled = !!busy;
  panel.continueOnErrorInput.disabled = !!busy;
  panel.maxImageDimensionInput.disabled = !!busy;
  panel.pdfStartInput.disabled = !!busy;
  panel.pdfEndInput.disabled = !!busy;
  panel.downloadButton.disabled = !!busy;
  panel.clearCacheButton.disabled = !!busy;
  panel.downloadButton.textContent = busy ? '下载中...' : '下载 PDF';
}

function syncPanelRangeInputs(panel, startPage, endPage) {
  panel.pdfStartInput.value = String(startPage);
  panel.pdfEndInput.value = String(endPage);
}

function syncPanelSettings(panel, settings) {
  panel.requestDelayInput.value = String(settings.requestDelayMs);
  panel.maxRetriesInput.value = String(settings.maxRetries);
  panel.continueOnErrorInput.checked = !!settings.continueOnError;
  panel.maxImageDimensionInput.value = String(settings.maxImageDimension);
}

function renderRanges(container, rows) {
  const ranges = summarisePidRanges(rows);
  if (ranges.length === 0) {
    container.innerHTML = '<div style="margin-bottom:6px;font-weight:700;">PID 区间</div><div>暂无可用 PID</div>';
    return;
  }

  const html = ranges.map((range) => `
    <tr>
      <td>${range.start}${range.start === range.end ? '' : `-${range.end}`}</td>
      <td style="word-break:break-all;">${escapeHtml(range.pid)}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div style="margin-bottom:6px;font-weight:700;">PID 区间</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;border-bottom:1px solid #ddd;">页码区间</th>
          <th style="text-align:left;border-bottom:1px solid #ddd;">PID</th>
        </tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
  `;
}

function renderTable(container, rows) {
  const renderedRows = rows.slice(0, CONFIG.maxRowsRendered);
  const html = renderedRows.map((row) => `
    <tr>
      <td>${row.totalPage}</td>
      <td>${escapeHtml(row.pageTypeName)}</td>
      <td>${row.pageInType}</td>
      <td>${escapeHtml(row.fileName)}</td>
      <td style="word-break:break-all;">${escapeHtml(row.pid || '')}</td>
      <td>${escapeHtml(row.status)}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div style="margin-bottom:6px;font-weight:700;">页码 / 文件名 / PID 映射</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;border-bottom:1px solid #ddd;">总页</th>
          <th style="text-align:left;border-bottom:1px solid #ddd;">页型</th>
          <th style="text-align:left;border-bottom:1px solid #ddd;">页内号</th>
          <th style="text-align:left;border-bottom:1px solid #ddd;">文件名</th>
          <th style="text-align:left;border-bottom:1px solid #ddd;">PID</th>
          <th style="text-align:left;border-bottom:1px solid #ddd;">状态</th>
        </tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
  `;
}

async function runResolution(rows, progressEl, rangeWrap, tableWrap) {
  progressEl.textContent = '开始解析 PID...';
  await resolveRowsSerially(rows, (done, total, row) => {
    progressEl.textContent = `解析中 ${done}/${total}: 第 ${row.totalPage} 页 -> ${row.fileName}`;
    renderRanges(rangeWrap, rows);
    renderTable(tableWrap, rows);
  });
  progressEl.textContent = 'PID 解析完成';
  renderRanges(rangeWrap, rows);
  renderTable(tableWrap, rows);
}

function exposeDebugState(state) {
  window.__readerPagePidMap = state;
  console.log('[reader-debug] page/pid map', state);
}

function createAppState(config, settings) {
  const rows = buildPageMap(config.pages, config.jpgPath);
  return {
    title: document.title,
    jpgPath: config.jpgPath,
    waterMark: config.waterMark,
    pages: config.pages,
    rows,
    jobKey: buildJobKey(config),
    jobKeys: buildJobKeys(config),
    jobCreatedAt: null,
    settings,
    cacheSummary: null,
    lastDownloadReport: null,
    extractor: 'GM_xmlhttpRequest.finalUrl',
    config: CONFIG,
    ui: {
      collapsed: true,
      isDownloading: false,
    },
  };
}

function readPanelSettings(panel) {
  return {
    requestDelayMs: panel.requestDelayInput.value,
    maxRetries: panel.maxRetriesInput.value,
    continueOnError: panel.continueOnErrorInput.checked,
    maxImageDimension: panel.maxImageDimensionInput.value,
  };
}

function persistSettingsFromPanel(state, panel, message) {
  state.settings = saveSettings({
    ...state.settings,
    ...readPanelSettings(panel),
  });
  applySettingsToConfig(state.settings);
  syncPanelSettings(panel, state.settings);
  if (message) {
    setPanelProgress(panel, message);
  }
  return state.settings;
}

function setAppPanelCollapsed(state, panel, collapsed) {
  state.ui.collapsed = collapsed;
  setPanelCollapsed(panel, collapsed);
}

function resetRowsToPending(rows) {
  rows.forEach((row) => {
    row.redirectUrl = '';
    row.pid = '';
    clearRowError(row);
    row.status = 'pending';
  });
}

async function refreshCacheSummary(state, panel) {
  try {
    const jobRecord = await ensureJobRecord(state);
    state.jobCreatedAt = jobRecord.createdAt;
    const summary = await getJobCacheSummary(state.jobKeys, state.rows.length);
    state.cacheSummary = summary;
    resetRowsToPending(state.rows);
    summary.pageMetas.forEach((pageMeta) => {
      const row = state.rows.find((item) => item.totalPage === pageMeta.totalPage);
      if (row) {
        applyPageMetaToRow(row, pageMeta);
      }
    });
    setPanelCacheSummary(panel, formatCacheSummary(summary));
  } catch (error) {
    state.cacheSummary = null;
    setPanelCacheSummary(panel, `缓存: 不可用 (${normalizeErrorMessage(error)})`);
  }
}

function getRequestedPdfRange(panel, totalRows) {
  const startPage = Number.parseInt(panel.pdfStartInput.value, 10);
  const endPage = Number.parseInt(panel.pdfEndInput.value, 10);
  const minPage = 1;
  const maxPage = totalRows;

  if (!Number.isInteger(startPage) || !Number.isInteger(endPage)) {
    return { error: 'PDF 页码范围无效' };
  }

  const safeStart = Math.max(minPage, Math.min(startPage, maxPage));
  const safeEnd = Math.max(minPage, Math.min(endPage, maxPage));
  if (safeStart > safeEnd) {
    return { error: '起始页不能大于结束页' };
  }

  return { safeStart, safeEnd };
}

async function handlePdfDownload(state, panel) {
  if (state.ui.isDownloading) return;

  persistSettingsFromPanel(state, panel, '');
  const range = getRequestedPdfRange(panel, state.rows.length);
  if (range.error) {
    setPanelProgress(panel, range.error);
    return;
  }

  syncPanelRangeInputs(panel, range.safeStart, range.safeEnd);
  state.ui.isDownloading = true;
  setPanelBusy(panel, true);

  const selectedRows = state.rows.slice(range.safeStart - 1, range.safeEnd);
  try {
    state.lastDownloadReport = await downloadRowsAsPdf(
      selectedRows,
      state,
      panel,
      range.safeStart,
      range.safeEnd,
    );
    await refreshCacheSummary(state, panel);
  } catch (error) {
    state.lastDownloadReport = {
      fileName: '',
      successfulRows: [],
      failedRows: [],
      cachedCount: 0,
      downloadedCount: 0,
      fatalError: normalizeErrorMessage(error),
    };
    setPanelProgress(panel, `PDF 生成失败: ${normalizeErrorMessage(error)}`);
    await refreshCacheSummary(state, panel);
  } finally {
    state.ui.isDownloading = false;
    setPanelBusy(panel, false);
  }
}

async function handleClearCache(state, panel) {
  if (state.ui.isDownloading) return;

  setPanelBusy(panel, true);
  setPanelProgress(panel, '正在清理当前书缓存...');
  try {
    await clearJobCache(state.jobKeys);
    resetRowsToPending(state.rows);
    await refreshCacheSummary(state, panel);
    setPanelProgress(panel, '当前书缓存已清理');
  } catch (error) {
    setPanelProgress(panel, `清理缓存失败: ${normalizeErrorMessage(error)}`);
  } finally {
    setPanelBusy(panel, false);
  }
}

function bindPanelEvents(state, panel) {
  panel.launcherEl.addEventListener('click', () => {
    setAppPanelCollapsed(state, panel, false);
  });

  panel.collapseButton.addEventListener('click', () => {
    setAppPanelCollapsed(state, panel, true);
  });

  panel.requestDelayInput.addEventListener('change', () => {
    persistSettingsFromPanel(state, panel, '设置已保存');
  });

  panel.requestDelayInput.addEventListener('blur', () => {
    persistSettingsFromPanel(state, panel, '设置已保存');
  });

  panel.maxRetriesInput.addEventListener('change', () => {
    persistSettingsFromPanel(state, panel, '设置已保存');
  });

  panel.maxRetriesInput.addEventListener('blur', () => {
    persistSettingsFromPanel(state, panel, '设置已保存');
  });

  panel.continueOnErrorInput.addEventListener('change', () => {
    persistSettingsFromPanel(state, panel, '设置已保存');
  });

  panel.maxImageDimensionInput.addEventListener('change', () => {
    persistSettingsFromPanel(state, panel, '设置已保存');
  });

  panel.maxImageDimensionInput.addEventListener('blur', () => {
    persistSettingsFromPanel(state, panel, '设置已保存');
  });

  panel.downloadButton.addEventListener('click', async () => {
    await handlePdfDownload(state, panel);
  });

  panel.clearCacheButton.addEventListener('click', async () => {
    await handleClearCache(state, panel);
  });
}

async function main() {
  const config = parseInlineReaderConfig();
  if (!config) return;

  const settings = loadSettings();
  applySettingsToConfig(settings);

  const state = createAppState(config, settings);
  const panel = createPanel(state.title, state.rows.length, state.settings);
  syncPanelSettings(panel, state.settings);
  exposeDebugState(state);
  bindPanelEvents(state, panel);
  await refreshCacheSummary(state, panel);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((error) => {
      console.error('[xjtu-pdf-downloader] bootstrap failed', error);
    });
  }, { once: true });
} else {
  main().catch((error) => {
    console.error('[xjtu-pdf-downloader] bootstrap failed', error);
  });
}
})();
