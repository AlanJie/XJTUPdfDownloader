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
