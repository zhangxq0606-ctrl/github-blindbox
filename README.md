# GitHub 每日盲盒

每天 AI 自动从 GitHub Trending 筛选**真正值得关注的项目**，按「创意好玩 / 效率工具 / AI 应用」三类整理好，发到你邮箱。

**不需要任何服务器。** Fork 仓库，配 1 个 LLM API Key + 1 个邮箱授权码，就能每天收邮件。

---

## 它和别的 Trending 产品有什么不同？

其他 GitHub Trending 产品做的事本质上就是：**把热门 repo 列出来给你看**，筛选全靠自己。

**这个项目做了四层过滤：**

**① 多语言聚合抓取 → 建立候选池**
7 个语言维度（全语言、Python、JavaScript、TypeScript、Go、Rust、Java）并行抓取，去重后得到 50-80 个候选项目。

**② 数据层硬过滤 → 物理删除不相关类别**
12 条正则规则，翻墙、K8s、算法库、Web 框架、编程语言等类别在送 AI 之前直接删掉，不浪费 token。

**③ 双池历史去重 → 避免信息疲劳**
- 常青树池：经典老项目短期去重，2 天后可重新推荐
- 新星池：已推荐项目永久排除，保证每天新鲜

**④ 人格化 AI 筛选 → 按你的口味来**
AI 按你设定的读者画像筛选项目。创意/好玩类**至少 2 个（硬约束）**，AI 产品类**不超过 3 个（品类配额）**。

---

## 快速开始

### 1. Fork 仓库

打开 [github.com/zhangxq0606-ctrl/github-blindbox](https://github.com/zhangxq0606-ctrl/github-blindbox)，点右上角 **Fork**，选你自己账号。

### 2. 拿 DeepSeek API Key（推荐）

1. 打开 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)，注册/登录（无需信用卡）
2. 点 **API Keys** → **Create new API Key** → 填个名字 → **Create**
3. 复制 `sk-` 开头的 Key（**只显示一次，立刻保存好**）

新用户注册送免费额度，够用好几个月。

> 备选：阿里云百炼也行，去 [bailian.console.aliyun.com](https://bailian.console.aliyun.com/) → 模型广场开通 `deepseek-v4-flash` → API Key 管理创建 Key。注意用的是百炼的 `sk-` Key，不是阿里云主账号的 AK/SK。

### 3. 拿 QQ 邮箱授权码

登录 QQ 邮箱网页版 → **设置** → **账号与安全** → 安全设置 **「IMAP/SMTP 服务」** → 开启 → 发短信验证 → 拿 16 位授权码。

这是授权码，不是你的 QQ 密码。

### 4. 配置 5 个 Secrets

进你 Fork 的仓库 → **Settings → Secrets and variables → Actions** → **New repository secret**，一个一个加：

| Secret 名称 | 填什么 |
|-------------|--------|
| `ANTHROPIC_AUTH_TOKEN` | DeepSeek API Key（`sk-` 开头） |
| `ANTHROPIC_BASE_URL` | `https://api.deepseek.com` |
| `ANTHROPIC_MODEL` | `deepseek-v4-flash` |
| `QQ_EMAIL` | 你的 QQ 邮箱（发件和收件都用这个） |
| `QQ_SMTP_AUTH_CODE` | QQ 邮箱授权码（16 位） |

Secret 名称**一字不差**，大小写也要完全一样。

### 5. 手动触发收第一封邮件

进你 Fork 的仓库 → **Actions** → 左边 **GitHub 每日盲盒** → 右边 **Run workflow** → 绿色按钮。

等 1-2 分钟，变绿勾就去 QQ 邮箱收件箱查收。**没有就去垃圾邮件里找找。**

如果红了：点进去看日志，搜 `401` / `404` / `model not found` 等关键词排查。

---

## 定制你的筛选口味

打开 `config/preferences.json`，改两个字段：

- `readerProfile`：写你自己的画像，AI 据此筛选项目
- `hardFilters`：在送 AI 之前直接删掉明显不相关的项目

想扩大范围就写松一点，想精准命中就写细一点。**这是你的项目，怎么筛你说了算。**

---

## 数据流

```
每天 05:00 抓取 GitHub Trending
    ↓
push 到 GitHub（公开数据源）
    ↓
你的 Fork → Actions 拉数据 → AI 筛选 → 发邮件到你的邮箱
```

数据抓取由项目维护者负责，fork 用户只需配 API Key 和邮箱。全部跑在 GitHub Actions 上，零成本。

---

## 本地开发（可选）

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量并填写
# Windows: copy .env.example .env
# macOS/Linux: cp .env.example .env
# 编辑 .env 填入你的 API Key 和邮箱授权码

# 3. 生成 digest
cat trending-feed.json | node scripts/github-digest.js > digest.txt

# 4. 发邮件
cat digest.txt | node scripts/send-email.js --to 你的QQ邮箱
```

`.env` 已在 `.gitignore` 中，不会被提交。