# 上手步骤

---

## 1. Fork 我的仓库

打开 [github.com/zhangxq0606-ctrl/github-blindbox](https://github.com/zhangxq0606-ctrl/github-blindbox)，点右上角 **Fork**，选你自己账号，创建。

这一步是把我的代码复制到你名下，后面要改东西都是在你自己仓库里改。

---

## 2. 拿 DeepSeek API Key（推荐，省事）

本项目默认用 **DeepSeek 官方 API** 上的 `deepseek-v4-flash` 模型（快、便宜、效果好）。

### 2.1 创建 Key（3 步走）

1. 打开 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)，注册/登录（支持邮箱、Google、GitHub 登录，无需信用卡）
2. 左上角点 **API Keys** → **Create new API Key** → 填个名字（如 `github-blindbox`）→ **Create**
3. 复制 `sk-` 开头的 Key（**只显示一次，立刻保存好**）

**新用户注册就送免费额度**，够你天天收邮件用好几个月。用完再充值，1 元起充，价格非常低。

### 2.2 ⚠️ DeepSeek 官方注意事项

| # | 坑 | 后果 | 正确做法 |
|---|----|------|---------|
| 1 | Base URL 多了 `/v1` | 404 Not Found | DeepSeek 官方 Base URL **不带 `/v1`**，就写 `https://api.deepseek.com` |
| 2 | Key 还没生成就填了占位符 | 401 Invalid API key | 一定是 `sk-` 开头的一长串，来自 platform.deepseek.com |
| 3 | 模型名写错大小写 | model not found | 全小写：`deepseek-v4-flash` |

### 2.3 备选：阿里云百炼（DashScope）

如果你已经有阿里云百炼账号或业务空间，也能用。配置略有不同：

1. 打开 [bailian.console.aliyun.com](https://bailian.console.aliyun.com/)
2. 「模型广场」→ 搜 `deepseek-v4-flash` → 点**「开通服务」**
3. 「API Key 管理」→ 创建我的 API Key → 复制 `sk-` 开头的 Key

**阿里云百炼的坑更多，配置前必看：**

| # | 坑 | 后果 | 正确做法 |
|---|----|------|---------|
| 1 | Key 拿错了（用了阿里云主账号 AK/SK） | 401 "Incorrect API key" | 用的是「百炼控制台 → API Key 管理」里的 `sk-` Key，**不是**主账号的 AccessKeyId/AccessKeySecret |
| 2 | 端点用了 Anthropic 原生格式 `/apps/anthropic` | 404 | 必须用 **`/compatible-mode/v1`** 结尾（OpenAI 兼容模式） |
| 3 | 端点少了 `/compatible-mode/v1` | 404 | 通用：`https://dashscope.aliyuncs.com/compatible-mode/v1`；业务空间：`https://<space-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| 4 | 没开通模型 | "The model does not exist" | 「模型广场」搜 `deepseek-v4-flash` 点开通 |

---

## 3. 拿 QQ 邮箱授权码

登录你的 QQ 邮箱网页版 → **设置** → **账号与安全** → 安全设置 **「IMAP/SMTP 服务」** → 开启 → 发短信验证 → 拿 16 位授权码。关掉弹窗就看不到了，**立刻保存好**。

注意这是授权码，不是你的 QQ 密码。

---

## 4. 加 5 个 Secret

进你 Fork 的仓库 → **Settings → Secrets and variables → Actions** → 点 **New repository secret**，一个一个加：

### 用 DeepSeek 官方（默认推荐）

| Secret 名称 | 填什么 |
|-------------|--------|
| `ANTHROPIC_AUTH_TOKEN` | DeepSeek 官方 API Key（`sk-` 开头，platform.deepseek.com 创建） |
| `ANTHROPIC_BASE_URL` | `https://api.deepseek.com` |
| `ANTHROPIC_MODEL` | `deepseek-v4-flash` |
| `QQ_EMAIL` | 你的 QQ 邮箱，同时作为发件和收件邮箱 |
| `QQ_SMTP_AUTH_CODE` | QQ 邮箱授权码（16 位，不是 QQ 密码） |

### 用阿里云百炼（备选）

| Secret 名称 | 填什么 |
|-------------|--------|
| `ANTHROPIC_AUTH_TOKEN` | 百炼控制台「API Key 管理」里的 `sk-` Key |
| `ANTHROPIC_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1`（或业务空间专属端点） |
| `ANTHROPIC_MODEL` | `deepseek-v4-flash`（先在模型广场开通） |
| `QQ_EMAIL` | 你的 QQ 邮箱 |
| `QQ_SMTP_AUTH_CODE` | QQ 邮箱授权码 |

Secret 名称**一字不差**，大小写也要完全一样。

---

## 5. 手动触发收第一封邮件

进你 Fork 的仓库 → **Actions** → 左边点 **GitHub 每日盲盒** → 右边点 **Run workflow** → 绿色按钮。

等 1-2 分钟，刷新页面看圆圈有没有变绿勾。变绿了就去 QQ 邮箱收件箱查收。**没有就去垃圾邮件里找找。**

**如果红了（失败）**：点进去看日志 → 搜 `Incorrect API key` / `model does not exist` / `404` / `401` 等关键词 → 对照上面的踩坑表修正 Secret。

---

## 6. 调成你想要的

已经能收到邮件了。如果想改：

**筛选方向**：打开 `config/preferences.json`，改 `readerProfile` 字段（阅读者画像）和 `hardFilters` 数组（数据层硬过滤规则）。AI 会按你写的画像筛选项目，硬过滤规则会在送 AI 之前直接删掉明显不相关的项目（不浪费 token，结果更可控）。

**推送时间**：到 `.github/workflows/digest.yml` 里找到 cron 那行改掉。注意我每天 05:00 抓数据，GitHub Actions 有延迟，**推送必须设在 07:00 之后**。

UTC 换算：`北京时间 - 8`。想 20:00 收到就填 `0 12 * * *`，想 22:00 收到就填 `0 14 * * *`。

改完直接 GitHub 网页上点 Commit 就行。

---

## 本地开发（可选）

想在本地跑通测试：

```bash
# 1. 安装依赖
cd scripts && npm install

# 2. 复制环境变量样例并填写
cp .env.example .env
# 编辑 .env 填入你的 API Key 和邮箱授权码

# 3. 拉取一份 trending 数据（或用现有的 trending-feed.json）
# 4. 生成 digest
cat trending-feed.json | node scripts/github-digest.js > digest.txt

# 5. 发邮件
cat digest.txt | node scripts/send-email.js --to 你的QQ邮箱
```

`.env` 已在 `.gitignore` 中，不会被提交。
