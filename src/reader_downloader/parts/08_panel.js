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
