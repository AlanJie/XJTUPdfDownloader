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
