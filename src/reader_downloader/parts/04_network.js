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
