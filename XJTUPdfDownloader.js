// ==UserScript==
// @name         XJTUPdfDownloader
// @namespace    xjtu-pdf-downloader
// @version      0.5.0
// @description  在阅读器页面显示页码、文件名与 png.dll?pid 的对应关系，并支持导出 PDF
// @match        http://jiaocai1.lib.xjtu.edu.cn:9088/jpath/reader/reader.shtml*
// @require      https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
// @connect      jiaocai1.lib.xjtu.edu.cn
// @connect      202.117.24.155
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

const CONFIG = {
  requestDelayMs: 200,
  initialBatchSize: 12,
  requestTimeoutMs: 12000,
  maxRowsRendered: 400,
  pdfImageQuality: 0.92,
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

function requestWithRedirectInfo(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: timeoutMs,
      anonymous: false,
      withCredentials: true,
      redirect: 'follow',
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

function parseHeaderValue(headersText, headerName) {
  const text = String(headersText || '');
  const match = text.match(new RegExp(`^${headerName}:\\s*([^\\r\\n;]+)`, 'im'));
  return match ? match[1].trim() : '';
}

function requestRaw(url, timeoutMs, mode) {
  const requestOptions = {
    method: 'GET',
    url,
    timeout: timeoutMs,
    anonymous: false,
    withCredentials: true,
    redirect: 'follow',
    headers: {
      // png.dll 在缺少 Referer 时常返回 200 + 空包，这里显式带上来源页。
      Referer: location.href,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  };

  if (mode === 'arraybuffer') {
    requestOptions.responseType = 'arraybuffer';
  } else if (mode === 'blob') {
    requestOptions.responseType = 'blob';
  } else if (mode === 'binary-text') {
    requestOptions.overrideMimeType = 'text/plain; charset=x-user-defined';
  }

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
      const response = await requestRaw(url, timeoutMs, mode);
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

async function downloadRowsAsPdf(rows, progressEl, titlePrefix, rangeStart, rangeEnd) {
  const JsPdfCtor = window.jspdf && window.jspdf.jsPDF;
  if (!JsPdfCtor) {
    throw new Error('jsPDF 未加载，无法导出 PDF');
  }
  if (rows.length === 0) {
    throw new Error('没有可下载的页面');
  }

  let pdf = null;
  let lastRequestAt = 0;
  const throttle = async () => {
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

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    progressEl.textContent = `PDF 生成中 ${i + 1}/${rows.length}: 第 ${row.totalPage} 页`;

    if (!row.redirectUrl && !row.pid) {
      await throttle();
      await resolvePid(row);
    }

    const candidates = buildImageUrlCandidates(row);
    let imageResp = null;
    let lastError = '';
    for (const candidateUrl of candidates) {
      try {
        await throttle();
        const resp = await requestImageBlob(candidateUrl, CONFIG.requestTimeoutMs);
        if (resp.contentType && !resp.contentType.startsWith('image/')) {
          throw new Error(`non-image: ${resp.contentType}, final=${resp.finalUrl}`);
        }
        imageResp = resp;
        break;
      } catch (error) {
        lastError = String(error);
      }
    }

    if (!imageResp) {
      throw new Error(`第 ${row.totalPage} 页下载失败: ${lastError || 'unknown'}`);
    }

    const image = await loadImageFromBlob(imageResp.blob);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const orientation = width >= height ? 'landscape' : 'portrait';
    const imageData = imageToJpegDataUrl(image, CONFIG.pdfImageQuality);

    if (!pdf) {
      pdf = new JsPdfCtor({
        orientation,
        unit: 'pt',
        format: [width, height],
        compress: true,
      });
    } else {
      pdf.addPage([width, height], orientation);
    }
    pdf.addImage(imageData, 'JPEG', 0, 0, width, height, undefined, 'FAST');
  }

  addPdfBookmarks(pdf, rows);
  const fileName = `${sanitizeFileName(titlePrefix)}_${rangeStart}-${rangeEnd}.pdf`;
  pdf.save(fileName);
  progressEl.textContent = `PDF 下载已触发：${fileName}`;
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
        status: 'pending',
      });

      totalPage += 1;
    }
  });

  return rows;
}

async function resolvePid(row) {
  try {
    const response = await requestWithRedirectInfo(row.localUrl, CONFIG.requestTimeoutMs);
    const finalUrl = response.finalUrl || '';
    row.redirectUrl = finalUrl;

    if (!finalUrl) {
      row.status = `http-${response.status || 'unknown'}`;
      return row;
    }

    const remoteUrl = new URL(finalUrl, location.href);
    row.pid = remoteUrl.searchParams.get('pid') || '';
    row.status = finalUrl.includes('/png/png.dll?')
      ? (row.pid ? 'ok' : 'no-pid')
      : `final:${remoteUrl.pathname}`;
    return row;
  } catch (error) {
    row.status = `error: ${String(error)}`;
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

function createPanel(data, totalRows) {
  const existing = document.getElementById('tm-reader-pid-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'tm-reader-pid-panel';
  panel.style.cssText = [
    'position:fixed',
    'top:16px',
    'right:16px',
    'z-index:999999',
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
    <div style="font-weight:700;font-size:13px;margin-bottom:8px;">阅读器调试面板</div>
    <div><b>书名:</b> ${escapeHtml(document.title || '未知书名')}</div>
    <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span><b>限速:</b></span>
      <input id="tm-request-delay" type="number" min="0" max="60000" step="50" value="${CONFIG.requestDelayMs}" style="width:90px;" />
      <span>ms/请求（PID 解析 + PDF 下载）</span>
    </div>
    <div style="margin-top:2px;color:#57606a;">默认只解析前 ${CONFIG.initialBatchSize} 页</div>
    <div id="tm-progress" style="margin-top:8px;color:#57606a;">准备就绪</div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span>PDF 页码范围:</span>
      <input id="tm-pdf-start" type="number" min="1" value="1" style="width:70px;" />
      <span>-</span>
      <input id="tm-pdf-end" type="number" min="1" value="${totalRows}" style="width:70px;" />
      <button id="tm-download-pdf">下载 PDF</button>
    </div>
  `;

  document.body.appendChild(panel);
  return panel;
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
    ${rows.length > CONFIG.maxRowsRendered ? `<div style="margin-top:6px;color:#57606a;">仅渲染前 ${CONFIG.maxRowsRendered} 行，完整数据请复制 JSON。</div>` : ''}
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

function main() {
  const config = parseInlineReaderConfig();
  if (!config) return;

  const rows = buildPageMap(config.pages, config.jpgPath);
  const state = {
    title: document.title,
    jpgPath: config.jpgPath,
    waterMark: config.waterMark,
    pages: config.pages,
    rows,
    extractor: 'GM_xmlhttpRequest.finalUrl',
    config: CONFIG,
  };

  const panel = createPanel(config, rows.length);
  const progressEl = panel.querySelector('#tm-progress');
  const requestDelayInput = panel.querySelector('#tm-request-delay');
  const pdfStartInput = panel.querySelector('#tm-pdf-start');
  const pdfEndInput = panel.querySelector('#tm-pdf-end');

  const applyRequestDelay = (showMessage) => {
    const nextDelay = normalizeRequestDelayMs(requestDelayInput.value);
    CONFIG.requestDelayMs = nextDelay;
    requestDelayInput.value = String(nextDelay);
    if (showMessage) {
      progressEl.textContent = `限速已更新：${nextDelay}ms/请求`;
    }
    return nextDelay;
  };

  exposeDebugState(state);

  requestDelayInput.addEventListener('change', () => {
    applyRequestDelay(true);
  });

  requestDelayInput.addEventListener('blur', () => {
    applyRequestDelay(true);
  });

  panel.querySelector('#tm-download-pdf').addEventListener('click', async () => {
    applyRequestDelay(false);
    const startPage = Number.parseInt(pdfStartInput.value, 10);
    const endPage = Number.parseInt(pdfEndInput.value, 10);
    const minPage = 1;
    const maxPage = rows.length;

    if (!Number.isInteger(startPage) || !Number.isInteger(endPage)) {
      progressEl.textContent = 'PDF 页码范围无效';
      return;
    }

    const safeStart = Math.max(minPage, Math.min(startPage, maxPage));
    const safeEnd = Math.max(minPage, Math.min(endPage, maxPage));
    if (safeStart > safeEnd) {
      progressEl.textContent = '起始页不能大于结束页';
      return;
    }

    pdfStartInput.value = String(safeStart);
    pdfEndInput.value = String(safeEnd);

    const selectedRows = rows.slice(safeStart - 1, safeEnd);
    try {
      await downloadRowsAsPdf(selectedRows, progressEl, document.title, safeStart, safeEnd);
    } catch (error) {
      progressEl.textContent = `PDF 生成失败: ${String(error)}`;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}
})();
