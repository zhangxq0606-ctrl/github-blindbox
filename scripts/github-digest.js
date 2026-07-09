#!/usr/bin/env node

// ============================================================================
// GitHub 每日盲盒 — AI Digest Generator
// ============================================================================
// Reads trending repo data from stdin, uses LLM to filter & categorize,
// outputs a human-readable digest.
//
// Usage: cat trending-feed.json | node github-digest.js > digest.txt
// ============================================================================

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// 项目本地 .env（与 follow-builders 完全拆开，不再读 ~/.follow-builders/.env）
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');

// -- Parse args --------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let excludeList = [];
  let historyOutput = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude-file' && i + 1 < args.length) {
      try {
         const content = readFileSync(args[i + 1], 'utf-8');
        excludeList = JSON.parse(content);
        if (!Array.isArray(excludeList)) excludeList = [];
      } catch (err) {
        console.error(`[github-digest] Warning: could not read exclude file: ${err.message}`);
      }
      i++;
    } else if (args[i] === '--history-output' && i + 1 < args.length) {
      historyOutput = args[i + 1];
      i++;
    }
  }
  return { excludeList, historyOutput };
}

// -- Read stdin --------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) { chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Load preferences from config file ---------------------------------------

function loadPreferences() {
  const configPath = join(process.cwd(), 'config', 'preferences.json');
  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      const prefs = JSON.parse(content);
      console.error(`[github-digest] Preferences loaded from ${configPath}`);
      return prefs;
    }
  } catch (err) {
    console.error(`[github-digest] Warning: could not load preferences: ${err.message}`);
  }
  return {
    readerProfile: '独立开发者，vibecoding 实践者，Windows 用户，Claude Code + Codex 主力工具，有产品思维和运维思维，喜欢「能直接用的」「有意思的」和「有商业启发价值的」——优先选那些让你看了想「我也可以做一个」的项目，不需要底层技术/算法/框架',
    hardFilters: []
  };
}

// -- Hard filter: remove clearly irrelevant repos BEFORE sending to LLM ------

function hardFilterRepos(repos, prefs) {
  if (!prefs.hardFilters || !Array.isArray(prefs.hardFilters) || prefs.hardFilters.length === 0) {
    return { kept: repos, dropped: [] };
  }
  const dropped = [];
  const kept = repos.filter(repo => {
    for (const rule of prefs.hardFilters) {
      const fieldValue = rule.field === 'fullName'
        ? (repo.fullName || '').toLowerCase()
        : (repo.description || '').toLowerCase();
      let regex;
      try { regex = new RegExp(rule.pattern, 'i'); } catch { continue; }
      if (regex.test(fieldValue)) {
        if (rule.starsException && (repo.stars || 0) >= rule.starsException) {
          continue;
        }
        dropped.push({ repo, reason: rule.reason });
        return false;
      }
    }
    return true;
  });
  return { kept, dropped };
}

// -- Build prompt ------------------------------------------------------------

function buildPrompt(data, excludeList, prefs) {
  const rawRepos = data.repos || [];
  const excludeSet = new Set(excludeList);
  const initialCount = rawRepos.length;

  // Normalize URLs: always use https://github.com/owner/repo regardless of
  // what the API returned (some APIs return github.com/sponsors/owner etc.)
  // Then remove sponsors entries globally (both pools share this data-cleanup filter)
  const allRepos = rawRepos
    .map(r => ({ ...r, url: `https://github.com/${r.fullName}` }))
    .filter(r => r.owner !== 'sponsors');

  // 常青树池短期去重：最近 20 条推荐记录（约 2 天）不重复，避免连续撞车
  // 但 2 天前的项目可以重新进入常青树池，给经典项目二次亮相的机会
  const RECENT_WINDOW = 20;
  const recentExcludes = excludeList.length > RECENT_WINDOW
    ? excludeList.slice(-RECENT_WINDOW)
    : excludeList;
  const recentExcludeSet = new Set(recentExcludes);

  // --- Evergreen pool: 经典常青树候选池（仅排除近 2 天已推荐项目）
  const candidatesEvergreen = allRepos.filter(r => !recentExcludeSet.has(r.fullName));

  // --- Fresh pool: 今日新星候选池（和常青树同一标准，都要过历史去重）
  // 保留 freshRepos 单独变量以兼容下游统计逻辑
  const freshRepos = allRepos.filter(r => !excludeSet.has(r.fullName));

  // Compute REAL excluded count for both pools
  const evergreenCount = candidatesEvergreen.length;
  const freshCount = freshRepos.length;
  const freshExcludedByHistory = allRepos.length - freshCount;
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  // Roughly categorize recent excludes for the "yesterday diversity" hint
  const yesterdayHint = (() => {
    const recent = excludeList.slice(-12);
    if (recent.length < 3) return '';
    let toolCount = 0, aiCount = 0, creativeCount = 0, otherCount = 0;
    for (const name of recent) {
      const lower = name.toLowerCase();
      if (/(ai|llm|gpt|chat|voice|speech|tts|stable.diffusion|transl|agent|mcp|skill)/.test(lower)) {
        aiCount++;
      } else if (/(game|art|animat|fun|play|pixel|terminal|novel|font|theme|3b1b|manim|godot)/.test(lower)) {
        creativeCount++;
      } else if (/(sync|cli|export|download|scraper|exporter|pars|convert|editor|link|manager|monitor|file|note|blog|email|form|cv|resume|pdf|pocketbase)/.test(lower)) {
        toolCount++;
      } else {
        otherCount++;
      }
    }
    const parts = [];
    if (toolCount) parts.push(`效率工具 ${toolCount} 个`);
    if (aiCount) parts.push(`AI 产品 ${aiCount} 个`);
    if (creativeCount) parts.push(`创意好玩 ${creativeCount} 个`);
    if (otherCount) parts.push(`其他 ${otherCount} 个`);
    return `\n📅 昨天推送品类分布：${parts.join('、')}。今天请尽量调换口味，不要和昨天高度重复。\n`;
  })();

  // --- Build two SEPARATE candidate lists: evergreen (full pool) vs fresh (deduped)
  function formatRepo(repo) {
    return `\n## ${repo.fullName}
- 描述: ${repo.description} | 语言: ${repo.language}
- 🔥 今日新增: ${repo.starsToday}
- ⭐ 总星数: ${repo.stars}
`;
  }
  let evergreenList = '';
  for (const repo of candidatesEvergreen) evergreenList += formatRepo(repo);
  let freshList = '';
  for (const repo of freshRepos) freshList += formatRepo(repo);

  const freshNote = freshExcludedByHistory > 0
    ? `（今日原始候选 ${allRepos.length} 个，被历史去重排除 ${freshExcludedByHistory} 个，剩余新星候选 ${freshCount} 个。常青树候选仅排除近 2 天已推荐项目，共 ${evergreenCount} 个。）`
    : `（今日候选 ${allRepos.length} 个，常青树池与新星池各有 ${evergreenCount} / ${freshCount} 个。）`;

  return `今天的日期是 ${today}。以下是从 GitHub Trending 今日列表中抓取到的热门项目。
${freshNote}

你的任务是从**两个独立候选池**中分别选出对应的项目，然后生成一封邮件正文。

⚠️ 绝对禁止编造候选池里不存在的项目。推荐的项目链接必须能在下面的候选池里找到匹配的 fullName，否则说明"候选池为空，暂无可推荐"，不要捏造项目名。

## 阅读者画像（请结合此画像筛选项目）

${prefs.readerProfile}

## 排除项（除非对 vibecoding 有直接帮助）

- 翻墙/代理工具
- 纯底层技术、算法库、编程语言、Web 框架
- 纯智能体/编码代理框架（多智能体框架、coding agent SDK、agent 工具箱等）：
  → 如果卖点是「拿过来直接当你的开发工具用」——除非破 10 万星或当下极火爆，否则跳过
  → 如果卖点是「产品形态、架构设计、理念上有参考价值」——保留，用来启发产品思路
- MCP 工具、Skill 集合、提示词工程等「直接能用」的 AI 周边 → 保留

## 加权信号（同类项目内部排序用）

- ⭐ 总星数高 → 经过了市场验证（加分）
- 🔥 今日增量大 → 当前热度高（加分）
- ⏳ 连续多日出现在 trending 上 → 持续火爆，加分更多
- ✨ 新奇感 → "这个没想到"（额外加分）

${yesterdayHint}
## 邮件结构

### 第一部分：🏆 经典常青树

从下面**「常青树候选池」**中挑选 **2 个总星数高、久经考验的老牌项目**，但要注意：**不要选底层技术类**（如算法库、Web框架、编程语言等）。**仅排除近 2 天已推荐项目**——避免连续重复，但 2 天前的经典项目可以重新推荐。

将选出的 2 个项目归类到以下三类中展示（每类最多 1 个，三类不一定都出现）：
- 🛠 效率工具类：能解决具体问题的成熟工具
- 🤖 AI 产品类：AI 相关且经过市场验证的项目
- 🎨 创意/好玩类：有趣有新意且广受欢迎的项目

每个项目用 2-3 句话介绍：做什么、为什么值得了解、当前星数。

### 第二部分：🔥 今日新星

从下面**「今日新星候选池」**中筛选今日值得关注的项目。如果新星池为空（0 个），则诚实地写一段说明，不要编造，也不要从常青树池中重复拿项目。按以下品类组织展示，类型尽量不重复，**AI 产品类不超过 3 个**，给其他品类留空间：

#### 🎨 创意/好玩类（最有意思的排最前面）
不是为了有用，而是有趣、好看、有新意——游戏、艺术、新奇实验等。每段写清楚「有意思在哪」。
**数量硬约束：至少 2 个**。如果今日新星候选池里实在没有 2 个能算"创意/好玩"的项目（候选池本身不够 or 全是工具类），可以下探到常青树候选池里再挑 1 个补足，但优先从新星池里找。即使要降低单个项目的"创意浓度"也要凑足 2 个——创意/好玩是这封邮件的灵魂，不能缺席。

#### 🛠 效率工具类
开箱即用解决具体问题——文件处理、自动化、效率提升等。每段写清楚「解决了什么问题」。

#### 🤖 AI 产品类
以 AI 为核心、上手能玩的产品——AI 助手、绘图、语音、翻译等。每段写清楚「用 AI 做了什么、普通人怎么用」。

#### 📊 数据/金融类
出彩的才放进来，不硬塞。

### 数量指导
🔥 今日新星部分目标 **5-8 个项目**：
- 严格以「今日新星候选池」实际大小为上限：候选池只有 3 个就推 3 个，不要编造
- 优先保证质量，挑不到 8 个可以下探，但不要低于 5 个——除非候选池实际不足 5 个
- 如果候选池确实不够（<5 个），可以适当放宽星数门槛或选一些品类独特的项目来补齐，但必须都来自新星池
- 宁可挑 5 个真正好的，也不要为凑数塞进 8 个重复或没亮点的
- **创意/好玩类至少 2 个（硬约束）**：即使其他品类要削减也要保住创意类的 2 个名额

## 输出要求

1. 标题以 "# GitHub 每日盲盒 — ${today}" 开头
2. 开场白写一段简短介绍（1-2句话），指出今天最值得关注的一个趋势或方向
3. 每个项目用 2-4 行中文介绍，说人话——**不要技术术语**，假设读者不懂编程
4. 每个项目必须包含可点击的 Markdown 链接：**[项目名](链接地址)**，不要只写 "🔗 项目链接" 这种文字
   - ✅ 正确格式：**[Onlook](https://github.com/onlook-dev/onlook)** — AI 优先的设计工具
   - ❌ 错误格式1：**Onlook** 然后下一行写 https://github.com/onlook-dev/onlook
   - ❌ 错误格式2：[Onlook](🔗 项目链接) — 这种文字占位符无法被解析
   - 链接 URL 必须是 https://github.com/owner/repo 形式，方便自动提取用于历史去重
5. **今日新星部分每个项目必须标注今日新增星数**，格式如 `🔥 +126 星/日`，放在项目介绍末尾。常青树部分不用标。
6. 总体长度控制在 2000-4000 字
7. **经典常青树和今日新星两部分的项目不要重复**
8. 末尾附上一句 "以上由 AI 从 GitHub Trending 自动筛选生成"

---

### 常青树候选池（仅排除近 2 天已推荐项目，共 ${evergreenCount} 个，供「🏆 经典常青树」从中挑选 2 个）

${evergreenList}

### 今日新星候选池（经过历史去重，共 ${freshCount} 个，供「🔥 今日新星」从中挑选，严禁编造超出此池的项目）

${freshList.length > 0 ? freshList : '（今日新星候选池为空——所有项目均已在近期推送过。这一部分请直接写一段诚实的说明文字，不要编造项目，也不要复用常青树池的项目。）'}

---

请开始生成。`;
}

// -- Call LLM (OpenAI-compatible) --------------------------------------------

async function callLLM(systemPrompt) {
  loadEnv({ path: ENV_PATH });

  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_AUTH_TOKEN. 请在项目根目录 .env 文件或 GitHub Actions Secrets 中配置。');
  }

  // 默认走 DeepSeek 官方 API（fork 用户省事）；船长自己在服务器 .env 里配阿里云百炼业务空间端点覆盖
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';

  const url = `${baseUrl}/chat/completions`;

  // 请求体：enable_thinking 是阿里云百炼 DashScope 独有参数，只有走阿里云端点才加
  // 思考模式打开后，思考过程会消耗 token，max_tokens 需要相应提高
  // DeepSeek 官方端点没有这个参数，按官方默认行为（不显式禁用也不显式启用）
  const reqBody = {
    model: model,
    max_tokens: 16384,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请生成今天的 GitHub Trending 精选。' }
    ]
  };
  const isAliyunDashScope = /aliyuncs\.com|dashscope/.test(baseUrl);
  if (isAliyunDashScope) {
    // 思考模式打开：让模型在生成前先思考候选项目的匹配度，提高筛选质量
    // 思考过程单独走 reasoning_content 字段，最终回答仍走 content，下游解析不变
    reqBody.enable_thinking = true;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(reqBody)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error (${response.status}): ${errBody}`);
  }

  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const rawInput = await readStdin();

  if (!rawInput || !rawInput.trim()) {
    console.error('[github-digest] Error: 输入数据为空，可能原始数据文件不存在或拉取失败');
    console.log('# GitHub 每日盲盒\n\n今天数据暂未就绪，请稍后再试。');
    return;
  }

  let data;
  try {
    data = JSON.parse(rawInput);
  } catch (err) {
    console.error(`[github-digest] Error: 输入数据不是有效的 JSON (${err.message})`);
    console.error('[github-digest] 收到的内容前200字符:', rawInput.substring(0, 200));
    console.log('# GitHub 每日盲盒\n\n今天数据格式异常，请检查 trending-feed.json 是否完整。');
    return;
  }

  if (data.status === 'error') {
    console.error('Trending fetch failed:', data.message);
    process.exit(1);
  }

  const repos = data.repos || [];
  if (repos.length === 0) {
    console.log('# GitHub 每日盲盒\n\n今天未能获取到 Trending 数据，请稍后再试。');
    return;
  }

  // Compute REAL excluded count BEFORE calling buildPrompt (for accurate logging)
  {
    const excludeSet = new Set(args.excludeList);
    const afterClean = repos.filter(r => r.owner !== 'sponsors');
    const actualExcludedByHistory = afterClean.filter(r => excludeSet.has(r.fullName)).length;
    const afterSponsorsFiltered = repos.length - afterClean.length;
    console.error(`[github-digest] Input ${repos.length} repos → after sponsors-filter ${afterClean.length} → after history-dedup ${afterClean.length - actualExcludedByHistory} (actually excluded ${actualExcludedByHistory} by history, ${afterSponsorsFiltered} by dirty sponsors). History pool size: ${args.excludeList.length}`);
  }

  // --- Hard filter: remove clearly irrelevant repos BEFORE sending to LLM ---
  const prefs = loadPreferences();
  const cleanedRepos = repos.filter(r => r.owner !== 'sponsors');
  const { kept, dropped } = hardFilterRepos(cleanedRepos, prefs);
  if (dropped.length > 0) {
    console.error(`[github-digest] Hard filter removed ${dropped.length} repos:`);
    for (const d of dropped) {
      console.error(`  ✗ ${d.repo.fullName} — ${d.reason}`);
    }
  }
  console.error(`[github-digest] After hard filter: ${kept.length} repos remaining (was ${cleanedRepos.length})`);
  data.repos = kept;

  try {
    const systemPrompt = buildPrompt(data, args.excludeList, prefs);
    const digest = await callLLM(systemPrompt);
    console.log(digest);
    console.error('[github-digest] Digest generated successfully');

    if (args.historyOutput) {
      const selectedNames = [];

      // 格式1：标准 Markdown 链接 [text](https://github.com/owner/repo)
      const linkRegex = /\[([^\]]+)\]\(https:\/\/github\.com\/([^/]+\/[^/)\s]+)\)/g;
      let match;
      while ((match = linkRegex.exec(digest)) !== null) {
        selectedNames.push(match[2]);
      }

      // 格式2：方括号包裹的 fullName [owner/repo]
      const bareRegex = /\[([^\]]+\/[^\]]+)\]/g;
      while ((match = bareRegex.exec(digest)) !== null) {
        const name = match[1].trim();
        if (!selectedNames.includes(name)) {
          selectedNames.push(name);
        }
      }

      // 格式3：裸 URL（思考模式下 LLM 倾向于 **项目名** + 换行 + https://github.com/owner/repo）
      // 兜底解析，确保即使 LLM 不按 Markdown 链接格式输出也能拿到 fullName
      const bareUrlRegex = /https:\/\/github\.com\/([^\s/]+\/[^\s/)\]]+)/g;
      while ((match = bareUrlRegex.exec(digest)) !== null) {
        let name = match[1].replace(/\/$/, '').trim();
        // 去掉可能的锚点或查询参数残留
        name = name.split(/[?#]/)[0];
        if (!selectedNames.includes(name)) {
          selectedNames.push(name);
        }
      }

      // Filter sponsors/xxx dirty entries + any malformed entries before saving
      const unique = [...new Set(selectedNames)]
        .filter(name => typeof name === 'string' && name.trim() !== '')
        .filter(name => !name.startsWith('sponsors/'))
        .filter(name => /^[^\s/]+\/[^\s/]+$/.test(name));  // must be owner/repo pattern

      writeFileSync(args.historyOutput, JSON.stringify(unique, null, 2));
      console.error(`[github-digest] History saved: ${unique.length} projects (sponsors/ malformed entries filtered out)`);
    }
  } catch (err) {
    console.error(`[github-digest] Error: ${err.message}`);
    process.exit(1);
  }
}

main();