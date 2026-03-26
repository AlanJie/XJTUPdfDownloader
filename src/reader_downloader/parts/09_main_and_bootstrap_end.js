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
