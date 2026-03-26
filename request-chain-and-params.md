# 图书平台请求链与接口参数说明（脱敏版）

本文只保留请求链与接口参数说明。

以下内容中的用户身份、会话票据、访问令牌、具体书籍标识、水印文本和资源标识均已替换为占位符。

## 1. 登录与首页落地链路

### 1.1 入口访问

从首页入口开始：

```text
GET http://jiaocai1.lib.xjtu.edu.cn:9088/
-> 302 /front/user/innerLogin?origin=%2Ffront%2Fbook%2Findex%3F
```

### 1.2 平台内登录跳转

```text
GET /front/user/innerLogin?origin=%2Ffront%2Fbook%2Findex%3F
-> 302 http://org.xjtu.edu.cn/openplatform/oauth/authorize?appId=1501&redirectUri=http://jiaocai1.lib.xjtu.edu.cn:9088/front/user/authLogin&responseType=code&scope=user_info&state=<encoded_state>
```

### 1.3 统一认证链路

```text
GET https://org.xjtu.edu.cn/openplatform/oauth/authorize?... 
-> 302 https://login.xjtu.edu.cn/cas/oauth2.0/authorize?response_type=code&client_id=1501&redirect_uri=https%3A%2F%2Forg.xjtu.edu.cn%2Fopenplatform%2Foauth%2Fauthorizesw%3Fredirect_uri%3Dhttp%3A%2F%2Fjiaocai1.lib.xjtu.edu.cn%3A9088%2Ffront%2Fuser%2FauthLogin&state=<encoded_state>

GET https://login.xjtu.edu.cn/cas/oauth2.0/authorize?... 
-> 302 https://login.xjtu.edu.cn/cas/login?service=<encoded_service>
```

登录提交后：

```text
POST https://login.xjtu.edu.cn/cas/login?service=<encoded_service>
-> 302 https://login.xjtu.edu.cn/cas/oauth2.0/callbackAuthorize?...&ticket=<cas_ticket>

GET https://login.xjtu.edu.cn/cas/oauth2.0/callbackAuthorize?...&ticket=<cas_ticket>
-> 302 https://login.xjtu.edu.cn/cas/oauth2.0/authorize?response_type=code&client_id=1501&redirect_uri=...&state=<encoded_state>

GET https://login.xjtu.edu.cn/cas/oauth2.0/authorize?... 
-> 302 https://org.xjtu.edu.cn/openplatform/oauth/authorizesw?redirect_uri=http://jiaocai1.lib.xjtu.edu.cn:9088/front/user/authLogin&code=<openplatform_code>&state=<encoded_state>

GET https://org.xjtu.edu.cn/openplatform/oauth/authorizesw?... 
-> 302 http://jiaocai1.lib.xjtu.edu.cn:9088/front/user/authLogin?code=<platform_code>&state=<decoded_state>&userType=<user_type>&employeeNo=<employee_no>

GET http://jiaocai1.lib.xjtu.edu.cn:9088/front/user/authLogin?... 
-> 302 /front/book/index?
```

### 1.4 登录后首页

```text
GET http://jiaocai1.lib.xjtu.edu.cn:9088/front/book/index?
-> 200 text/html
```

登录后请求头里已出现业务 Cookie：

```text
cookie: jiagong=<session>
```

## 2. 登录链路参数说明

### 2.1 平台与统一认证参数

| 参数 | 出现位置 | 含义 |
|---|---|---|
| `appId` | `org.xjtu.edu.cn/openplatform/oauth/authorize` | 平台应用 ID |
| `client_id` | `login.xjtu.edu.cn/cas/oauth2.0/authorize` | CAS OAuth 客户端 ID |
| `redirectUri` | OpenPlatform 入口 | 平台登录完成后回调地址 |
| `redirect_uri` | CAS OAuth 入口 | URL 编码后的 OpenPlatform 回调 |
| `responseType` / `response_type` | OAuth 授权链 | 授权码模式 |
| `scope` | OpenPlatform 授权 | 请求的授权范围 |
| `state` | 多段链路 | 原始落地页状态，用于登录后回跳 |
| `service` | CAS 登录页 | CAS 登录后回跳的完整地址 |
| `ticket` | `callbackAuthorize` | CAS 登录票据 |
| `code` | 多段授权回跳 | 授权码或平台内部换发后的访问码 |
| `userType` | `/front/user/authLogin` | 当前用户类型 |
| `employeeNo` | `/front/user/authLogin` | 当前用户标识参数 |

## 3. 图书首页封面图请求链

### 3.1 首页 HTML 的实际输出方式

图书首页 `GET /front/book/index?` 的响应体中，封面图是服务端直接渲染好的：

```html
<img
  onerror="this.src='/static/images/temp/10.jpg'"
  src="http://202.117.24.155:98/cover/cover.dll?did=<did>"
/>
```

也就是说：

- 首页封面图不是前端 JS 动态拼出来的
- 是后端模板直接把 `cover.dll?did=...` 写进 HTML
- 如果远程封面失败，浏览器回退到 `/static/images/temp/*.jpg`

### 3.2 封面图请求

```text
GET http://202.117.24.155:98/cover/cover.dll?did=<did>
referer: http://jiaocai1.lib.xjtu.edu.cn:9088/
```

### 3.3 封面图参数说明

| 参数 | 接口 | 含义 |
|---|---|---|
| `did` | `cover.dll` | 封面资源标识 |

## 4. 阅读器入口链路

进入阅读页前，首页中的“试读”链接形态如下：

```text
GET /front/reader/goRead?ssno=<ssno>&channel=<channel>&jpgread=1
-> 302 /jpath/reader/reader.shtml?channel=<channel>&code=<reader_code>&cpage=1&epage=-1&ipinside=0&netuser=0&spage=1&ssno=<ssno>
```

阅读器实际页面：

```text
GET /jpath/reader/reader.shtml?channel=<channel>&code=<reader_code>&cpage=1&epage=-1&ipinside=0&netuser=0&spage=1&ssno=<ssno>
-> 200 text/html
```

## 5. 阅读器页参数说明

| 参数 | 接口 | 含义 |
|---|---|---|
| `ssno` | `goRead`, `reader.shtml` | 书籍标识 |
| `channel` | `goRead`, `reader.shtml` | 资源频道 |
| `jpgread` | `goRead` | 是否走图片阅读模式 |
| `code` | `reader.shtml` | 阅读器访问令牌 |
| `cpage` | `reader.shtml` | 当前页初始化值 |
| `epage` | `reader.shtml` | 结束页 |
| `spage` | `reader.shtml` | 起始页 |
| `ipinside` | `reader.shtml` | 访问环境标识 |
| `netuser` | `reader.shtml` | 网络用户标识 |

## 6. 阅读器正文图片请求链

### 6.1 前端阅读器配置

阅读器页内联脚本里会初始化类似配置：

```js
var pages = [[1, 1], [1, 1], [1, 1], [1, 5], [1, 1], [1, 281], [1, 0], [2, 2]];

var opts = {
  pages: pages,
  jpgPath: "img/<book_path>/",
  waterMark: "<watermark_text>"
};
```

### 6.2 阅读器 JS 的拼接规则

`jpath/js/reader/reader.js` 中：

```js
var jpgUrl = opts.jpgPath + loadPager.data(...).pageStr + "?zoom=0";
```

初始化页面尺寸时还有一类请求：

```js
var pixyUrl = opts.jpgPath + pageStr + '.jpg?pi=2&zoom=0';
```

所以正文图的站内 URL 规则是：

```text
/jpath/ + jpgPath + 文件名 + ?zoom=0
```

初始化读图尺寸时：

```text
/jpath/ + jpgPath + 文件名 + ?pi=2&zoom=0
```

### 6.3 已观测到的正文页请求形态

```text
GET http://jiaocai1.lib.xjtu.edu.cn:9088/jpath/img/<book_path>/000001.jpg?pi=2&zoom=0
-> 302 http://202.117.24.155:98/png/png.dll?pid=<pid>
```

也就是说当前正文页图片链是：

```text
/jpath/img/.../文件名.jpg?... 
-> 302 /png/png.dll?pid=...
```

### 6.4 正文图接口参数说明

| 参数 | 接口 | 含义 |
|---|---|---|
| `pages` | 阅读器内联配置 | 页面区段配置 |
| `jpgPath` | 阅读器内联配置 | 当前书图片目录前缀 |
| `waterMark` | 阅读器内联配置 | 页面水印文本配置 |
| `pageStr` | 阅读器前端计算 | 当前页对应的文件名，不带 `.jpg` |
| `pi` | `/jpath/img/...jpg` | 初始化读图尺寸时使用 |
| `zoom` | `/jpath/img/...jpg` | 缩放级别 |
| `pid` | `png.dll` | 远程正文图片资源标识 |
