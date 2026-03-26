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
