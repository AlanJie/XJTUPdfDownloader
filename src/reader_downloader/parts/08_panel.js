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
