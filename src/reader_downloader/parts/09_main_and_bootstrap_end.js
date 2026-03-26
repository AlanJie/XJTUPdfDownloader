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
