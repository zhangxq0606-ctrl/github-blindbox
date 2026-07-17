#!/bin/bash
# ============================================================================
# GitHub 每日盲盒 — 推送 Pipeline（不抓取，只从缓存读取）
# ============================================================================
# 从缓存文件读取前一天 05:00 抓取的数据，AI 筛选后发邮件。
#
# Cron: 0 10 * * * bash /var/www/github-blindbox/scripts/run-trending.sh
# ============================================================================

set -e

LOCK_FILE="/tmp/github-blindbox-run-trending.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: Another run-trending process is active; exiting"
  exit 0
fi

# 不再强制覆盖 MODEL：使用 .env 里的 deepseek-v4-flash，与 follow-builders 保持一致
# 如需切换模型，改 $PROJECT_DIR/.env 即可

PROJECT_DIR="/var/www/github-blindbox"
SCRIPTS_DIR="$PROJECT_DIR/scripts"
CACHE_DIR="$PROJECT_DIR/cache"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
TMP_DIR="/tmp/github-blindbox"
mkdir -p "$TMP_DIR" "$CACHE_DIR"

LOG_FILE="$TMP_DIR/trending-$(date '+%Y%m%d-%H%M').log"

echo "[$TIMESTAMP] === GitHub 每日盲盒 — 推送阶段 ===" | tee -a "$LOG_FILE"

# Step 1: Read cached trending data
CACHE_FILE="$CACHE_DIR/trending-data.json"
echo "[$TIMESTAMP] Step 1: Reading cached trending data from $CACHE_FILE..." | tee -a "$LOG_FILE"

if [ ! -f "$CACHE_FILE" ]; then
  echo "[$TIMESTAMP] WARNING: Cache file missing at $CACHE_FILE. Falling back to trending-feed.json (last GitHub push)." | tee -a "$LOG_FILE"
  CACHE_FILE="$PROJECT_DIR/trending-feed.json"
  if [ ! -f "$CACHE_FILE" ]; then
    echo "[$TIMESTAMP] ERROR: No cache file and no trending-feed.json found." | tee -a "$LOG_FILE"
    exit 1
  fi
fi

# Validate cache file
if ! node -e "JSON.parse(require('fs').readFileSync('$CACHE_FILE','utf-8'))" 2>>"$LOG_FILE"; then
  echo "[$TIMESTAMP] ERROR: Cache file is corrupted" | tee -a "$LOG_FILE"
  exit 1
fi

REPO_COUNT=$(node -e "const d=require('$CACHE_FILE'); console.log(d.repos?.length||0)" 2>/dev/null || echo "0")
echo "[$TIMESTAMP] Cache has $REPO_COUNT repos" | tee -a "$LOG_FILE"

if [ "$REPO_COUNT" -eq 0 ]; then
  echo "[$TIMESTAMP] ERROR: Cache has no repos" | tee -a "$LOG_FILE"
  exit 1
fi

if ! CACHE_AGE_HOURS=$(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const timestamp=Date.parse(data.fetchedAt); if(!Number.isFinite(timestamp)) process.exit(1); console.log(Math.max(0, Math.floor((Date.now()-timestamp)/3600000)))" "$CACHE_FILE" 2>>"$LOG_FILE"); then
  echo "[$TIMESTAMP] ERROR: Cache fetchedAt is missing or invalid; refusing to send" | tee -a "$LOG_FILE"
  exit 1
fi

AGE_ARGS=""
if [ "$CACHE_AGE_HOURS" -ge 48 ]; then
  echo "[$TIMESTAMP] ERROR: Cache is ${CACHE_AGE_HOURS} hours old (limit: 48); refusing to send" | tee -a "$LOG_FILE"
  exit 1
elif [ "$CACHE_AGE_HOURS" -ge 24 ]; then
  AGE_ARGS="--data-age-hours $CACHE_AGE_HOURS"
  echo "[$TIMESTAMP] WARNING: Cache is ${CACHE_AGE_HOURS} hours old; sending with stale-data notice" | tee -a "$LOG_FILE"
else
  echo "[$TIMESTAMP] Cache age is ${CACHE_AGE_HOURS} hours; sending normally" | tee -a "$LOG_FILE"
fi

# Show cache age if available
if [ -f "$CACHE_DIR/trending-fetched-at.txt" ]; then
  FETCHED_AT=$(cat "$CACHE_DIR/trending-fetched-at.txt")
  echo "[$TIMESTAMP] Data fetched at: $FETCHED_AT" | tee -a "$LOG_FILE"
fi

# Step 2: Generate AI digest (with dedup from history)
# ⚠️  历史去重文件放在项目目录下持久化，不再放 /tmp（/tmp 会被 systemd-tmpfiles 定期清理）
echo "[$TIMESTAMP] Step 2: Generating AI digest..." | tee -a "$LOG_FILE"

HISTORY_FILE="$PROJECT_DIR/.trending-history.json"
HISTORY_STATE_FILE="$PROJECT_DIR/.trending-history-state.json"
EXCLUDE_ARGS=""
if [ -s "$HISTORY_FILE" ]; then
  EXCLUDE_ARGS="--exclude-file $HISTORY_FILE"
  HISTORY_COUNT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$HISTORY_FILE','utf-8')).length)}catch{console.log(0)}" 2>/dev/null)
  echo "[$TIMESTAMP] Using persistent history cache: $HISTORY_COUNT entries in $HISTORY_FILE" | tee -a "$LOG_FILE"
else
  echo "[$TIMESTAMP] No persistent history found at $HISTORY_FILE. Running without history dedup." | tee -a "$LOG_FILE"
fi

cat "$CACHE_FILE" | node "$SCRIPTS_DIR/github-digest.js" $EXCLUDE_ARGS $AGE_ARGS --history-state-file "$HISTORY_STATE_FILE" --history-output "$TMP_DIR/trending-history.json.tmp" --history-state-output "$TMP_DIR/trending-history-state.json.tmp" 2>>"$LOG_FILE" > "$TMP_DIR/trending-digest.txt"

if [ $? -ne 0 ] || [ ! -s "$TMP_DIR/trending-digest.txt" ]; then
  echo "[$TIMESTAMP] ERROR: Failed to generate digest" | tee -a "$LOG_FILE"
  exit 1
fi

DIGEST_SIZE=$(wc -c < "$TMP_DIR/trending-digest.txt")
echo "[$TIMESTAMP] Digest generated: ${DIGEST_SIZE} bytes" | tee -a "$LOG_FILE"

# Step 3: Send via QQ email (with retry)
MAX_RETRIES=3
RETRY_DELAY=30
EMAIL_SENT=false
for ((ATTEMPT=1; ATTEMPT<=MAX_RETRIES; ATTEMPT++)); do
  echo "[$TIMESTAMP] Step 3: Sending email (attempt $ATTEMPT/$MAX_RETRIES)..." | tee -a "$LOG_FILE"
  if cat "$TMP_DIR/trending-digest.txt" | node "$SCRIPTS_DIR/send-email.js" \
    --to "3339898076@qq.com" \
    --subject "GitHub 每日盲盒 — $(date '+%Y-%m-%d')" 2>>"$LOG_FILE"; then
    echo "[$TIMESTAMP] Email sent successfully on attempt $ATTEMPT" | tee -a "$LOG_FILE"
    EMAIL_SENT=true
    break
  fi
  if [ "$ATTEMPT" -lt "$MAX_RETRIES" ]; then
    echo "[$TIMESTAMP] Attempt $ATTEMPT failed, retrying in ${RETRY_DELAY}s..." | tee -a "$LOG_FILE"
    sleep $RETRY_DELAY
  fi
done

if [ "$EMAIL_SENT" = "true" ]; then
  echo "[$TIMESTAMP] SUCCESS: Email sent!" | tee -a "$LOG_FILE"

  # 兼容旧 history 数组，并在邮件发送成功后更新带时间戳的冷却状态。
  if [ -s "$TMP_DIR/trending-history.json.tmp" ]; then
    node -e "
      const fs = require('fs');
      const today = JSON.parse(fs.readFileSync('$TMP_DIR/trending-history.json.tmp','utf-8'));
      let history = [];
      try { history = JSON.parse(fs.readFileSync('$HISTORY_FILE','utf-8')); } catch {}
      const merged = [...new Set([...history, ...today])];
      const trimmed = merged.slice(-200);
      fs.writeFileSync('$HISTORY_FILE', JSON.stringify(trimmed, null, 2));
      console.log('Persistent history updated: ' + trimmed.length + ' unique projects cached (kept last 200)');
    " 2>>"$LOG_FILE"
    rm -f "$TMP_DIR/trending-history.json.tmp"
    echo "[$TIMESTAMP] Persistent history updated" | tee -a "$LOG_FILE"
  fi

  if [ -s "$TMP_DIR/trending-history-state.json.tmp" ]; then
    node -e "
      const fs = require('fs');
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const today = JSON.parse(fs.readFileSync('$TMP_DIR/trending-history-state.json.tmp','utf8'));
      let state;
      try { state = JSON.parse(fs.readFileSync('$HISTORY_STATE_FILE','utf8')); } catch { state = null; }
      if (!state || !Array.isArray(state.entries)) {
        let legacy = [];
        try { legacy = JSON.parse(fs.readFileSync('$HISTORY_FILE','utf8')); } catch {}
        state = {
          version: 1,
          entries: [],
          legacy: {
            freshNames: legacy.slice(-50),
            freshNamesExpiresAt: new Date(now + 7 * day).toISOString(),
            evergreenNames: legacy.slice(-100),
            evergreenNamesExpiresAt: new Date(now + 14 * day).toISOString()
          }
        };
      }
      const byName = new Map();
      for (const entry of [...state.entries, ...(today.entries || [])]) {
        if (entry && typeof entry.fullName === 'string' && !Number.isNaN(Date.parse(entry.sentAt))) byName.set(entry.fullName, entry);
      }
      const cutoff = now - 30 * day;
      const entries = [...byName.values()]
        .filter(entry => Date.parse(entry.sentAt) >= cutoff)
        .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))
        .slice(-200);
      fs.writeFileSync('$HISTORY_STATE_FILE', JSON.stringify({ version: 1, entries, legacy: state.legacy }, null, 2));
      console.log('Cooldown state updated: ' + entries.length + ' timestamped entries');
    " 2>>"$LOG_FILE"
    rm -f "$TMP_DIR/trending-history-state.json.tmp"
    echo "[$TIMESTAMP] Timestamped cooldown state updated" | tee -a "$LOG_FILE"
  fi
else
  echo "[$TIMESTAMP] ERROR: Failed to send email" | tee -a "$LOG_FILE"
  exit 1
fi

# Cleanup old logs (keep 30 days)
find "$TMP_DIR" -name 'trending-*.log' -mtime +30 -delete 2>/dev/null || true

echo "[$TIMESTAMP] === 推送阶段完成 ===" | tee -a "$LOG_FILE"
