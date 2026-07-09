# GitHub 每日盲盒 — 架构说明

## 这个项目是干什么的

每天自动抓取 GitHub Trending 项目，用 AI 按你的口味筛选 10 个最值得看的，生成一封 HTML 邮件推送到你的邮箱。本质是「GitHub Trending 的个性化推荐」。

---

## 两种运行模式

本项目有两条独立的运行链路，服务于不同的人群：

### 模式一：船长自己（云服务器 cron）

**这是船长实际收邮件的方式。** 跑在云服务器上，不用 GitHub Actions。

```
05:00 CST  fetch-trending.sh   抓 GitHub Trending → 缓存 + push 到 GitHub 仓库
18:00 CST  run-trending.sh     读缓存 → AI 筛选 → 发邮件
```

**为什么这么做：**
- GitHub Actions 的 cron 不准时（常有几十分钟到几小时延迟），云服务器 cron 精确到秒
- 05:00 抓全天完整数据（GitHub Trending 每天凌晨刷新），18:00 发邮件（下班时间看）
- 抓取和推送分两个 cron，中间留 13 小时缓冲，避免数据没抓到就发邮件

**数据流：**
```
GitHub Trending API
        ↓
  github-trending.js（抓取 64 个项目）
        ↓
  /var/www/github-blindbox/cache/trending-data.json（服务器缓存）
        ↓
  git push → GitHub 仓库 trending-feed.json（公开给 fork 的人）
        ↓（13 小时后）
  github-digest.js（硬过滤删 26 个 + LLM 筛选 10 个）
        ↓
  send-email.js（QQ SMTP → 船长邮箱）
```

### 模式二：别人 fork（GitHub Actions）

**这是给别人体验用的。** fork 仓库后配 5 个 Secrets，GitHub Actions 每天自动跑。

- 工作流文件：`.github/workflows/digest.yml`
- 数据源：直接从船长仓库拉 `trending-feed.json`（船长 05:00 已经 push 好了）
- fork 的人不需要自己抓数据，只需要配 API Key 和邮箱

**为什么这么做：**
- fork 的人不用部署服务器，零成本体验
- fork 的人不用写抓取脚本，直接复用船长抓好的数据
- 默认推荐 DeepSeek 官方 API（注册送免费额度，无需信用卡，最省事）
- 阿里云百炼也能用（船长自己用的），配置步骤和坑见 GUIDE.md

---

## LLM 配置策略（代码默认值 vs 实际配置）

**代码默认值（给 fork 用户）**：走 DeepSeek 官方 API，最省事
```
scripts/github-digest.js 中：
  baseUrl  默认 = https://api.deepseek.com
  model    默认 = deepseek-v4-flash
```

**船长实际配置（云服务器 .env 覆盖）**：走阿里云百炼业务空间，性能更稳
```
服务器 /var/www/github-blindbox/.env 中：
  ANTHROPIC_BASE_URL = https://llm-lovkdbdr3v8ukkup.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
  ANTHROPIC_MODEL    = deepseek-v4-flash
```

> **⚠️  如果船长要换模型或端点，直接改服务器 `.env` 即可，不用改代码。**
> 代码里的默认值是给 fork 用户用的，服务器配置优先级更高（`process.env.ANTHROPIC_BASE_URL || 默认值`）。

**请求体兼容性**：`enable_thinking: false` 是阿里云百炼 DashScope 独有参数。代码做了自动适配——只有当 baseUrl 包含 `aliyuncs.com` 或 `dashscope` 时才加这个字段，DeepSeek 官方/其他厂商端点不会带多余参数。

---

## 三层过滤架构

从 64 个 Trending 项目到最终 10 个推荐，经过三层过滤：

| 层级 | 作用 | 位置 | 删掉多少 |
|------|------|------|---------|
| 1. 多源去重聚合 | 去掉 sponsors、历史已推送过的 | `github-digest.js` main() | 0-5 个 |
| 2. 数据层硬过滤 | 删掉明显不相关的（框架/算法/K8s 等） | `github-digest.js` hardFilterRepos() | ~26 个 |
| 3. LLM 人格化筛选 | 按读者画像选 10 个最值得看的 | `github-digest.js` callLLM() | 剩余里选 10 个 |

**为什么有硬过滤：** 之前只有 LLM 软过滤（靠 prompt 告诉 AI 别选某些类型），但 AI 经常不听话，还是会推荐底层框架/算法库。硬过滤在数据层面直接删掉，不浪费 AI token，结果更可控。

---

## 配置文件

| 文件 | 作用 | 谁改 |
|------|------|------|
| `.env` | API Key + 邮箱授权码（不进 git） | 部署者自己填 |
| `.env.example` | 环境变量样例（占位符） | 进 git，给别人参考 |
| `config/preferences.json` | 读者画像 + 11 条硬过滤规则 | 部署者按自己口味改 |
| `config/config-schema.json` | preferences.json 的 JSON Schema | 结构定义，一般不动 |

---

## 目录结构（云服务器）

```
/var/www/github-blindbox/          ← 项目根（git 仓库）
├── .env                           ← 独立配置（不依赖 follow-builders）
├── .git/                          ← git 仓库，每天 fetch + reset --hard
├── config/
│   └── preferences.json           ← 读者画像 + 硬过滤规则
├── scripts/
│   ├── github-trending.js         ← 抓取 GitHub Trending（git 跟踪）
│   ├── github-digest.js           ← AI 筛选生成 digest（git 跟踪）
│   ├── send-email.js              ← QQ SMTP 发邮件（git 跟踪）
│   ├── fetch-trending.sh          ← 05:00 抓取 pipeline（untracked）
│   └── run-trending.sh            ← 18:00 发邮件 pipeline（untracked）
├── cache/
│   └── trending-data.json         ← 抓取缓存
├── trending-feed.json             ← 公开数据（push 到 GitHub）
└── node_modules/                  ← 依赖（不进 git）
```

> `fetch-trending.sh` 和 `run-trending.sh` 是服务器运维脚本，不进 git（untracked），只存在于船长的服务器上。fork 的人用 GitHub Actions，不需要这两个脚本。

---

## cron 时间表（云服务器）

| 时间 | 脚本 | 作用 |
|------|------|------|
| 05:00 CST | `fetch-trending.sh` | 抓 Trending + 缓存 + push GitHub |
| 18:00 CST | `run-trending.sh` | 生成 digest + 发邮件 |

---

## 依赖的外部服务

| 服务 | 用途 | 谁用 | 费用 |
|------|------|------|------|
| DeepSeek 官方 API | deepseek-v4-flash 模型 API | fork 用户（默认推荐）| 新用户注册送免费额度，无需信用卡 |
| 阿里云百炼（DashScope）| deepseek-v4-flash 模型 API | 船长服务器（业务空间专属端点，性能更稳）| 新用户有免费额度 |
| QQ 邮箱 SMTP | 发邮件 | 所有用户 | 免费 |
| GitHub | 仓库托管 + fork 传播 | 所有用户 | 免费 |

---

## 与 follow-builders 的关系

**完全独立，互不依赖。** 两个项目各自有自己的 .env、各自的 cron、各自的脚本目录。唯一的交集是都用同一个阿里云百炼账号和同一个 QQ 邮箱（因为是同一个人用），但配置文件物理隔离，改一个不影响另一个。
