# AI客服系统 — 小程序接入指南

## 目录结构

```
miniprogram/
├── utils/
│   └── customerServiceApi.js   # API封装（核心，需改BASE_URL）
└── pages/
    └── customerService/
        ├── index.js            # 页面逻辑
        ├── index.wxml          # 页面结构
        ├── index.wxss          # 页面样式
        └── index.json          # 页面配置
```

---

## 第一步：开通内网穿透（cpolar）

### 1. 安装 cpolar

访问 https://www.cpolar.com 注册账号，下载 Windows 版

或直接用命令安装（管理员 PowerShell）：
```powershell
winget install cpolar
```

### 2. 认证
```powershell
cpolar authtoken 你的token  # 从cpolar官网复制
```

### 3. 启动穿透（映射本地3001端口）
```powershell
cpolar http 3001
```

启动后会显示类似：
```
Forwarding  https://abc123.cpolar.cn  ->  http://localhost:3001
```

**复制这个 https 地址**，这就是你的公网地址 ✅

---

## 第二步：修改 API 地址

打开 `miniprogram/utils/customerServiceApi.js`，修改第一行：

```javascript
// 修改前
const BASE_URL = 'https://your-domain.cpolar.cn';

// 修改后（替换为你的实际地址）
const BASE_URL = 'https://abc123.cpolar.cn';
```

---

## 第三步：将代码复制到你的小程序项目

### 复制文件

1. 将 `utils/customerServiceApi.js` 复制到你小程序项目的 `utils/` 目录
2. 将 `pages/customerService/` 整个文件夹复制到你小程序的 `pages/` 目录

### 注册页面

在你小程序的 `app.json` 中添加：

```json
{
  "pages": [
    "pages/customerService/index",
    "...其他页面..."
  ]
}
```

### 添加图片资源（可选）

在小程序 `images/` 目录放入：
- `robot.png` — 机器人头像（建议 100×100）
- `user-default.png` — 默认用户头像（建议 100×100）

**没有图片也没关系**，用 emoji 替代即可（页面会显示占位框）

---

## 第四步：配置微信公众平台域名白名单

1. 登录 [微信公众平台](https://mp.weixin.qq.com) → 开发 → 开发管理 → 开发设置
2. 找到「服务器域名」→ `request合法域名`
3. 添加你的 cpolar 地址（如：`https://abc123.cpolar.cn`）

> ⚠️ 注意：cpolar 免费版每次重启地址会变化，需重新配置。
> 
> **开发阶段可以在微信开发者工具中勾选「不校验合法域名」跳过此步骤**

---

## 第五步：在任意页面跳转到客服

```javascript
// 任意地方跳转到客服页面
wx.navigateTo({
  url: '/pages/customerService/index'
});
```

或者做一个「联系客服」按钮：

```xml
<!-- 在任意页面的wxml中 -->
<view class="cs-btn" bindtap="goToService">
  💬 联系客服
</view>
```

```javascript
// js中
goToService() {
  wx.navigateTo({ url: '/pages/customerService/index' });
}
```

---

## 快速验证清单

| 步骤 | 验证方法 |
|------|---------|
| 本地服务运行 | 浏览器访问 http://localhost:3001 |
| 内网穿透正常 | 浏览器访问 https://xxx.cpolar.cn/api/health 返回 `{"status":"ok"}` |
| 小程序可访问 | 开发者工具打开客服页面，检查Network请求 |
| 消息发送正常 | 输入文字发送，AI正常回复 |

---

## 常见问题

**Q: 发消息没有反应？**
- 检查 `customerServiceApi.js` 中 BASE_URL 是否已修改
- 检查 cpolar 是否还在运行（关了就断了）
- 微信开发者工具中开启「不校验合法域名」

**Q: 显示"客服服务暂时不可用"？**
- 服务端 Node.js 进程可能已停止，重新启动：
```powershell
Start-Process -FilePath "node" -ArgumentList "c:/Users/Dell/WorkBuddy/20260416233822/ai-customer-service/server/index.js" -WindowStyle Hidden
```

**Q: 想换成云服务器？**
- 将 `ai-customer-service/` 整个目录上传到服务器
- `npm install && node server/index.js`
- 配置 Nginx 反代 + SSL 证书
- 把 BASE_URL 改为你的域名即可

---

## 转人工客服配置

在 `pages/customerService/index.js` 第 130 行修改电话：

```javascript
wx.makePhoneCall({
  phoneNumber: '400-000-0000',  // ← 改为你的客服电话
});
```

或改为跳转企业微信客服：

```javascript
wx.openCustomerServiceChat({
  extInfo: { url: '你的企微客服链接' },
  corpId: '你的企业ID',
});
```
