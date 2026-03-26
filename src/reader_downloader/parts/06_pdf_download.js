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
