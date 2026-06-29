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
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

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

// -- Build prompt ------------------------------------------------------------

function buildPrompt(data, excludeList) {
  let repos = data.repos || [];

  // Remove previously sent projects
  const excludeSet = new Set(excludeList);
  const beforeCount = repos.length;
  repos = repos.filter(r => !excludeSet.has(r.fullName));
  const afterCount = repos.length;
  const excludedCount = beforeCount - afterCount;
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  // Normalize URLs: always use https://github.com/owner/repo regardless of
  // what the API returned (some APIs return github.com/sponsors/owner etc.)
  repos = repos.map(r => ({ ...r, url: `https://github.com/${r.fullName}` }));

  let repoList = '';
  for (const repo of repos) {
    repoList += `\n## ${repo.fullName}
- 描述: ${repo.description}
- 语言: ${repo.language}
- 总星数: ${repo.stars}
- 今日新增: ${repo.starsToday}
- Fork: ${repo.forks}
- 链接: ${repo.url}
`;
  }

  return `今天的日期是 ${today}。以下是从 GitHub Trending 今日列表中抓取到的热门项目。
${excludedCount > 0 ? `\n注意：今天原始数据共 ${beforeCount} 个项目，其中 ${excludedCount} 个已经在前几天推送过，已自动排除，剩余 ${afterCount} 个待筛选。` : ''}

你的任务是从这些项目中筛选出**真正值得关注**的，然后按以下结构生成一封邮件正文。

## 阅读者画像（请结合此画像筛选项目）

- 独立开发者，vibecoding 实践者
- 有产品思维和运维思维
- 追求实用、有创意的产品
- 不需要底层技术、算法、框架等纯开发内容
- 喜欢「能直接用的」和「有意思的」

## 邮件结构

### 第一部分：🏆 经典常青树

从原始数据中挑选 **2 个总星数高、久经考验的老牌项目**，但要注意：**不要选底层技术类**（如算法库、Web框架、编程语言等）。

将选出的 2 个项目归类到以下三类中展示（每类最多 1 个，三类不一定都出现）：
- 🛠 工具类：能解决具体问题的成熟工具
- 🤖 AI 应用类：AI 相关且经过市场验证的项目
- 🎨 创意/好玩类：有趣有新意且广受欢迎的项目

每个项目用 2-3 句话介绍：做什么、为什么值得了解、当前星数。

### 第二部分：🔥 今日新星

筛选今日值得关注的新星项目。参考标准：
- 综合判断星数和今日增量
- 50 星以下大概率是噪音，可以跳过
- 同一个开发者/组织的多个项目，只选最突出的那个
- **结合阅读者画像**选择——优先选实用工具、AI 应用、有创意好玩的，跳过底层技术/算法/框架

将筛选出的项目按以下**顺序**展示：

#### 🎨 创意/好玩类（排最前面，2-3 个）
不是为了有用，而是有趣、好看、有新意——游戏、艺术、新奇实验等。每段写清楚「有意思在哪」。

#### 🛠 工具类（2-3 个）
能直接用的东西——文件处理、自动化、效率提升、开发工具等。每段写清楚「解决了什么问题」。

#### 🤖 AI 应用类（2-3 个）
跟大模型相关的——AI 助手、绘图、语音、翻译等。每段写清楚「用 AI 做了什么、普通人怎么用」。

**每个类别必须选出 2-3 个项目，不要跳过任何类别。**

## 输出要求

1. 标题以 "# GitHub 每日盲盒 — ${today}" 开头
2. 开场白写一段简短介绍（1-2句话），指出今天最值得关注的一个趋势或方向
3. 每个项目用 2-4 行中文介绍，说人话——**不要技术术语**，假设读者不懂编程
4. 每个项目必须包含可点击的 Markdown 链接：**[项目名](链接地址)**，不要只写 "🔗 项目链接" 这种文字
5. 总体长度控制在 2000-4000 字
6. **经典常青树和今日新星两部分的项目不要重复**
7. 末尾附上一句 "以上由 AI 从 GitHub Trending 自动筛选生成"

## 原始数据

${repoList}

请开始生成。`;
}

// -- Call LLM (OpenAI-compatible) --------------------------------------------

async function callLLM(systemPrompt) {
  loadEnv({ path: join(homedir(), '.follow-builders', '.env') });

  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_AUTH_TOKEN. 请在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加这个 Secret。');
  }

  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';

  const url = `${baseUrl}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请生成今天的 GitHub Trending 精选。' }
      ]
    })
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

  console.error(`[github-digest] Processing ${repos.length} repos (${args.excludeList.length} excluded from history)...`);

  try {
    const systemPrompt = buildPrompt(data, args.excludeList);
    const digest = await callLLM(systemPrompt);
    console.log(digest);
    console.error('[github-digest] Digest generated successfully');

    if (args.historyOutput) {
      const selectedNames = [];

      const linkRegex = /\[([^\]]+)\]\(https:\/\/github\.com\/([^/]+\/[^/)\s]+)\)/g;
      let match;
      while ((match = linkRegex.exec(digest)) !== null) {
        selectedNames.push(match[2]);
      }

      const bareRegex = /\[([^\]]+\/[^\]]+)\]/g;
      while ((match = bareRegex.exec(digest)) !== null) {
        const name = match[1].trim();
        if (!selectedNames.includes(name)) {
          selectedNames.push(name);
        }
      }

      const unique = [...new Set(selectedNames)];
      writeFileSync(args.historyOutput, JSON.stringify(unique, null, 2));
      console.error(`[github-digest] History saved: ${unique.length} projects`);
    }
  } catch (err) {
    console.error(`[github-digest] Error: ${err.message}`);
    process.exit(1);
  }
}

main();