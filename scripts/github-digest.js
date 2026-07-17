#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const FRESH_COOLDOWN_DAYS = 7;
const EVERGREEN_COOLDOWN_DAYS = 14;
const MAX_POOL_GENERATION_ATTEMPTS = 2;
const MAX_LENGTH_REWRITE_ATTEMPTS = 1;
const MIN_DIGEST_BYTES = 4000;
const MIN_TOTAL_RECOMMENDATIONS = 4;
const MAX_TOTAL_RECOMMENDATIONS = 6;
const MIN_EVERGREEN_POOL = 12;
const FRESH_SHORTLIST_LIMIT = 60;
const EVERGREEN_SHORTLIST_LIMIT = 30;

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { excludeList: [], historyOutput: null, historyStateFile: null, historyStateOutput: null, dataAgeHours: null };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--exclude-file' && args[index + 1]) {
      try {
        const history = JSON.parse(readFileSync(args[index + 1], 'utf8'));
        parsed.excludeList = Array.isArray(history) ? history.filter(name => typeof name === 'string') : [];
      } catch (error) {
        console.error(`[github-digest] Warning: could not read exclude file: ${error.message}`);
      }
      index++;
    } else if (args[index] === '--history-output' && args[index + 1]) {
      parsed.historyOutput = args[++index];
    } else if (args[index] === '--history-state-file' && args[index + 1]) {
      parsed.historyStateFile = args[++index];
    } else if (args[index] === '--history-state-output' && args[index + 1]) {
      parsed.historyStateOutput = args[++index];
    } else if (args[index] === '--data-age-hours' && args[index + 1]) {
      const value = Number(args[++index]);
      if (Number.isFinite(value) && value >= 0) parsed.dataAgeHours = Math.floor(value);
    }
  }
  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function loadPreferences() {
  const configPath = join(PROJECT_ROOT, 'config', 'preferences.json');
  try {
    const preferences = JSON.parse(readFileSync(configPath, 'utf8'));
    console.error(`[github-digest] Preferences loaded from ${configPath}`);
    return preferences;
  } catch (error) {
    console.error(`[github-digest] Warning: could not load preferences: ${error.message}`);
    return { readerProfile: '独立开发者，vibecoding 实践者，偏好有产品启发且可直接使用的项目。', hardFilters: [] };
  }
}

function hardFilterRepos(repos, preferences) {
  const dropped = [];
  const kept = repos.filter(repo => {
    for (const rule of preferences.hardFilters || []) {
      const field = rule.field === 'fullName' ? repo.fullName || '' : repo.description || '';
      let pattern;
      try { pattern = new RegExp(rule.pattern, 'i'); } catch { continue; }
      if (pattern.test(field) && !(rule.starsException && repo.stars >= rule.starsException)) {
        dropped.push({ repo, reason: rule.reason });
        return false;
      }
    }
    return true;
  });
  return { kept, dropped };
}

function loadHistoryState(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const state = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(state.entries)) throw new Error('entries must be an array');
    return state;
  } catch (error) {
    console.error(`[github-digest] Warning: could not read history state: ${error.message}`);
    return null;
  }
}

function namesInCooldown(entries, days, now) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return new Set(entries
    .filter(entry => typeof entry.fullName === 'string' && Number.isFinite(Date.parse(entry.sentAt)) && Date.parse(entry.sentAt) >= cutoff)
    .map(entry => entry.fullName));
}

function legacyNames(state, key, now) {
  const legacy = state?.legacy;
  const expiresAt = legacy?.[`${key}ExpiresAt`];
  if (!Array.isArray(legacy?.[key]) || !Number.isFinite(Date.parse(expiresAt))) return new Set();
  if (Date.parse(expiresAt) > now) return new Set(legacy[key]);
  // 安全网：legacy 过期后，如果 state entries 不足 20 条，继续用 legacy 保护
  // 避免 state 积累不够时冷却失效导致重复推送
  const stateEntryCount = (state?.entries || []).length;
  if (stateEntryCount < 20) {
    console.error(`[github-digest] Legacy ${key} expired but state has only ${stateEntryCount} entries (<20), extending legacy protection`);
    return new Set(legacy[key]);
  }
  return new Set();
}

function normalizePeriods(repo) {
  if (Array.isArray(repo.periods) && repo.periods.length > 0) return repo.periods;
  const source = String(repo.source || '');
  const periods = ['daily', 'weekly', 'monthly'].filter(period => source.includes(period));
  return periods.length > 0 ? periods : ['weekly'];
}

// 热度单位映射：starsToday 的增量周期跟 primaryPeriod 对齐
const GROWTH_UNIT = { daily: '星/日', weekly: '星/周', monthly: '星/月' };

function resolvePrimaryPeriod(repo) {
  if (repo.primaryPeriod) return repo.primaryPeriod;
  // 旧数据兜底：从 periods 取最短周期
  if (Array.isArray(repo.periods)) {
    if (repo.periods.includes('daily')) return 'daily';
    if (repo.periods.includes('weekly')) return 'weekly';
    if (repo.periods.includes('monthly')) return 'monthly';
  }
  return 'weekly';
}

function takeFreshDiverse(repos, limit) {
  const groups = new Map();
  for (const repo of repos) {
    const language = repo.language || 'Unknown';
    if (!groups.has(language)) groups.set(language, []);
    groups.get(language).push(repo);
  }
  for (const group of groups.values()) group.sort((a, b) => b.starsToday - a.starsToday || b.stars - a.stars);

  const selected = [];
  while (selected.length < limit) {
    const activeGroups = [...groups.values()]
      .filter(group => group.length > 0)
      .sort((a, b) => b[0].starsToday - a[0].starsToday || b[0].stars - a[0].stars);
    if (activeGroups.length === 0) break;
    for (const group of activeGroups) {
      if (selected.length >= limit) break;
      selected.push(group.shift());
    }
  }
  return selected;
}

function buildShortlists(repos) {
  const normalized = repos.map(repo => ({ ...repo, periods: normalizePeriods(repo) }));
  const freshCandidates = normalized.filter(repo => repo.periods.some(period => period === 'daily' || period === 'weekly'));
  const monthlyCandidates = normalized.filter(repo => repo.periods.includes('monthly'));
  const weeklyCandidates = normalized.filter(repo => repo.periods.includes('weekly'));
  const fresh = takeFreshDiverse(freshCandidates, FRESH_SHORTLIST_LIMIT);
  const monthly = [...monthlyCandidates]
    .sort((a, b) => b.stars - a.stars || b.starsToday - a.starsToday)
    .slice(0, EVERGREEN_SHORTLIST_LIMIT);
  const weeklyFallback = [...weeklyCandidates]
    .sort((a, b) => b.stars - a.stars || b.starsToday - a.starsToday)
    .slice(0, EVERGREEN_SHORTLIST_LIMIT);
  return {
    freshNames: new Set(fresh.map(repo => repo.fullName)),
    monthlyNames: new Set(monthly.map(repo => repo.fullName)),
    weeklyFallbackNames: new Set(weeklyFallback.map(repo => repo.fullName)),
    counts: { fresh: fresh.length, monthly: monthly.length, weeklyFallback: weeklyFallback.length }
  };
}

function buildPools(repos, excludeList, historyState, now, shortlists) {
  const entries = historyState?.entries || [];
  const freshBlocked = namesInCooldown(entries, FRESH_COOLDOWN_DAYS, now);
  const evergreenBlocked = namesInCooldown(entries, EVERGREEN_COOLDOWN_DAYS, now);
  if (historyState) {
    for (const name of legacyNames(historyState, 'freshNames', now)) freshBlocked.add(name);
    for (const name of legacyNames(historyState, 'evergreenNames', now)) evergreenBlocked.add(name);
  } else {
    for (const name of excludeList) freshBlocked.add(name);
    for (const name of excludeList) evergreenBlocked.add(name);
    console.error('[github-digest] History state missing: conservatively blocking all legacy history during first-run migration');
  }
  const normalized = repos
    .filter(repo => repo.owner !== 'sponsors' && repo.fullName)
    .map(repo => ({ ...repo, url: `https://github.com/${repo.fullName}`, periods: normalizePeriods(repo) }));
  const fresh = normalized.filter(repo => shortlists.freshNames.has(repo.fullName) && !freshBlocked.has(repo.fullName));
  const monthlyEvergreen = normalized.filter(repo => shortlists.monthlyNames.has(repo.fullName) && !evergreenBlocked.has(repo.fullName));
  const monthlyNames = new Set(monthlyEvergreen.map(repo => repo.fullName));
  const weeklyFallback = monthlyEvergreen.length < MIN_EVERGREEN_POOL
    ? normalized
      .filter(repo => shortlists.weeklyFallbackNames.has(repo.fullName) && !evergreenBlocked.has(repo.fullName) && !monthlyNames.has(repo.fullName))
      .sort((a, b) => b.stars - a.stars || b.starsToday - a.starsToday)
      .slice(0, MIN_EVERGREEN_POOL - monthlyEvergreen.length)
    : [];
  return {
    fresh,
    evergreen: [...monthlyEvergreen, ...weeklyFallback],
    monthlyEvergreenCount: monthlyEvergreen.length,
    weeklyFallbackCount: weeklyFallback.length,
    freshBlocked: freshBlocked.size,
    evergreenBlocked: evergreenBlocked.size
  };
}

function formatCandidates(repos) {
  return repos.map(repo => {
    const unit = GROWTH_UNIT[resolvePrimaryPeriod(repo)] || '星/周';
    const rawGrowth = repo.starsToday || 0;
    const safeGrowth = rawGrowth > (repo.stars || 0) * 0.8 ? 0 : rawGrowth;
    return [
      `项目：${repo.fullName}`,
      `描述：${repo.description || '（暂无描述）'}`,
      `语言：${repo.language || 'Unknown'}｜热度：+${safeGrowth} ${unit}｜总星数：${repo.stars || 0}`
    ].join('\n');
  }).join('\n\n');
}

function buildSelectionPrompt(kind, repos, preferences, attempt, count) {
  const isFresh = kind === 'fresh';
  const title = isFresh ? '今日新星' : '经典常青树';
  const specialRule = isFresh
    ? '每个项目末尾必须写「🔥 +数字 单位」热度标记，单位必须与候选池中该项目标注的「星/日」「星/周」「星/月」完全一致；优先产品灵感、AI 工具链、开发效率和有趣的新奇项目；避免同主题项目扎堆，尽量让选中的项目覆盖不同方向（如工具/AI/创意/数据/效率）。'
    : '优先经市场验证、仍值得独立开发者研究的成熟产品；不要选底层技术、框架或企业基础设施；每个项目末尾必须写「🔥 +数字 单位」热度标记，单位必须与候选池标注一致；避免与今日新星同主题扎堆。';
  return `你是 GitHub 每日盲盒的编辑。请仅从下面的「${title}候选池」挑选恰好 ${count} 个项目。

阅读者画像：
${preferences.readerProfile}

严格规则：
1. 只能选候选池中列出的 fullName，不能编造、不能引用候选池之外的项目。
2. 先输出一段开场文字（仅「今日新星」需要），然后按品类分组输出 ${count} 个项目块。同品类的项目必须连续排列在一起。不要输出其他标题、候选池说明、思考过程或道歉。
3. 品类分组标题格式：### ⚡ 品类名。每个品类标题下可以有 1-多个项目。品类表：
   ⚡ AI模型 — 推理框架/量化/训练工具
   🤖 AI Agent — 代理框架/编排/工作流
   🛠 开发工具 — 编译器/IDE/测试/CI
   🔧 效率工具 — 自动化/脚本/API工具
   🎨 创意好玩 — 有趣/创意/可视化
   📊 数据金融 — 数据分析/量化/爬虫
4. 每个项目块格式：
   **[owner/repo](https://github.com/owner/repo)** · ⭐ 总星数 · 📈 +数字 单位
   然后用三个独立段落介绍，每段一句完整中文，约 70-100 个汉字，分别说明：它是什么、核心价值、对独立开发者的启发。每个项目末尾写「🔥 +数字 单位」热度标记，单位必须与候选池标注一致。
5. ${specialRule}
6. 不得出现「没有好项目」「候选不足」「无法推荐」等拒绝语。第 ${attempt} 次生成必须严格遵守上述格式。

${title}候选池：
${formatCandidates(repos)}`;
}

async function callLLM(systemPrompt) {
  loadEnv({ path: ENV_PATH });
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) throw new Error('Missing ANTHROPIC_AUTH_TOKEN. 请在项目根目录 .env 文件或 GitHub Actions Secrets 中配置。');
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';
  const requestBody = {
    model,
    max_tokens: 16384,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请生成符合全部格式要求的项目内容。' }
    ]
  };
  if (/aliyuncs\.com|dashscope/.test(baseUrl)) requestBody.enable_thinking = true;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) throw new Error(`API error (${response.status}): ${await response.text()}`);
  const result = await response.json();
  return result.choices?.[0]?.message?.content?.trim() || '';
}

function extractProjectNames(text) {
  const names = [];
  const linkPattern = /\[[^\]]+\]\(https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(text)) !== null) names.push(match[1].replace(/\/$/, '').split(/[?#]/)[0]);
  return names;
}

function validateSelection(text, allowedNames, expectedCount) {
  const names = extractProjectNames(text);
  const unique = [...new Set(names)];
  if (!text || /没有好项目|候选不足|无法推荐/.test(text)) return { valid: false, reason: 'contains refusal text' };
  if (names.length !== expectedCount || unique.length !== expectedCount) return { valid: false, reason: `expected ${expectedCount} unique links, got ${names.length}/${unique.length}` };
  const invalid = unique.filter(name => !allowedNames.has(name));
  if (invalid.length > 0) return { valid: false, reason: `projects outside pool: ${invalid.join(', ')}` };
  return { valid: true, names: unique };
}

async function generateSelection(kind, repos, preferences, expectedCount) {
  if (expectedCount === 0) return { text: '', names: [] };
  if (repos.length < expectedCount) throw new Error(`${kind} pool has only ${repos.length} candidates, fewer than required ${expectedCount}`);
  const allowedNames = new Set(repos.map(repo => repo.fullName));
  for (let attempt = 1; attempt <= MAX_POOL_GENERATION_ATTEMPTS; attempt++) {
    const text = await callLLM(buildSelectionPrompt(kind, repos, preferences, attempt, expectedCount));
    const validation = validateSelection(text, allowedNames, expectedCount);
    if (validation.valid) return { text, names: validation.names };
    console.error(`[github-digest] ${kind} generation attempt ${attempt} rejected: ${validation.reason}`);
  }
  throw new Error(`${kind} generation failed validation after ${MAX_POOL_GENERATION_ATTEMPTS} attempts`);
}

async function rewriteSelection(kind, selection, expectedCount) {
  if (expectedCount === 0) return selection;
  const allowedNames = new Set(selection.names);
  const title = kind === 'fresh' ? '今日新星' : '经典常青树';
  const prompt = `请扩写下面的「${title}」内容以提高邮件篇幅。严格保留原有 ${expectedCount} 个 Markdown 链接和品类分组标题（### ⚡ 品类名），不得新增、删除或替换项目链接，不得改变品类分组顺序。不要输出思考过程或候选池说明。每个项目仍用三个独立段落，每段为一句约 110-140 个汉字的完整中文，保留元信息行（⭐ 总星数 · 📈 +数字 单位）和末尾的🔥热度标记。\n\n原内容：\n${selection.text}`;
  for (let attempt = 1; attempt <= MAX_LENGTH_REWRITE_ATTEMPTS; attempt++) {
    const text = await callLLM(prompt);
    const validation = validateSelection(text, allowedNames, expectedCount);
    if (validation.valid) return { text, names: validation.names };
    console.error(`[github-digest] ${kind} length rewrite rejected: ${validation.reason}`);
  }
  return selection;
}

function calculateTargets(freshAvailable, evergreenAvailable) {
  const freshTarget = Math.min(4, freshAvailable);
  const desiredEvergreen = freshTarget >= 4
    ? 2
    : Math.max(2, MIN_TOTAL_RECOMMENDATIONS - freshTarget);
  const evergreenTarget = Math.min(desiredEvergreen, evergreenAvailable);
  if (freshTarget + evergreenTarget < MIN_TOTAL_RECOMMENDATIONS) {
    throw new Error(`Candidate pools cannot meet ${MIN_TOTAL_RECOMMENDATIONS} recommendations: fresh=${freshAvailable}, evergreen=${evergreenAvailable}`);
  }
  return { freshTarget, evergreenTarget };
}

function composeDigest(today, fresh, evergreen, freshTarget, dataAgeHours) {
  const fallbackHeading = freshTarget < 4 ? '🏆 经典常青树补充' : '🏆 经典常青树';
  const freshSection = freshTarget > 0
    ? `## 🔥 今日新星\n\n${fresh.text}\n`
    : '## 📦 本期说明\n\n今日新星候选在 hardFilter 与 7 天冷却后不足，本期仅由经典项目补充推荐。\n';
  const evergreenSection = evergreen.text ? `\n## ${fallbackHeading}\n\n${evergreen.text}\n` : '';
  const ageNotice = dataAgeHours !== null && dataAgeHours >= 24 ? `⚠️ 数据非当日，源自 ${dataAgeHours} 小时前。\n\n` : '';
  return `# GitHub 每日盲盒 — ${today}\n\n${ageNotice}今天按数据新鲜度和独立冷却策略分开筛选：今日新星只来自 daily／weekly 候选；常青树优先来自 monthly，数量不足时才补充高星 weekly 候选。\n\n${freshSection}${evergreenSection}\n以上由 AI 从 GitHub Trending 自动筛选生成\n`;
}

function writeHistoryOutputs(args, selected) {
  function atomicWriteJson(filePath, value) {
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(value, null, 2));
    renameSync(tempPath, filePath);
  }
  if (args.historyOutput) {
    atomicWriteJson(args.historyOutput, selected.map(item => item.fullName));
    console.error(`[github-digest] History saved: ${selected.length} project names`);
  }
  if (args.historyStateOutput) {
    const sentAt = new Date().toISOString();
    const entries = selected.map(item => ({ fullName: item.fullName, pool: item.pool, sentAt }));
    atomicWriteJson(args.historyStateOutput, { version: 1, entries });
    console.error(`[github-digest] History state saved: ${entries.length} timestamped entries`);
  }
}

async function main() {
  const args = parseArgs();
  const rawInput = await readStdin();
  if (!rawInput.trim()) throw new Error('输入数据为空，可能原始数据文件不存在或拉取失败');
  let data;
  try { data = JSON.parse(rawInput); } catch (error) { throw new Error(`输入数据不是有效 JSON: ${error.message}`); }
  if (data.status === 'error') throw new Error(`Trending fetch failed: ${data.message}`);
  if (!Array.isArray(data.repos) || data.repos.length === 0) throw new Error('Trending 数据没有项目');

  const preferences = loadPreferences();
  const { kept, dropped } = hardFilterRepos(data.repos.filter(repo => repo.owner !== 'sponsors'), preferences);
  console.error(`[github-digest] Input ${data.repos.length} repos → hard filter kept ${kept.length}, removed ${dropped.length}`);
  for (const item of dropped) console.error(`  ✗ ${item.repo.fullName} — ${item.reason}`);
  const shortlists = buildShortlists(kept);
  console.error(`[github-digest] Shortlists: fresh=${shortlists.counts.fresh}/${FRESH_SHORTLIST_LIMIT}, evergreen monthly=${shortlists.counts.monthly}/${EVERGREEN_SHORTLIST_LIMIT}, weekly fallback=${shortlists.counts.weeklyFallback}/${EVERGREEN_SHORTLIST_LIMIT}`);
  const historyState = loadHistoryState(args.historyStateFile);
  const pools = buildPools(kept, args.excludeList, historyState, Date.now(), shortlists);
  console.error(`[github-digest] Pools: fresh=${pools.fresh.length} (blocked=${pools.freshBlocked}, target ≥20); evergreen=${pools.evergreen.length} (monthly=${pools.monthlyEvergreenCount}, weekly fallback=${pools.weeklyFallbackCount}, blocked=${pools.evergreenBlocked})`);
  if (pools.fresh.length < 20) console.error(`[github-digest] Warning: fresh pool below acceptance target (${pools.fresh.length}/20)`);

  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const initialTargets = calculateTargets(pools.fresh.length, pools.evergreen.length);
  let fresh = await generateSelection('fresh', pools.fresh, preferences, initialTargets.freshTarget);
  const evergreenCandidates = pools.evergreen.filter(repo => !fresh.names.includes(repo.fullName));
  const targets = calculateTargets(fresh.names.length, evergreenCandidates.length);
  if (targets.freshTarget !== fresh.names.length) throw new Error('Fresh selection target changed unexpectedly');
  let evergreen = await generateSelection('evergreen', evergreenCandidates, preferences, targets.evergreenTarget);
  let digest = composeDigest(today, fresh, evergreen, targets.freshTarget, args.dataAgeHours);
  let bytes = Buffer.byteLength(digest, 'utf8');
  if (bytes < MIN_DIGEST_BYTES) {
    const rewriteFresh = targets.evergreenTarget === 0 || Buffer.byteLength(fresh.text, 'utf8') <= Buffer.byteLength(evergreen.text, 'utf8');
    if (rewriteFresh) fresh = await rewriteSelection('fresh', fresh, targets.freshTarget);
    else evergreen = await rewriteSelection('evergreen', evergreen, targets.evergreenTarget);
    digest = composeDigest(today, fresh, evergreen, targets.freshTarget, args.dataAgeHours);
    bytes = Buffer.byteLength(digest, 'utf8');
  }
  const selected = [
    ...fresh.names.map(fullName => ({ fullName, pool: 'fresh' })),
    ...evergreen.names.map(fullName => ({ fullName, pool: 'evergreen' }))
  ];
  if (selected.length < MIN_TOTAL_RECOMMENDATIONS || selected.length > MAX_TOTAL_RECOMMENDATIONS) {
    throw new Error(`Digest project count ${selected.length} is outside ${MIN_TOTAL_RECOMMENDATIONS}-${MAX_TOTAL_RECOMMENDATIONS}`);
  }
  if (bytes < MIN_DIGEST_BYTES) throw new Error(`Digest remained below ${MIN_DIGEST_BYTES} bytes after targeted rewrite (${bytes} bytes)`);
  console.log(digest);
  console.error(`[github-digest] Digest generated successfully: ${selected.length} projects, ${bytes} bytes`);
  writeHistoryOutputs(args, selected);
}

main().catch(error => {
  console.error(`[github-digest] Error: ${error.message}`);
  process.exit(1);
});
