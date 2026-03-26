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
