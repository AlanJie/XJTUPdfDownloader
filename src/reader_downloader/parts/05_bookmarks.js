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
