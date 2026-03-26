# XJTUPdfDownloader

这个仓库当前主要包含一个面向西安交通大学教材平台阅读器页面的 Tampermonkey 用户脚本：`XJTUPdfDownloader`。

它的目标是从阅读器页提取内联配置，建立页面文件名映射，利用图片请求的重定向结果解析 `png.dll?pid=...`，并按指定页码范围抓取页面图片、合成为 PDF。

## 免责声明

- 本项目仅用于互操作性研究、调试分析、个人学习与归档实验。
- 请仅在你对目标资源拥有合法访问权限和明确授权的前提下使用本项目。
- 不应将本项目用于绕过身份认证、访问控制、服务条款限制，或侵犯任何第三方的著作权与其他合法权益。
- 本项目按“现状”提供，作者不对其适用性、可用性或由使用本项目产生的任何直接或间接后果承担责任。

## 功能概览

- 解析阅读器页面内联脚本中的 `pages`、`jpgPath`、`waterMark`
- 生成“总页码 / 页型 / 页内号 / 文件名”的页面映射
- 通过 `GM_xmlhttpRequest` 跟踪图片请求的最终跳转地址，提取 `pid`
- 按页码范围下载页面图片并导出为 PDF
- 使用 `jsPDF` 为 PDF 添加书签
- 优先尝试从页面 zTree 目录中提取章节书签；拿不到章节时退化为逐页书签
- 将调试状态暴露到 `window.__readerPagePidMap`

## 当前状态

脚本会在目标阅读页右上角注入一个控制面板，当前入口已经接通：

- 请求限速设置
- PDF 起止页输入
- PDF 下载触发

同时，页面基础状态会暴露到 `window.__readerPagePidMap`，方便在控制台查看。

需要注意的是：仓库里已经有 PID 区间表和映射表的渲染辅助函数，但当前 `main()` 入口还没有把它们挂到面板初始化流程里。因此，PID 目前主要是在 PDF 下载过程中按需解析并回填，而不是页面加载后自动完整展示。

## 目录结构

```text
.
├── XJTUPdfDownloader.js                 # 默认构建产物，可直接作为 userscript 导入
├── dist/
│   └── XJTUPdfDownloader.user.js        # 分发用 userscript 文件
├── scripts/
│   └── build-xjtu-pdf-downloader.js     # 构建脚本：按文件名顺序拼接 source parts
├── src/
│   └── reader_downloader/
│       ├── README.md                    # 分片源码说明
│       └── parts/
│           ├── 00_userscript_header.js
│           ├── 01_bootstrap_start.js
│           ├── 02_constants.js
│           ├── 03_utils.js
│           ├── 04_network.js
│           ├── 05_bookmarks.js
│           ├── 06_pdf_download.js
│           ├── 07_reader_mapping.js
│           ├── 08_panel.js
│           └── 09_main_and_bootstrap_end.js
└── request-chain-and-params.md          # 对平台请求链和参数的整理笔记
```

## 环境要求

- Node.js
- 支持用户脚本的浏览器扩展，例如 Tampermonkey
- 已登录目标教材平台，并能打开阅读器页面

这个项目没有 `npm` 依赖；构建脚本直接使用 Node.js 内置模块。

## 构建

在仓库根目录执行：

```bash
node scripts/build-xjtu-pdf-downloader.js
```

默认会生成两个文件：

- `XJTUPdfDownloader.js`
- `dist/XJTUPdfDownloader.user.js`

也可以额外指定一个自定义输出路径：

```bash
node scripts/build-xjtu-pdf-downloader.js ./out/XJTUPdfDownloader.js
```

无论是否指定自定义输出，`dist/XJTUPdfDownloader.user.js` 都会同时刷新。

## 安装与使用

### 1. 安装 userscript

优先使用以下任一文件导入 Tampermonkey：

- `dist/XJTUPdfDownloader.user.js`
- `XJTUPdfDownloader.js`

脚本元数据当前只匹配：

```text
http://jiaocai1.lib.xjtu.edu.cn:9088/jpath/reader/reader.shtml*
```

### 2. 打开阅读器页面

先在平台内完成登录，再进入图书阅读页。脚本会在页面加载完成后自动执行，并尝试解析页面里的阅读器配置。

### 3. 导出 PDF

在右上角面板中：

1. 视情况调整请求间隔，避免过快请求
2. 输入要导出的起止页码
3. 点击“下载 PDF”

下载过程中，脚本会：

- 按需解析页面图片对应的 `pid`
- 拉取图片数据
- 按原始图片尺寸写入 PDF
- 尝试附加章节或逐页书签

导出的文件名格式大致为：

```text
<页面标题>_<起始页>-<结束页>.pdf
```

## 调试

页面加载后，可以在浏览器控制台查看脚本收集到的状态：

```js
window.__readerPagePidMap
```

常见字段包括：

- `title`
- `jpgPath`
- `waterMark`
- `pages`
- `rows`
- `config`

这对于排查页面映射、文件名生成规则和 PDF 下载问题会比较方便。

## 实现说明

- 页面映射来自阅读器页内联脚本中的 `var pages = ...` 和 `jpgPath: "..."`
- 单页图片 URL 会先访问站内 `/jpath/.../*.jpg?zoom=0`
- 站内图片请求会跳转到 `http://202.117.24.155:98/png/png.dll?pid=...`
- 脚本通过 `GM_xmlhttpRequest(...).finalUrl` 读取最终地址并提取 `pid`
- PDF 生成依赖 userscript 头里的 `jsPDF` CDN 引用

更多平台链路和接口参数分析，见 [request-chain-and-params.md](./request-chain-and-params.md)。

## 已知限制

- 目前脚本只匹配 `http` 阅读器地址，未覆盖 `https` 或其他域名变体
- 阅读器页面结构、内联变量名或图片链路一旦变化，脚本可能失效
- 当前 UI 重点是 PDF 导出，完整 PID 映射表尚未接入默认初始化流程
- PDF 下载依赖当前登录态和跨域请求权限，未登录或会话失效时会失败
- 仓库目前没有自动化测试

## 许可证

本项目采用 `GNU Lesser General Public License v3.0 only` 许可发布，详见 `LICENSE`。
