# Claude Code から観測できるフィールドの実測 (hooks / statusline / transcript)

- 目的: #91 (ccx-center basic) の前提固め。「どの経路で何が取れて、何が取れないか」を推測ゼロで確定させる
- 計測日: 2026-08-17 (JST)
- 計測ホスト: d1 / Linux / Claude Code v2.1.233
- 対象 repodir: `/root/.ccx/github.com/TakashiAihara/ccx/01M07WFJ7ZE00B`
- 計測モデル: `claude-sonnet-5` (計測用セッション) / `claude-opus-5[1m]` (計測を回した本セッション)
- ユーザーのグローバル設定 `~/.claude/settings.json` は読み取りのみ。書き換えていない。計測はすべて `<repodir>/.claude/settings.json` (project 設定) で行った
- 生ダンプ置き場: 計測ごとに `mktemp -d` で作る一時ディレクトリ配下 (repodir 外・mode 700・計測後に破棄)

## 結論 (先に3行)

- セッション自身のトークン / コスト / context window / rate limit / fast mode / output style / PR は statusline からしか取れない。hook の payload には入らない (唯一の例外が次の 4 行目)
- モデルとトークンの「履歴」は transcript にしかない。1 メッセージ単位の model と usage (thinking tokens 込み) が全部残る。ただし cost・context window サイズ・rate limit は transcript にも無い
- hook は「いつ何が起きたか」の event stream。model は SessionStart にだけ、しかも interactive 起動時にしか入らない。effort と permission mode は入る
- 例外が 1 つ。subagent のトークンだけは hook から取れる。`Agent` tool の PostToolUse の `tool_response.usage` に、その subagent 分の全内訳と `resolvedModel` が入る。3 つの経路は用途で分かれる。セッション単位の集計は statusline、メッセージ単位の履歴は transcript、subagent 単位の usage は hook

## 経路ごとの性格

| 経路 | 取得契機 | 主に取れるもの | 主に取れないもの |
| :--- | :--- | :--- | :--- |
| hook stdin JSON | イベント発生時 (31 種) | イベント種別・時系列・tool 入出力・permission mode・effort・subagent 識別子 | model (SessionStart 以外)・トークン・コスト・context window・rate limit・version |
| statusline stdin JSON | interactive セッションのみ。セッション開始時 + assistant メッセージ着信 + `/compact` 完了 + permission mode 変更 + vim mode 切替 + `refreshInterval` タイマ。`claude -p` では 1 度も動かない | model・トークン・context window・使用率・rate limit・コスト・fast mode・output style・version・PR・worktree | イベント種別・tool 入出力・permission mode・git branch |
| transcript JSONL | 常時追記 (非同期) | メッセージ単位の model・usage 全内訳 (thinking 込み)・effort・permissionMode・version・gitBranch・tool 結果・compact 境界・subagent 別 transcript | cost・context window サイズ・使用率・rate limit・fast mode・output style・PR・worktree |

## 論点別の対応表

判定の凡例。

- `取れる` = 実測で値を確認した
- `取れない` = 同じダンプ経路で他フィールドが取れていること (ネガティブコントロール) を確認したうえで、キー自体が存在しなかった
- `未実測` = 環境上その状態を作れなかった。ドキュメント記載のみ

| フィールド | hook (どのイベントか) | statusline | transcript | 根拠 |
| :--- | :--- | :--- | :--- | :--- |
| model (id) | SessionStart のみ `model` (文字列)。interactive 起動でのみ観測、`claude -p` では常に欠落 | `model.id` (毎回) | `assistant.message.model` (メッセージ単位) | ローカル SessionStart 15 件中 4 件に `model`。収集基盤の 1086 payload 走査でも `model` は SessionStart 57 件中 11 件のみ |
| model (表示名) | 取れない | `model.display_name` | 取れない | statusline union キーに存在。transcript は id のみ |
| input tokens | 取れない (例外: `Agent` tool の PostToolUse `tool_response.usage`) | `context_window.current_usage.input_tokens` / `total_input_tokens`。必須ではない。最初の API 応答前と `/compact` 直後は `current_usage` が `null` で、合計値は `0`。読む側は欠落と `null` の両方を想定する | `message.usage.input_tokens` | 1086 payload 走査で `input_tokens` は hook に無し。statusline / transcript の実サンプルあり |
| output tokens | 同上 (例外も同じ) | `current_usage.output_tokens` / `total_output_tokens` | `message.usage.output_tokens` | 同上 |
| cache read tokens | 同上 | `current_usage.cache_read_input_tokens` | `message.usage.cache_read_input_tokens` | 同上 |
| cache creation tokens | 同上 | `current_usage.cache_creation_input_tokens` (内訳なし) | `usage.cache_creation_input_tokens` + `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` | transcript だけ 5m/1h の内訳を持つ |
| thinking tokens | 取れない (例外: `Agent` tool の `tool_response.usage.output_tokens_details`) | 取れない。`thinking.enabled` (真偽) のみ | `message.usage.output_tokens_details.thinking_tokens` | 本セッションの assistant レコードで `thinking_tokens: 1209` を実測 |
| context window サイズ | 取れない | `context_window.context_window_size` (実測 1000000) | 取れない | 全 transcript 走査で `contextWindow` / `context_window` キーは 0 件 |
| context 使用率 | 取れない | `used_percentage` / `remaining_percentage` / `exceeds_200k_tokens` | 直接は取れない。`compact_boundary` の `preTokens` / `postTokens` と usage 集計から算出は可能 | statusline 実サンプル。transcript は compact 時のみ |
| rate limit 5h | 取れない | `rate_limits.five_hour.used_percentage` / `.resets_at` (epoch 秒) | 取れない | statusline 259 回中 258 回で存在。欠落した 1 回は「セッション最初の API 応答前」 |
| rate limit 7d | 取れない | `rate_limits.seven_day.used_percentage` / `.resets_at` | 取れない | 同上 |
| コスト (USD) | 取れない | `cost.total_cost_usd` / `total_duration_ms` / `total_api_duration_ms` / `total_lines_added` / `total_lines_removed` | 取れない | 全 transcript 走査で `cost` 系キー 0 件。1086 hook payload でも 0 件 |
| effort | 取れる。tool コンテキストのイベント (PreToolUse / PostToolUse / PostToolUseFailure / PostToolBatch / PermissionRequest) と Stop / SubagentStop に `effort.level`。hook プロセスの環境変数 `$CLAUDE_EFFORT` にも入る | `effort.level` | `assistant.effort` (オブジェクトではなく文字列 `"high"`) | 3 経路すべてで実測 |
| permission mode | 取れる。`permission_mode` (UserPromptSubmit / tool 系 / Stop / SubagentStop / UserPromptExpansion) | 取れない | `user.permissionMode` + `type: "permission-mode"` レコード | statusline の union キー 19 個に `permission_mode` は無い |
| output style | 取れない | `output_style.name` | 取れない | 全 transcript 走査で `outputStyle` / `output_style` 0 件 |
| fast mode | 取れない | `fast_mode` (真偽) | 取れない | 同上。補足として `claude -p --output-format json` の結果には `fast_mode_state` / `fast_mode_disabled_reason` がある |
| Claude Code version | 取れない | `version` | 取れる。ただしメッセージ系レコードのみ (`assistant` 386/386、`user` 248/248、`attachment` 388/388、`system` 16/16)。`mode` / `permission-mode` / `ai-title` / `last-prompt` / `bridge-session` などの状態レコードには入らない | 1086 hook payload に `version` キー 0 件。transcript は type 別に出現率を数えた |
| PR 情報 | 取れない | `pr.number` / `pr.url` / `pr.review_state` | 番号と URL は取れる。`type: "pr-link"` レコードの `prNumber` / `prUrl` / `prRepository`。`review_state` は無い | statusline は open PR のあるブランチに切り替えて実測 (PR #62 / review_state `pending`)。transcript 側はセッションが PR に紐づいた時点で `pr-link` が 1 行追記されるのを実測 |
| worktree 情報 | 未実測 | 未実測 (ドキュメント上は `workspace.git_worktree` / `worktree.name` / `.path` / `.branch` / `.original_cwd` / `.original_branch`) | 未実測 | この環境は git worktree 使用禁止のため、worktree 内のセッションを作っていない。3 経路とも「取れない」と断定できる観測はしていない |
| repo 識別 | 取れない | `workspace.repo.host` / `.owner` / `.name` | 取れない (`gitBranch` はある) | statusline 実サンプルで `github.com / TakashiAihara / ccx` |
| git branch | 取れない | 取れない | `gitBranch`。`version` と同じ 4 種のメッセージ系レコードのみ (`assistant` 386/386、`attachment` 388/388、`user` 248/248、`system` 16/16)。状態レコード (`mode` / `pr-link` / `ai-title` など) には入らない | statusline は repo 識別のみでブランチを持たない。transcript は type 別に出現率を数えた |
| session id | 取れる `session_id` | `session_id` | `sessionId` (+ 一部レコードに `session_id`) | 3 経路すべて |
| cwd | 取れる `cwd` | `cwd` / `workspace.current_dir` / `workspace.project_dir` / `workspace.added_dirs` | `cwd` | 3 経路すべて |
| transcript パス | 取れる `transcript_path` | `transcript_path` | 自分自身 | 3 経路すべて |
| prompt_id | 取れる (最初のユーザー入力以降) | `prompt_id` (同条件) | `user.promptId` | statusline 259 回中 40 回。API 応答前の起動時には無い |
| セッション名 / タイトル | SessionStart の `session_title`、UserPromptSubmit の `session_title` (いずれも未文書化) | `session_name` (`--name` / `/rename` / AI 生成タイトル時) | `type: "ai-title"` / `"custom-title"` / `"agent-name"` レコード | `--name meas-two` で実測 |
| subagent 識別 | 取れる `agent_id` / `agent_type` (subagent 内で発火した全イベント)、SubagentStop の `agent_transcript_path` | `agent.name` + 未文書化の top-level `agent_type` | `agentId` / `attributionAgent` / `isSidechain` と `<session>/subagents/agent-*.jsonl` | Explore subagent を 1 体起動して実測 |
| subagent のトークン / モデル | 取れる。`Agent` tool の PostToolUse `tool_response` に `usage` (全内訳) / `resolvedModel` / `totalTokens` / `totalDurationMs` / `totalToolUseCount` | 取れない | subagent transcript の `message.usage` | 唯一 hook からトークンが読める経路。PostToolBatch 側の `tool_response` には usage が無い |
| tool 入出力 | 取れる `tool_name` / `tool_input` / `tool_response` / `tool_use_id` / `duration_ms` / `error` | 取れない | `toolUseResult` | tool 系イベントの実サンプル |
| 起動形態 (interactive / headless) | 直接のキーは無い。hook プロセスの `$CLAUDE_CODE_ENTRYPOINT` で判別可 (`cli` / `sdk-cli`) | 取れない | `entrypoint` (`cli` 903 件 / `sdk-cli` 135 件) | 環境変数ダンプと transcript 走査 |
| compact | PreCompact `trigger` / `custom_instructions`、PostCompact `trigger` / `compact_summary` | 直後は `context_window.current_usage` が null に戻る | `subtype: "compact_boundary"` の `compactMetadata` (`trigger` / `preTokens` / `postTokens` / `cumulativeDroppedTokens` / `durationMs` / `preservedSegment`) | `/compact` を実行して実測 |
| hook 自身の実行結果 | (自分の結果は見えない) | 取れない | `type: "attachment"` の `hook_success` (`hookName` / `exitCode` / `stdout` / `durationMs`) | transcript 実サンプル |

## どの経路でも取れないもの

- セッション累計トークン。statusline の `context_window` は「いま窓に載っている量」であって累計ではなく、`cost` は USD しか持たない。累計が要るなら transcript の `message.usage` を自前で積む
- モデル別の「コスト」内訳。`claude -p --output-format json` の `modelUsage` にだけ存在する (別経路)。モデル別の「トークン」は取れる。transcript の `message.model` と `message.usage` をモデル単位で集計すればよい。取れないのはコストの方
- rate limit の絶対値。`used_percentage` と `resets_at` のみで、残トークン数・残リクエスト数は出ない
- 5h / 7d 以外の rate limit window
- git branch を statusline から。statusline は repo 識別 (host/owner/name) までで、ブランチは transcript の `gitBranch` を見るしかない
- permission mode を statusline から
- context window サイズを hook / transcript から。モデル id から引き当てるしかない
- 「いま何回目のリクエストか」のようなシーケンス番号。`bridge-session.lastSequenceNum` は remote control 用で、API 呼び出し回数ではない

## 経路の選び方

3 経路は代替関係ではなく補完関係にある。何を集めたいかで必要な経路が決まる。

### statusline は interactive セッションでしか動かない

同一の project 設定 (`statusLine` + SessionStart hook) を置いて、起動形態だけを変えて実測した。

| 起動形態 | SessionStart hook | statusline |
| :--- | ---: | ---: |
| `claude -p '...'` (headless) | 1 回 | 0 回 |
| interactive (tmux 経由で起動、プロンプトは送らない) | 1 回 | 46〜49 回 (50 秒間、`refreshInterval: 1`。4 回実行して 46 / 46 / 47 / 49) |

- 同じ設定・同じスクリプトで hook 側は両方とも発火しているので、「設定が読まれていない」ではなく「statusline が headless では呼ばれない」と切り分けられる (ネガティブコントロール)
- interactive 側は statusline スクリプトに `echo SL-OK` を仕込み、画面下部に `SL-OK` が描画されることも確認した
- 起動直後は数十秒かかることがある。10 秒台で判定すると interactive でも 0 回に見えるので、待ち時間を伸ばして確かめること

再現手順。3 点を守らないと結果を誤読する。

- 既存の project 設定を退避してから走らせる。`cleanup` は 2 度呼ばれても壊れないようにする (シグナルで走った後に EXIT でもう一度走る)
- `claude` と `tmux` の起動が成功したこと、hook 側が発火したことを先に確かめる。statusline が 0 回でも、起動に失敗しただけかもしれない
- statusline の呼び出し回数は、スクリプトの先頭で専用のカウンタに 1 行足して数える。stdin を書いたファイルの行数で数えると、実行中にキャンセルされた呼び出し (300ms デバウンスの仕様) を取りこぼす

```bash
set -e
export REPODIR=$(git rev-parse --show-toplevel)
D=$(mktemp -d); install -d -m 700 "$D" "$D/backup" "$D/raw"
SESSION="slchk-$$"

[ -e "$REPODIR/.claude/settings.json" ] && install -D -m 600 "$REPODIR/.claude/settings.json" "$D/backup/settings.json"
cleanup() {
  if [ -e "$D/backup/settings.json" ]; then
    install -D -m 600 "$D/backup/settings.json" "$REPODIR/.claude/settings.json"
  else
    rm -f "$REPODIR/.claude/settings.json"
    rmdir "$REPODIR/.claude" 2>/dev/null || true
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$D"
}
# 復元は EXIT で 1 度だけ。シグナル側は終了させるだけにして二重実行を作らない
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cat > "$D/sl.sh" <<'SH'
#!/bin/sh
R=$(dirname "$0")
echo call >> "$R/sl-calls.txt"      # 呼び出し開始で必ず 1 行
T=$(mktemp "$R/raw/sl-XXXXXX.json")
cat > "$T"
echo "SL-OK"
SH
cat > "$D/hook.sh" <<'SH'
#!/bin/sh
R=$(dirname "$0")
echo call >> "$R/hook-calls.txt"
cat > /dev/null
exit 0
SH
chmod 700 "$D/sl.sh" "$D/hook.sh"
install -d -m 700 "$REPODIR/.claude"
REPODIR="$REPODIR" python3 -c "
import json, os, sys
d = sys.argv[1]
json.dump({'statusLine': {'type': 'command', 'command': d + '/sl.sh', 'refreshInterval': 1},
           'hooks': {'SessionStart': [{'hooks': [{'type': 'command', 'command': d + '/hook.sh', 'timeout': 10}]}]}},
          open(os.path.join(os.environ['REPODIR'], '.claude', 'settings.json'), 'w'), indent=2)
" "$D"

# grep -c は空ファイルで "0" を出しつつ exit 1 になるので || と組み合わせると 2 行出る。wc で数える
count() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

if ! timeout 300 claude -p 'Reply with the single word DONE.' --model sonnet > "$D/headless.out" 2>&1; then
  echo "headless run failed — 計測無効"; tail -3 "$D/headless.out"; exit 1
fi
h_hook=$(count "$D/hook-calls.txt"); h_sl=$(count "$D/sl-calls.txt")
[ "$h_hook" -ge 1 ] || { echo "hook が発火していない = 設定が読まれていない。計測無効"; exit 1; }
echo "headless: hook=$h_hook statusline=$h_sl"

tmux new-session -d -s "$SESSION" -x 180 -y 40 -c "$REPODIR" "claude --model sonnet"
sleep 50
tmux has-session -t "$SESSION" 2>/dev/null || { echo "セッションが落ちた。計測無効"; exit 1; }
i_hook=$(count "$D/hook-calls.txt"); i_sl=$(count "$D/sl-calls.txt")
[ "$i_hook" -gt "$h_hook" ] || { echo "interactive で hook が発火していない = 起動途中。待ち時間を延ばして再実行"; exit 1; }
tmux capture-pane -p -t "$SESSION" | grep -q SL-OK || echo "warning: 画面に SL-OK が見えない"
echo "interactive: hook=$((i_hook - h_hook)) statusline=$((i_sl - h_sl))"

if [ "$h_sl" -eq 0 ] && [ "$((i_sl - h_sl))" -gt 0 ]; then
  echo "結論: statusline は interactive でのみ動く"
else
  echo "結論と異なる結果。headless=$h_sl interactive=$((i_sl - h_sl))"
fi
```

同じ repodir で別の Claude Code セッションが動いていると、そのセッションの statusline も計測用のものに差し替わる (statusLine と `refreshInterval` は動作中セッションに即時反映される)。呼び出し回数もそちらのぶん混ざるので、他のセッションを止めてから走らせるか、専用の repodir を切って実行する。



この手順は掲載した状態のまま抜き出して確認した。既存の `.claude/settings.json` を置いた状態で走らせても実行後に中身が元のまま残り (sentinel で確認)、存在しない状態で走らせれば計測で作ったものだけが消える。

statusline の stdin は 1 行の JSON で、1 回ぶんが 1234 バイトだった。行数で数えても回数と一致するが、上のカウンタ方式の方が安全。

つまり headless セッションも観測対象にするなら、statusline に依存した設計はそこで穴が開く。

### hook payload だけでは足りない。ただし hook 起点なら足りる

- hook の payload にコスト・context・rate limit は入らない。トークンも、`Agent` tool の PostToolUse が持つ subagent 分 (`tool_response.usage`) を除いて入らない
- ただし全イベントに `transcript_path` が載る。hook プロセスがそのファイルを読めば、`message.model` と `message.usage` (thinking tokens 込み)、`effort`、`gitBranch` まで取れる
- `effort` は transcript を読まなくても hook から取れる。tool コンテキスト系イベントと Stop / SubagentStop の `effort.level`、および hook プロセスの環境変数 `$CLAUDE_EFFORT`
- 「そのプロンプトを処理したモデル」は hook では確定できない。`model` が載るのは SessionStart だけで、しかも interactive 起動時のみ。セッション途中の `/model` 切替も追えない。transcript の `message.model` が唯一の経路

### transcript を読んでも埋まらないもの

| フィールド | 代替 |
| :--- | :--- |
| `cost.total_cost_usd` | model + usage + 価格表から自前計算できる。ただし Claude Code の算出値と突き合わせてはいない |
| `context_window.context_window_size` | モデル ID から引き当てる (実測では `claude-sonnet-5` / `claude-opus-5[1m]` とも 1000000) |
| `used_percentage` | usage から算出できる。`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` を窓サイズで割る。出力トークンは含めない (ドキュメント記載の式と同じ) |
| `rate_limits.five_hour` / `seven_day` | 代替経路なし。statusline を持つ以外に取得手段がない |
| `fast_mode` / `output_style.name` | 代替経路なし |

### 2 つの構成

| | hook 起点のみ | hook 起点 + statusline |
| :--- | :--- | :--- |
| 対象セッション | headless と interactive の両方 | statusline 由来の値は interactive のみ |
| model / usage / effort / gitBranch | 取れる (transcript 経由) | 同左 |
| コスト | 自前計算 | 公式値 (`cost.total_cost_usd`) |
| context 使用率 | 自前計算 | 公式値 |
| rate limit (5h / 7d) | 取れない | 取れる |
| 副作用 | なし | ユーザーの既存 statusline を奪うので委譲が必須。1 セッションあたり数秒に 1 回、1KB 強の JSON が流れる |

### hook 起点で transcript を読むときの注意

- transcript の書き込みは非同期。hook が発火した時点では直近のメッセージがまだ載っていないことがある (ドキュメントにも明記あり)。Stop hook で「いまの応答の usage」を取るなら、リトライか遅延が要る
- 末尾行が書きかけで JSON decode に失敗することがある。失敗を握り潰さず数え、末尾以外で失敗したら結果を捨てる
- 直前の応答のテキストだけが欲しいなら transcript を読む必要はない。Stop / SubagentStop の `last_assistant_message` を使う方が確実 (ドキュメントもそう指示している)

### 逆に hook にしかないもの

- `permission_suggestions` (PermissionRequest)、`notification_type` (Notification)
- ConfigChange / FileChanged / CwdChanged / DirectoryAdded の各イベントそのもの
- `Setup.trigger`、`PreCompact.custom_instructions`
- tool の `duration_ms`、`PostToolUseFailure.error` と `is_interrupt`
- `Agent` tool の PostToolUse が持つ集約値 `totalTokens` / `totalDurationMs` / `totalToolUseCount`。subagent のトークンとモデル自体は subagent transcript (`message.usage` / `message.model`) にもあるので hook 固有ではない。hook 側の利点は、subagent transcript を開かずに 1 イベントで受け取れること

## hook: 観測できたイベントとキー集合

計測で実際に発火した 22 種。31 種を設定して 22 種が発火し、9 種が発火しなかった (22 + 9 = 31)。キー名の後の `[n/m]` は「m 件中 n 件にだけ存在した」という意味 (条件付きフィールド)。

| イベント | 件数 | キー集合 |
| :--- | ---: | :--- |
| ConfigChange | 3 | `agent_type[1/3]`, `cwd`, `file_path`, `hook_event_name`, `prompt_id`, `session_id`, `source`, `transcript_path` |
| CwdChanged | 1 | `cwd`, `hook_event_name`, `new_cwd`, `old_cwd`, `prompt_id`, `session_id`, `transcript_path` |
| DirectoryAdded | 1 | `cwd`, `directory`, `hook_event_name`, `prompt_id`, `session_id`, `source`, `transcript_path` |
| FileChanged | 1 | `cwd`, `event`, `file_path`, `hook_event_name`, `prompt_id`, `session_id`, `transcript_path` |
| InstructionsLoaded | 13 | `agent_type[1/13]`, `cwd`, `file_path`, `hook_event_name`, `load_reason`, `memory_type`, `session_id`, `transcript_path` |
| MessageDisplay | 17 | `agent_type[1/17]`, `cwd`, `delta`, `final`, `hook_event_name`, `index`, `message_id`, `prompt_id`, `session_id`, `transcript_path`, `turn_id` |
| Notification | 3 | `agent_type[1/3]`, `cwd`, `hook_event_name`, `message`, `notification_type`, `prompt_id[2/3]`, `session_id`, `transcript_path` |
| PermissionRequest | 1 | `agent_type`, `cwd`, `effort`, `hook_event_name`, `permission_mode`, `permission_suggestions`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `transcript_path` |
| PostCompact | 1 | `compact_summary`, `cwd`, `hook_event_name`, `prompt_id`, `session_id`, `transcript_path`, `trigger` |
| PostToolBatch | 11 | `agent_id[1/11]`, `agent_type[2/11]`, `cwd`, `effort`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_calls`, `transcript_path` |
| PostToolUse | 9 | `agent_id[1/9]`, `agent_type[2/9]`, `cwd`, `duration_ms`, `effort`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_response`, `tool_use_id`, `transcript_path` |
| PostToolUseFailure | 1 | `cwd`, `duration_ms`, `effort`, `error`, `hook_event_name`, `is_interrupt`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path` |
| PreCompact | 1 | `custom_instructions`, `cwd`, `hook_event_name`, `prompt_id`, `session_id`, `transcript_path`, `trigger` |
| PreToolUse | 12 | `agent_id[1/12]`, `agent_type[3/12]`, `cwd`, `effort`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path` |
| SessionEnd | 13 | `agent_type[1/13]`, `cwd`, `hook_event_name`, `prompt_id[12/13]`, `reason`, `session_id`, `transcript_path` |
| SessionStart | 15 | `agent_type[1/15]`, `cwd`, `hook_event_name`, `model[4/15]`, `prompt_id[1/15]`, `session_id`, `session_title[1/15]`, `source`, `transcript_path` |
| Setup | 3 | `cwd`, `hook_event_name`, `session_id`, `transcript_path`, `trigger` |
| Stop | 13 | `agent_type[1/13]`, `background_tasks`, `cwd`, `effort`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path` |
| SubagentStart | 1 | `agent_id`, `agent_type`, `cwd`, `hook_event_name`, `prompt_id`, `session_id`, `transcript_path` |
| SubagentStop | 2 | `agent_id`, `agent_transcript_path`, `agent_type`, `background_tasks`, `cwd`, `effort`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path` |
| UserPromptExpansion | 1 | `command_args`, `command_name`, `command_source`, `cwd`, `expansion_type`, `hook_event_name`, `permission_mode`, `prompt`, `prompt_id`, `session_id`, `transcript_path` |
| UserPromptSubmit | 14 | `agent_type[2/14]`, `cwd`, `hook_event_name`, `permission_mode`, `prompt`, `prompt_id`, `session_id`, `session_title[2/14]`, `transcript_path` |

観測した列挙値。

- `SessionStart.source`: `startup` / `compact` / `clear`
- `SessionEnd.reason`: `other` (`claude -p` の終了) / `clear` (`/clear`) / `prompt_input_exit` (`/exit`)
- `Setup.trigger`: `init` (`--init-only` と `--init`) / `maintenance` (`--maintenance`)
- `PreCompact.trigger` / `PostCompact.trigger`: `manual`
- `Notification.notification_type`: `idle_prompt` / `permission_prompt`
- `ConfigChange.source`: `project_settings`
- `DirectoryAdded.source`: `slash_command`
- `FileChanged.event`: `change`
- `InstructionsLoaded.memory_type`: `User` / `load_reason`: `session_start`
- `UserPromptExpansion.expansion_type`: `slash_command` / `command_source`: `projectSettings`

## 設定したのに発火しなかったイベント

31 種すべてを設定したうえで、以下 9 種は一度も発火しなかった。「存在しない」ではなく「この計測では発火させられなかった」。表の最終行は Elicitation と ElicitationResult の 2 種を 1 行にまとめている。

| イベント | 発火しなかった理由 (実測または文書) |
| :--- | :--- |
| PermissionDenied | 実測。manual モードでユーザーが「No」を選んでも発火しない。同一セッション・同一ダンプ経路で PermissionRequest は発火しているので、ダンプ側の不具合ではない。文書上は「auto モードが拒否したとき」。auto モードで workspace 外への Write と `rm -rf` を試したがどちらも許可され、拒否を再現できなかった |
| TaskCreated | `TaskCreate` tool がこのセッション種別で利用不可 (モデルが `TASKTOOLS-UNAVAILABLE` を返した)。文書にも「Task tools の無いセッションでは発火しない」とある |
| TaskCompleted | 同上 |
| StopFailure | API エラーで turn が終わる状況を意図的に作らなかった |
| TeammateIdle | agent teams 機能を使っていない |
| WorktreeCreate | この環境は git worktree の使用を禁止しているため、意図的に発火させていない |
| WorktreeRemove | 同上 |
| Elicitation / ElicitationResult | MCP サーバーからの elicitation 要求を発生させられなかった |

## statusline

- interactive セッションでしか動かない。`claude -p` では 1 度も呼ばれない
- 実測した呼び出し回数: 259 回 (5 セッション分。すべて interactive)。以下の出現率もこの 259 回を母数にした同一スナップショット (2026-08-18 04:06 JST 時点)
- 実測したキーの出現率

| キー | 出現 |
| :--- | ---: |
| `context_window`, `cost`, `cwd`, `effort`, `exceeds_200k_tokens`, `fast_mode`, `model`, `output_style`, `session_id`, `thinking`, `transcript_path`, `version`, `workspace` | 259 / 259 |
| `rate_limits` | 258 / 259 |
| `pr` | 67 / 259 |
| `prompt_id` | 40 / 259 |
| `session_name` | 40 / 259 |
| `agent`, `agent_type` | 26 / 259 |

- `rate_limits` が欠けた 1 回 (258/259) は「セッション最初の API 応答より前」の呼び出し。同じ呼び出しでは `context_window.current_usage` も `null`、`used_percentage` / `remaining_percentage` も `null`、`cost.total_cost_usd` は `0`
- `context_window.context_window_size` は API 応答前でも入っている (実測 1000000)
- `pr` は open PR のあるブランチでのみ。同じディレクトリで並走していた 2 セッションのうち、ブランチ切替より前に起動していた側は最後まで `pr` を持たず、切替後に起動した側と切替時に動いていた側は `pr` を持った。PR 検出はセッションごとに独立していて、起動タイミングに依存する
- `permission_mode` は存在しない。permission mode を statusline から知る手段は無い

### 実行タイミングと頻度

- 文書どおりの契機: セッション開始 (resume 含む) / 新しい assistant メッセージ着信 / `/compact` 完了 / permission mode 変更 / vim mode 切替 / `refreshInterval` タイマ
- デバウンス 300ms。実行中に次のトリガが来ると走行中のスクリプトはキャンセルされる
- `refreshInterval` (秒) は `statusLine` オブジェクトの任意フィールド。最小値 1。未設定ならイベント駆動のみ
- 実測: `refreshInterval: 3` を project 設定に足したところ、既に動作中の 2 セッションにも即時に反映され、30 秒で 3 セッション合計 30 回 (= 1 セッションあたり約 3 秒に 1 回) 実行された
- 同時に走るセッションが増えるほど呼び出し回数は線形に増える。1 回の stdin は上記 259 件で最小 1002 / 中央値 1156 / 最大 1504 バイト (Claude Code が出力する整形済み JSON をそのまま計測した値)
- 関連: `subagentStatusLine` という別設定があり、subagent 行ごとに `id` / `name` / `type` / `status` / `description` / `label` / `startTime` / `model` / `effort` / `contextWindowSize` / `tokenCount` / `tokenSamples` / `cwd` を配列で受け取る。今回は未計測

## transcript JSONL

- 場所: `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`
- subagent は `~/.claude/projects/<encoded-cwd>/<session_id>/subagents/agent-<agent_id>.jsonl` に分かれる。同ディレクトリに `agent-<id>.meta.json` (`agentType` / `description` / `toolUseId` / `spawnDepth`) も出る
- 書き込みは非同期。hook が発火した時点では最新メッセージがまだ載っていないことがある (文書の明記あり)

観測したレコード種別。この文書の transcript 側の数字はすべて、2026-08-18 04:06 JST 時点で 14 ファイル (session 13 + subagent 1) / 1441 レコード / 305 パスを 1 回で走査した同一スナップショットから取っている。文書を書いたセッション自身がまだ動いていたので、同じ走査を後で回せば件数は増える。意味があるのは種別とキーであって件数ではない。

| type | 件数 | 主なキー |
| :--- | ---: | :--- |
| attachment | 388 | `attachment` (hook 実行結果 / ファイル添付など), `slug`, 以下 assistant と同じ共通フィールド |
| assistant | 386 | `message` (`model` / `usage` / `stop_reason`), `effort`, `attributionSkill`, `requestId`, `uuid`, `parentUuid`, `timestamp`, `version`, `gitBranch`, `cwd`, `entrypoint`, `userType`, `isSidechain`, `sessionId` |
| user | 248 | `message`, `promptId`, `permissionMode`, `origin` (`{kind: "human"}`), `promptSource` (`typed`), `toolUseResult`, `toolDenialKind`, `sourceToolAssistantUUID`, `isCompactSummary`, `isMeta`, `isVisibleInTranscriptOnly`, `classifierMetaLines`, `slug` |
| last-prompt | 81 | `lastPrompt`, `leafUuid`, `sessionId` |
| mode | 64 | `mode` (実測値は `normal` のみ) |
| bridge-session | 64 | `bridgeSessionId`, `lastSequenceNum`, `ownerAccountUuid`, `ownerOrganizationUuid` (remote control 有効時) |
| permission-mode | 62 | `permissionMode` |
| ai-title | 57 | `aiTitle` |
| queue-operation | 22 | `operation` (`enqueue`), `content`, `timestamp` |
| system | 16 | `subtype` (`bridge_status` / `compact_boundary`), `content`, `level`, `compactMetadata`, `logicalParentUuid`, `hookCount`, `hookErrors`, `hookInfos`, `hookAdditionalContext`, `durationMs`, `stopReason`, `preventedContinuation`, `toolUseID` |
| file-history-snapshot | 12 | `messageId`, `snapshot.trackedFileBackups` |
| pr-link | 34 | `prNumber`, `prUrl`, `prRepository`, `timestamp` |
| custom-title | 2 | `customTitle` (`--name` 由来) |
| agent-name | 2 | `agentName` |
| agent-setting | 2 | `agentSetting` (`--agent` 由来) |
| file-history-delta | 1 | `messageId`, `snapshotMessageId`, `trackingPath`, `backup` |

`message.usage` のキー: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens_details` (`thinking_tokens`), `cache_creation` (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), `server_tool_use` (`web_search_requests` / `web_fetch_requests`), `service_tier`, `speed`, `inference_geo`, `iterations` (リクエスト内の分割ごとの内訳)。

`entrypoint` の実測値: `cli` (interactive) 903 件 / `sdk-cli` (`claude -p`) 135 件。起動形態の判別に使える。

## hook プロセスが見る環境変数

hook から観測できるもう 1 つの経路。ダンプした環境変数は 119 個、うち `CLAUDE` で始まるものは以下。

```text
CLAUDECODE
CLAUDE_CODE_BRIDGE_SESSION_ID
CLAUDE_CODE_CHILD_SESSION
CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY
CLAUDE_CODE_ENTRYPOINT
CLAUDE_CODE_EXECPATH
CLAUDE_CODE_MESSAGING_SOCKET
CLAUDE_CODE_MESSAGING_TOKEN
CLAUDE_CODE_SESSION_ID
CLAUDE_EFFORT
CLAUDE_ENV_FILE
CLAUDE_PID
CLAUDE_PLUGIN_DATA
CLAUDE_PROJECT_DIR
```

値の実測 (安全なものだけ)。

```json
{
 "CLAUDE_PROJECT_DIR": "/root/.ccx/github.com/TakashiAihara/ccx/01M07WFJ7ZE00B",
 "CLAUDE_EFFORT": "high",
 "CLAUDE_ENV_FILE": "/root/.claude/session-env/<session_id>/sessionstart-hook-6.sh",
 "CLAUDE_CODE_ENTRYPOINT": "sdk-cli",
 "CLAUDE_CODE_SESSION_ID": "<session_id>"
}
```

- `CLAUDE_MODEL` は存在しない (ドキュメントにも明記あり)
- `CLAUDE_EFFORT` は payload の `effort.level` と同じ値。`effort` が入らないイベント (SessionStart など) でも環境変数からは読める
- `CLAUDE_PID` があるのでホスト側からプロセスを辿れる

## 収集基盤との交差検証

`claude-hooks-search` (Vector + MinIO) で直近 3 時間・2 ホスト (`d1` / `mcdev`) ぶんの実 payload 1086 件を取り、キー分布を確認した。

- `model` は SessionStart 57 件中 11 件のみ。他のイベントには 1 件も無い。今回のローカル実測と一致する
- `usage` / `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `total_cost_usd` / `cost` / `context_window` / `context_window_size` / `rate_limits` / `fast_mode` / `output_style` / `version` / `thinking` / `pr` / `worktree` / `exceeds_200k_tokens` は 1086 件すべてで不在
- 同じ走査で `effort` (761 件) / `permission_mode` (761 件) / `session_title` (1 件) は検出された。走査に判別能力があることの確認 (ネガティブコントロール)。走査はネスト 3 段までの再帰なので、`tool_response.usage` のような入れ子も対象に入っている
- ただしこの 1086 件のサンプルに PostToolUse は 1 件も含まれていない (このホストのグローバル hooks が転送しているのは PostToolBatch 側)。つまり「1086 件に usage が無い」は、`Agent` tool の PostToolUse が持つ `tool_response.usage` を否定する材料にはならない。両者は別のイベントの話で、矛盾していない。subagent の usage はローカル実測で確認している
- 収集パイプラインが足しているキーは `_collected_at` / `_host` / `path` / `source_type` / `timestamp` の 5 つ。ローカルの生ダンプにはこの 5 つがいずれも存在しないので、Claude Code 由来ではないと確定できる
- ローカルでは観測されなかった `InstructionsLoaded.parent_file_path` / `trigger_file_path` が他ホストの payload には出ていた (ネストした CLAUDE.md や include を持つ repo で発生する)

## 実測とドキュメントの食い違い

区分は 3 つ。食い違い 5 件、記述を細かくできたもの 1 件、一致を確認したもの 2 件。

| 区分 | 箇所 | ドキュメント | 実測 |
| :--- | :--- | :--- | :--- |
| 食い違い | statusline の項目一覧 | top-level `agent_type` の記載が無い (`agent.name` のみ) | `agent_type` が top-level に存在する。`--agent general-purpose` のセッションで 26/259 回。値は `agent.name` と同じ |
| 食い違い | SessionStart の入力 | `session_title` の記載が無い | `--name` 付きセッションの SessionStart に `session_title` が入る。UserPromptSubmit にも入ることがある (14 件中 2 件) |
| 食い違い | Notification の入力 | サンプルに `title` がある (「optional な title」と記述) | 実測 3 件すべてで `title` キー自体が存在しない (`idle_prompt` / `permission_prompt` とも) |
| 食い違い | statusline の起動条件 | headless で動かないという記載が無い (「セッション開始時に 1 度走る」とだけある) | `claude -p` では 1 度も呼ばれない。同一設定で SessionStart hook は発火しているので、設定が読まれていないのではなく statusline が呼ばれない |
| 食い違い | 設定の反映タイミング (statusline 側の記述) | 「設定は自動でリロードされる。次のやり取りまで表示は変わらない」 | statusLine (`refreshInterval` 含む) は動作中セッションに即時反映された。一方 hooks 定義は反映されない。FileChanged の watcher を動作中セッションに追加しても発火せず、新規セッションで初めて発火した |
| 記述の詳細化 | SessionStart の `model` | 「SessionStart hook だけが受け取れる。存在は保証されない」 | 保証されないの中身が判明した。interactive 起動 (`source: startup` / `compact`) では毎回入り、`claude -p` では 1 件も入らない。`source: clear` の SessionStart にも入らなかった |
| 一致 | PermissionDenied | 「auto モードが tool 呼び出しを拒否したとき」 | 記述と矛盾しない。manual モードでのユーザー拒否では発火しないことを実測で確認した。auto モードでの拒否は再現できず、このイベントは未観測のまま |
| 一致 | Notification の `permission_prompt` | 「約 6 秒待ってから」 | 約 6 秒後に発火した |

ドキュメントにあるが今回の環境では確認できなかったもの: `vim.mode` (vim モードを有効化できなかった)、`worktree.*` と `workspace.git_worktree` (worktree 使用禁止のため作成せず)、`pr.review_state` の `approved` / `changes_requested` / `draft` (観測できたのは `pending` のみ)。

## 計測手順 (再現用)

### 1. project 設定だけで上書きできるかを確かめる

グローバル設定には触らず、repodir に project 設定を置く。結論としては hooks も statusLine も project 設定で上書きできる。

計測対象の repodir を絶対パスで固定してから生成する。相対パスで書くと、別ディレクトリから実行したときに計測対象外の場所に設定が作られる。

既に project 設定がある repodir で計測すると、生成で既存の `statusLine` や `hooks` を丸ごと失う。先に退避し、後始末で戻す。計測ごとにダンプ先も分ける (`RUN_DIR`)。同じディレクトリに追記し続けると、再計測や並列計測のデータが混ざって件数と不在の判定が壊れる。

```bash
# 計測対象の repodir で実行する。パスは埋め込まず、そこから解決する
export REPODIR=$(git rev-parse --show-toplevel)   # または realpath <計測したいディレクトリ>
export RUN_DIR=$(mktemp -d)      # この計測専用のダンプ置き場。後始末で消す
export ADD_DIR=$(mktemp -d)      # /add-dir と cd の対象にする空ディレクトリ
install -d -m 700 "$RUN_DIR" "$RUN_DIR/dumps" "$RUN_DIR/dumps/statusline" "$RUN_DIR/backup"
install -d -m 700 "$REPODIR/.claude" "$REPODIR/.claude/commands"

# 既存ファイルの退避。書き換える前に必ず通す
for f in .claude/settings.json .claude/commands/measprobe.md measwatch.txt; do
  if [ -e "$REPODIR/$f" ]; then
    install -D -m 600 "$REPODIR/$f" "$RUN_DIR/backup/$f"
    echo "退避: $f"
  fi
done

# 中断しても元に戻るよう、書き換える前に復元処理を仕掛ける
restore() {
  for f in .claude/settings.json .claude/commands/measprobe.md measwatch.txt; do
    if [ -e "$RUN_DIR/backup/$f" ]; then
      install -D -m 600 "$RUN_DIR/backup/$f" "$REPODIR/$f"
    else
      rm -f "$REPODIR/$f"
    fi
  done
}
trap restore EXIT INT TERM HUP
```

`trap` はこのシェルを抜けたときに走る。計測を回している間はこのシェルを生かしておく。

今回の計測対象 repodir には `.claude/` が無かったので、退避は発生していない。

次の Python は `$REPODIR` と `$RUN_DIR` を環境変数から読む。同じシェルで続けて実行するか、`REPODIR=... RUN_DIR=... python3 ...` の形で渡す。

`$REPODIR/.claude/settings.json` を次の形で生成する (31 イベントぶん)。FileChanged だけは matcher が watch 対象そのものを決めるので、監視したいファイル名を matcher に入れる。他の非 tool イベントに matcher は付けない。

```python
import json, os

repodir = os.environ["REPODIR"]
run_dir = os.environ["RUN_DIR"]
watch_file = "measwatch.txt"   # FileChanged の監視対象。repodir 直下のファイル名を書く

events = ["SessionStart","Setup","UserPromptSubmit","UserPromptExpansion","PreToolUse",
          "PermissionRequest","PermissionDenied","PostToolUse","PostToolUseFailure",
          "PostToolBatch","Notification","MessageDisplay","SubagentStart","SubagentStop",
          "TaskCreated","TaskCompleted","Stop","StopFailure","TeammateIdle",
          "InstructionsLoaded","ConfigChange","CwdChanged","DirectoryAdded","FileChanged",
          "WorktreeCreate","WorktreeRemove","PreCompact","PostCompact",
          "Elicitation","ElicitationResult","SessionEnd"]
tool_events = {"PreToolUse","PostToolUse","PostToolUseFailure","PermissionRequest","PermissionDenied"}

hooks = {}
for e in events:
    entry = {"hooks": [{"type": "command", "command": f"{run_dir}/dump.sh {e}", "timeout": 10}]}
    if e in tool_events:
        entry["matcher"] = "*"
    elif e == "FileChanged":
        entry["matcher"] = watch_file
    hooks[e] = [entry]

cfg = {
    "statusLine": {"type": "command", "command": f"{run_dir}/statusline.sh", "refreshInterval": 3},
    "hooks": hooks,
}
path = os.path.join(repodir, ".claude", "settings.json")
with open(path, "w") as f:
    f.write(json.dumps(cfg, indent=2) + "\n")
print("wrote", path)
```

FileChanged の watch リストはセッション起動時に確定する。matcher を後から足しても動作中のセッションには効かないので、追加したら新しいセッションを起動して確かめる。

### 2. ダンプ用スクリプト

生ダンプには prompt 本文・`tool_input`・`tool_response` がそのまま入る。置き場所は手順 1 で作った `$RUN_DIR` (mode 700 / 計測ごとに新規) で、スクリプトもそこに置く。

```bash
umask 077
# 下の 2 スクリプトを $RUN_DIR に保存してから
chmod 700 "$RUN_DIR/dump.sh" "$RUN_DIR/statusline.sh"
```

hook 側。stdout に何も書かず必ず exit 0 にすること (stdout はイベントによってはモデルの context に流れ込む)。

書き込みの失敗を握り潰さないこと。ダンプが落ちているのに hook が成功して見えると、「そのイベントにキーが無かった」ではなく「そもそも記録されていない」だけの状態を、フィールド不在と読み違える。失敗は専用のエラーログに残し、そのうえで exit 0 を保つ (hook の非 0 終了はセッション側の挙動に影響するため)。

```sh
#!/bin/sh
# $RUN_DIR/dump.sh — RUN_DIR は自分の位置から求める (hook は任意の cwd で起動される)
umask 077
R=$(dirname "$0")
D="$R/dumps"
E="$1"
T=$(mktemp "$D/tmp-XXXXXX") || { echo "$(date -Is) $E mktemp failed" >> "$D/dump-errors.log"; exit 0; }
trap 'rm -f "$T"' EXIT INT TERM HUP
if ! cat > "$T"; then
  # 途中で切れた payload は保存しない。半端な行が JSONL に混ざるとキー不在の判定が壊れる
  echo "$(date -Is) $E stdin capture failed (discarded)" >> "$D/dump-errors.log"
  exit 0
fi
if ! { flock 9 && cat "$T" && echo; } 9>>"$D/$E.lock" >> "$D/$E.jsonl"; then
  echo "$(date -Is) $E append failed (size=$(wc -c < "$T" 2>/dev/null))" >> "$D/dump-errors.log"
fi
exit 0
```

このスクリプトは両方向で確認した。正常時は JSONL に追記され (mode 600)、追記先を書けなくすると exit 0 のまま `dump-errors.log` に `append failed (size=8)` が残る。

statusline 側も同じ扱いにする。表示だけ成功して捕捉が落ちる状態を作らないため、`mktemp` と `tee` の失敗をエラーログに残す。委譲先は環境変数 `REAL_STATUSLINE` で渡す。既存の statusline はスクリプトファイルとは限らず inline command のこともあるので、固定パスを前提にしない。

```sh
#!/bin/sh
# $RUN_DIR/statusline.sh
# 委譲先は REAL_STATUSLINE に入れておく (元の settings.json の statusLine.command をそのまま貼る)。
# 例: REAL_STATUSLINE='~/.claude/statusline-command.sh'
#     REAL_STATUSLINE='jq -r ".model.display_name"'
# 未設定なら表示せず捕捉だけする。
umask 077
R=$(dirname "$0")
D="$R/dumps"
T=$(mktemp "$D/statusline/sl-XXXXXXXX.json") || {
  echo "$(date -Is) statusline mktemp failed" >> "$D/dump-errors.log"
  exec cat > /dev/null
}
if ! cat > "$T"; then
  # 半端な JSON を委譲先に渡さない。表示は諦めて記録だけ残す
  echo "$(date -Is) statusline capture failed (not delegated)" >> "$D/dump-errors.log"
  rm -f "$T"
  exit 0
fi
if [ ! -s "$T" ]; then
  echo "$(date -Is) statusline capture empty" >> "$D/dump-errors.log"
fi
if [ -n "$REAL_STATUSLINE" ]; then
  sh -c "$REAL_STATUSLINE" < "$T"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    # 委譲先が落ちると表示が空になる。捕捉は成功しているので exit 0 は保つが、記録は残す
    echo "$(date -Is) REAL_STATUSLINE failed (rc=$rc)" >> "$D/dump-errors.log"
  fi
fi
exit 0
```

`REAL_STATUSLINE` は Claude Code を起動するシェルで export しておく。今回の計測では既存の statusline がスクリプトファイルだったので、そのパスを渡して表示を維持したまま捕捉した。

計測を締める前に `dump-errors.log` が空であることと、イベントごとの件数が想定と合うことを確認する。ここが空でないまま「このイベントにこのキーは無かった」と結論しない。

```bash
test ! -s "$RUN_DIR/dumps/dump-errors.log" && echo "no dump errors"
for f in "$RUN_DIR"/dumps/*.jsonl; do printf '%s %s\n' "$(grep -c . "$f")" "$(basename "$f")"; done
echo "statusline captures: $(ls "$RUN_DIR"/dumps/statusline | wc -l)"
```

最初は `cat >> file` の追記だけで書いていたが、複数セッションが同時に書くと 1 行の JSON が壊れる。hook 側は flock、statusline 側は呼び出しごとに別ファイルにして解消した。壊れた行を「フィールドが無い」と誤読しないための措置であって、Claude Code 側の挙動ではない。

### 3. 各イベントの発火操作

| イベント | 操作 |
| :--- | :--- |
| SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolBatch / MessageDisplay / Stop / SessionEnd / InstructionsLoaded | `claude -p 'Run exactly this bash command: echo hello-measurement-1 . Then reply with the single word DONE.'` |
| PostToolUseFailure | 失敗するコマンドを実行させる (`ls /nonexistent-path-xyz`) |
| SubagentStart / SubagentStop | `Agent` tool (`subagent_type: Explore`) で subagent を 1 体起動させる。`Task` は互換エイリアスで、実測サンプルの `tool_name` は `Agent` |
| UserPromptExpansion | `<repodir>/.claude/commands/measprobe.md` を作り、interactive で `/measprobe` |
| DirectoryAdded | 手順 1 で `export ADD_DIR=$(mktemp -d)` しておき、interactive で `/add-dir $ADD_DIR` (確認ダイアログで Yes)。後始末で消す |
| ConfigChange | 動作中セッションの裏で `.claude/settings.json` を書き換える |
| FileChanged | matcher に書いたファイルを、セッション動作中に外部から書き換える。matcher 追加後は新しいセッションで起動し直す必要がある |
| CwdChanged | `cd $ADD_DIR && sleep 30 && pwd` を Bash tool で実行させる |
| PreCompact / PostCompact | interactive で `/compact` |
| Notification (`idle_prompt`) | 応答完了後に 60 秒以上何も打たずに待つ |
| Notification (`permission_prompt`) / PermissionRequest | `--permission-mode default` で起動し、workspace 外への Write を要求させて 6 秒以上放置 |
| Setup | `claude --init-only` / `--init` / `--maintenance` |
| statusline (PR あり) | open PR のあるブランチを checkout した状態でセッションを起動する |
| statusline (`session_name` / `agent`) | `claude --name meas-two --agent general-purpose` |

interactive セッションは tmux 経由で駆動した。

```bash
tmux new-session -d -s meas1 -x 200 -y 50 -c "$REPODIR" "claude --model sonnet"
tmux send-keys -t meas1 '/compact'; sleep 3; tmux send-keys -t meas1 Enter
tmux capture-pane -p -t meas1 | tail -20
```

`send-keys` で文字列と Enter を一度に送ると、前の入力が処理中のときに行が連結されてコマンドとして成立しない。文字列と Enter は分けて送り、pane を capture して実際に実行されたかを確認する。

### 4. transcript の解析

「無い」を結論に使う走査は、次の 3 つを満たしていないと意味がない。

- トップレベルのキーだけでなく、ドット区切りのパスとして再帰的に集める (`message.usage.output_tokens_details.thinking_tokens` を取りこぼさないため)
- 1 ファイルではなく、対象ディレクトリの全 session JSONL と subagent JSONL を列挙する
- 配列を先頭数件でサンプリングしない。全要素を歩く

`~` は `open()` が展開しないので `expanduser` を通す。

```bash
python3 - <<'PY'
import json, collections, glob, os, re

# encoded-cwd は cwd の "/" と "." を "-" に置換したもの。手打ちせず REPODIR から導出する
repodir = os.environ["REPODIR"]
encoded = re.sub(r"[/.]", "-", repodir)
P = os.path.expanduser("~/.claude/projects/" + encoded)
files = glob.glob(P + "/*.jsonl") + glob.glob(P + "/*/subagents/*.jsonl")
if not files:
    raise SystemExit(f"no transcripts under {P} — encoded-cwd の導出か REPODIR が違う")

types = collections.Counter()
paths = collections.defaultdict(set)
decode_failures = []

def walk(o, t, prefix=""):
    if isinstance(o, dict):
        for k, v in o.items():
            paths[t].add(prefix + k)
            walk(v, t, prefix + k + ".")
    elif isinstance(o, list):
        for v in o:                      # サンプリングしない
            walk(v, t, prefix + "[].")

for f in files:
    lines = open(f).read().splitlines()
    for i, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            # transcript は非同期書き込みなので、末尾行だけは書きかけのことがある。
            # 途中の行が壊れているなら走査結果は信用できない。件数を必ず出す。
            decode_failures.append((f, i, i == len(lines)))
            continue
        t = r.get("type")
        types[t] += 1
        walk(r, t)

if decode_failures:
    mid = [d for d in decode_failures if not d[2]]
    print("DECODE FAILURES:", len(decode_failures), "of which mid-file:", len(mid))
    if mid:
        raise SystemExit("末尾以外に壊れた行がある。セッションを止めてから取り直すこと")
print("files:", len(files), "records:", sum(types.values()), "decode failures:", len(decode_failures))
print(types)
for t in sorted(paths):
    print(t, sorted(paths[t]))
PY
```

この走査を 14 ファイル / 1441 レコード / 305 パス (2026-08-18 04:06 JST 時点、decode 失敗 0 件) に対して回した結果が、本文の判定の根拠。`cost` / `total_cost_usd` / `rate_limits` / `context_window` / `context_window_size` / `fast_mode` / `output_style` / `exceeds_200k_tokens` / `used_percentage` / `modelUsage` はどのパスにも現れず、同じ走査で `effort` / `message.model` / `message.usage.output_tokens_details.thinking_tokens` / `gitBranch` / `version` / `prNumber` は現れた。取れるものが取れることを確認したうえで、取れないものを不在と判定している。

### 5. 後始末

手順 1 で仕掛けた `restore` を明示的に呼んでから、計測用のディレクトリを消す。

```bash
restore                       # 退避があれば戻し、無ければ計測で作ったものを消す
git -C "$REPODIR" status --short     # 意図しない残骸が無いことを確認
rm -rf "$RUN_DIR" "$ADD_DIR"
```

- 今回の repodir には既存の `.claude/` が無かったので、復元ではなく削除で戻した。`.claude/` はこのマシンの git ignore 対象なので commit 対象にもなっていない
- 生ダンプ (`$RUN_DIR`) は repodir 外・揮発。計測後に破棄した
- 計測中に誤って repodir を PR ブランチへ checkout したが、`main` に戻して確認済み

## 生サンプル

キー構造は無加工。値は次の方針で置換してある。

- プロンプト本文・アシスタント応答・ファイル内容・compact 要約は `<key: N chars>` に置換。120 文字を超える他の文字列は切り詰め
- セッション ID / その他の UUID / tool use ID / message ID / request ID は、出現順の安定したプレースホルダ (`<session-1>` / `<uuid-3>` など) に置換。同じ値には同じプレースホルダを当ててあるので、レコードをまたいだ同一性は読み取れる
- ホスト上の絶対パスは `<repodir>` / `<claude-home>` / `<home>` に置換

### hook イベント別 サンプル

#### ConfigChange

```json
{
 "session_id": "<session-6>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-6>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-1>",
 "hook_event_name": "ConfigChange",
 "source": "project_settings",
 "file_path": "<repodir>/.claude/settings.json"
}
```

#### CwdChanged

```json
{
 "session_id": "<session-15>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-15>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-2>",
 "hook_event_name": "CwdChanged",
 "old_cwd": "<repodir>",
 "new_cwd": "/tmp/ccx-fieldmeas"
}
```

#### DirectoryAdded

```json
{
 "session_id": "<session-6>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-6>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-3>",
 "hook_event_name": "DirectoryAdded",
 "directory": "/tmp/ccx-fieldmeas",
 "source": "slash_command"
}
```

#### FileChanged

```json
{
 "session_id": "<session-15>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-15>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-2>",
 "hook_event_name": "FileChanged",
 "file_path": "<repodir>/measwatch.txt",
 "event": "change"
}
```

#### InstructionsLoaded

```json
{
 "session_id": "<session-14>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-14>.jsonl",
 "cwd": "<repodir>",
 "hook_event_name": "InstructionsLoaded",
 "file_path": "<claude-home>/CLAUDE.md",
 "memory_type": "User",
 "load_reason": "session_start"
}
```

#### MessageDisplay

```json
{
 "session_id": "<session-14>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-14>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-4>",
 "hook_event_name": "MessageDisplay",
 "turn_id": "<uuid-5>",
 "message_id": "<uuid-6>",
 "index": 0,
 "final": true,
 "delta": "DONE"
}
```

#### Notification

```json
{
 "session_id": "<session-1>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-1>.jsonl",
 "cwd": "<repodir>",
 "hook_event_name": "Notification",
 "message": "<message: 32 chars>",
 "notification_type": "idle_prompt"
}
```

#### PermissionRequest

```json
{
 "session_id": "<session-11>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-11>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-7>",
 "permission_mode": "default",
 "agent_type": "general-purpose",
 "effort": {
  "level": "high"
 },
 "hook_event_name": "PermissionRequest",
 "tool_name": "Write",
 "tool_input": {
  "file_path": "/var/tmp/permtest-marker.txt",
  "content": "hello"
 },
 "permission_suggestions": [
  {
   "type": "setMode",
   "mode": "acceptEdits",
   "destination": "session"
  },
  {
   "type": "addDirectories",
   "directories": [
    "/var/tmp"
   ],
   "destination": "session"
  }
 ]
}
```

#### PostCompact

```json
{
 "session_id": "<session-6>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-6>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-1>",
 "hook_event_name": "PostCompact",
 "trigger": "manual",
 "compact_summary": "<compact_summary: 6742 chars>"
}
```

#### PostToolBatch

```json
{
 "session_id": "<session-5>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-5>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-8>",
 "permission_mode": "auto",
 "effort": {
  "level": "high"
 },
 "hook_event_name": "PostToolBatch",
 "tool_calls": [
  {
   "tool_name": "ToolSearch",
   "tool_input": {
    "query": "select:TaskCreate,TaskUpdate",
    "max_results": 5
   },
   "tool_use_id": "<tooluse-1>",
   "tool_response": "<tool_response: 32 chars>"
  }
 ]
}
```

#### PostToolUse

```json
{
 "session_id": "<session-5>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-5>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-8>",
 "permission_mode": "auto",
 "effort": {
  "level": "high"
 },
 "hook_event_name": "PostToolUse",
 "tool_name": "ToolSearch",
 "tool_input": {
  "query": "select:TaskCreate,TaskUpdate",
  "max_results": 5
 },
 "tool_response": {
  "matches": [],
  "query": "select:TaskCreate,TaskUpdate",
  "total_deferred_tools": 78
 },
 "tool_use_id": "<tooluse-1>",
 "duration_ms": 5
}
```

#### PostToolUseFailure

```json
{
 "session_id": "<session-12>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-12>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-9>",
 "permission_mode": "bypassPermissions",
 "effort": {
  "level": "high"
 },
 "hook_event_name": "PostToolUseFailure",
 "tool_name": "Bash",
 "tool_input": {
  "command": "rtk ls /nonexistent-path-xyz",
  "description": "List a nonexistent path (expected to fail)"
 },
 "tool_use_id": "<tooluse-2>",
 "error": "<error: 80 chars>",
 "is_interrupt": false,
 "duration_ms": 198
}
```

#### PreCompact

```json
{
 "session_id": "<session-6>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-6>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-1>",
 "hook_event_name": "PreCompact",
 "trigger": "manual",
 "custom_instructions": null
}
```

#### PreToolUse

```json
{
 "session_id": "<session-5>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-5>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-8>",
 "permission_mode": "auto",
 "effort": {
  "level": "high"
 },
 "hook_event_name": "PreToolUse",
 "tool_name": "ToolSearch",
 "tool_input": {
  "query": "select:TaskCreate,TaskUpdate",
  "max_results": 5
 },
 "tool_use_id": "<tooluse-1>"
}
```

#### SessionEnd

```json
{
 "session_id": "<session-14>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-14>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-4>",
 "hook_event_name": "SessionEnd",
 "reason": "other"
}
```

#### SessionStart

```json
{
 "session_id": "<session-14>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-14>.jsonl",
 "cwd": "<repodir>",
 "hook_event_name": "SessionStart",
 "source": "startup"
}
```

#### Setup

```json
{
 "session_id": "<session-2>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-2>.jsonl",
 "cwd": "<repodir>",
 "hook_event_name": "Setup",
 "trigger": "maintenance"
}
```

#### Stop

```json
{
 "session_id": "<session-14>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-14>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-4>",
 "permission_mode": "bypassPermissions",
 "effort": {
  "level": "high"
 },
 "hook_event_name": "Stop",
 "stop_hook_active": false,
 "last_assistant_message": "DONE",
 "background_tasks": [],
 "session_crons": []
}
```

#### SubagentStart

```json
{
 "session_id": "<session-12>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-12>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-9>",
 "agent_id": "<agent-1>",
 "agent_type": "Explore",
 "hook_event_name": "SubagentStart"
}
```

#### SubagentStop

```json
{
 "session_id": "<session-6>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-6>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-1>",
 "permission_mode": "bypassPermissions",
 "agent_id": "<agent-2>",
 "agent_type": "",
 "effort": {
  "level": "high"
 },
 "hook_event_name": "SubagentStop",
 "stop_hook_active": false,
 "agent_transcript_path": "<claude-home>/projects/-root--ccx-github-com-TakashiAihara-c...<truncated 94>",
 "last_assistant_message": "<last_assistant_message: 6742 chars>",
 "background_tasks": [],
 "session_crons": []
}
```

#### UserPromptExpansion

```json
{
 "session_id": "<session-6>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-6>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-10>",
 "permission_mode": "bypassPermissions",
 "hook_event_name": "UserPromptExpansion",
 "expansion_type": "slash_command",
 "command_name": "measprobe",
 "command_args": "",
 "command_source": "projectSettings",
 "prompt": "/measprobe"
}
```

#### UserPromptSubmit

```json
{
 "session_id": "<session-14>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-14>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-4>",
 "permission_mode": "bypassPermissions",
 "hook_event_name": "UserPromptSubmit",
 "prompt": "<prompt: 32 chars>"
}
```

### statusline サンプル

#### A) first invocation of a session (before the first API response)

```json
{
 "session_id": "<session-9>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-9>.jsonl",
 "cwd": "<repodir>",
 "effort": {
  "level": "high"
 },
 "model": {
  "id": "claude-sonnet-5",
  "display_name": "Sonnet 5"
 },
 "workspace": {
  "current_dir": "<repodir>",
  "project_dir": "<repodir>",
  "added_dirs": [],
  "repo": {
   "host": "github.com",
   "owner": "TakashiAihara",
   "name": "ccx"
  }
 },
 "version": "2.1.233",
 "output_style": {
  "name": "default"
 },
 "cost": {
  "total_cost_usd": 0,
  "total_duration_ms": 1978,
  "total_api_duration_ms": 0,
  "total_lines_added": 0,
  "total_lines_removed": 0
 },
 "context_window": {
  "total_input_tokens": 0,
  "total_output_tokens": 0,
  "context_window_size": 1000000,
  "current_usage": null,
  "used_percentage": null,
  "remaining_percentage": null
 },
 "exceeds_200k_tokens": false,
 "fast_mode": false,
 "thinking": {
  "enabled": true
 }
}
```

#### B) after an API response, on a branch that has an open PR

```json
{
 "session_id": "<session-11>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-11>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-11>",
 "agent_type": "general-purpose",
 "effort": {
  "level": "high"
 },
 "session_name": "meas-two",
 "model": {
  "id": "claude-sonnet-5",
  "display_name": "Sonnet 5"
 },
 "workspace": {
  "current_dir": "<repodir>",
  "project_dir": "<repodir>",
  "added_dirs": [],
  "repo": {
   "host": "github.com",
   "owner": "TakashiAihara",
   "name": "ccx"
  }
 },
 "version": "2.1.233",
 "output_style": {
  "name": "default"
 },
 "cost": {
  "total_cost_usd": 0.7711632,
  "total_duration_ms": 335784,
  "total_api_duration_ms": 7604,
  "total_lines_added": 0,
  "total_lines_removed": 0
 },
 "context_window": {
  "total_input_tokens": 116456,
  "total_output_tokens": 85,
  "context_window_size": 1000000,
  "current_usage": {
   "input_tokens": 2,
   "output_tokens": 85,
   "cache_creation_input_tokens": 85,
   "cache_read_input_tokens": 116369
  },
  "used_percentage": 12,
  "remaining_percentage": 88
 },
 "exceeds_200k_tokens": false,
 "fast_mode": false,
 "thinking": {
  "enabled": true
 },
 "rate_limits": {
  "five_hour": {
   "used_percentage": 32,
   "resets_at": 1786984800
  },
  "seven_day": {
   "used_percentage": 14.000000000000002,
   "resets_at": 1787464800
  }
 },
 "agent": {
  "name": "general-purpose"
 },
 "pr": {
  "number": 62,
  "url": "https://github.com/TakashiAihara/ccx/pull/62",
  "review_state": "pending"
 }
}
```

### transcript サンプル

#### assistant record (message.content redacted)

```json
{
 "parentUuid": "<uuid-12>",
 "isSidechain": false,
 "message": {
  "model": "claude-opus-5",
  "id": "<msg-1>",
  "type": "message",
  "role": "assistant",
  "content": "<content: redacted>",
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "stop_details": null,
  "usage": {
   "input_tokens": 2,
   "cache_creation_input_tokens": 113354,
   "cache_read_input_tokens": 0,
   "output_tokens": 1546,
   "output_tokens_details": {
    "thinking_tokens": 1209
   },
   "server_tool_use": {
    "web_search_requests": 0,
    "web_fetch_requests": 0
   },
   "service_tier": "standard",
   "cache_creation": {
    "ephemeral_1h_input_tokens": 113354,
    "ephemeral_5m_input_tokens": 0
   },
   "inference_geo": "not_available",
   "iterations": [
    {
     "input_tokens": 2,
     "output_tokens": 1546,
     "cache_read_input_tokens": 0,
     "cache_creation_input_tokens": 113354,
     "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 113354
     },
     "type": "message"
    }
   ],
   "speed": "standard"
  },
  "diagnostics": null
 },
 "requestId": "<req-1>",
 "type": "assistant",
 "uuid": "<uuid-13>",
 "timestamp": "2026-08-17T12:54:08.936Z",
 "effort": "high",
 "session_id": "<session-13>",
 "userType": "external",
 "entrypoint": "cli",
 "cwd": "<repodir>",
 "sessionId": "<session-13>",
 "version": "2.1.233",
 "gitBranch": "main"
}
```

#### user record (message.content redacted)

```json
{
 "parentUuid": "<uuid-14>",
 "isSidechain": false,
 "promptId": "<uuid-15>",
 "type": "user",
 "message": {
  "role": "user",
  "content": "<prompt: redacted>"
 },
 "uuid": "<uuid-16>",
 "timestamp": "2026-08-17T12:53:48.561Z",
 "permissionMode": "bypassPermissions",
 "origin": {
  "kind": "human"
 },
 "promptSource": "typed",
 "userType": "external",
 "entrypoint": "cli",
 "cwd": "<repodir>",
 "sessionId": "<session-13>",
 "version": "2.1.233",
 "gitBranch": "main"
}
```

#### attachment record (payload redacted)

```json
{
 "parentUuid": null,
 "isSidechain": false,
 "attachment": {
  "type": "hook_success",
  "hookName": "SessionStart:startup",
  "toolUseID": "<uuid-17>",
  "hookEvent": "SessionStart",
  "content": "",
  "stdout": "<redacted>",
  "stderr": "",
  "exitCode": 0,
  "command": "<redacted>",
  "durationMs": 548
 },
 "type": "attachment",
 "uuid": "<uuid-18>",
 "timestamp": "2026-08-17T12:53:47.424Z",
 "userType": "external",
 "entrypoint": "cli",
 "cwd": "<repodir>",
 "sessionId": "<session-13>",
 "version": "2.1.233",
 "gitBranch": "main"
}
```

#### compact 境界 (system / subtype: compact_boundary)

```json
{
 "parentUuid": null,
 "logicalParentUuid": "<uuid-19>",
 "isSidechain": false,
 "type": "system",
 "subtype": "compact_boundary",
 "content": "Conversation compacted",
 "level": "info",
 "uuid": "<uuid-20>",
 "timestamp": "2026-08-17T13:05:52.029Z",
 "userType": "external",
 "entrypoint": "cli",
 "cwd": "<repodir>",
 "sessionId": "<session-6>",
 "version": "2.1.233",
 "gitBranch": "main",
 "slug": "glowing-beaming-hopcroft",
 "compactMetadata": {
  "trigger": "manual",
  "preTokens": 138908,
  "postTokens": 3973,
  "cumulativeDroppedTokens": 134935,
  "durationMs": 36174,
  "preservedSegment": {
   "headUuid": "<uuid-21>",
   "anchorUuid": "<uuid-22>",
   "tailUuid": "<uuid-19>"
  },
  "preservedMessages": {
   "anchorUuid": "<uuid-22>",
   "uuids": [
    "...(4 件)"
   ],
   "allUuids": [
    "...(10 件)"
   ]
  }
 }
}
```

#### subagent メタ (`<session_id>/subagents/agent-<id>.meta.json`)

```json
{"agentType":"Explore","description":"List top-level repo files","toolUseId":"<tooluse-3>","spawnDepth":1}
```

#### hook からトークンが読める唯一の経路 (Agent tool の PostToolUse)

```json
{
 "session_id": "<session-12>",
 "transcript_path": "<claude-home>/projects/<encoded-cwd>/<session-12>.jsonl",
 "cwd": "<repodir>",
 "prompt_id": "<uuid-9>",
 "permission_mode": "bypassPermissions",
 "effort": {
  "level": "high"
 },
 "hook_event_name": "PostToolUse",
 "tool_name": "Agent",
 "tool_input": {
  "description": "List top-level repo files",
  "prompt": "<prompt: redacted>",
  "subagent_type": "Explore",
  "run_in_background": false
 },
 "tool_response": {
  "status": "completed",
  "prompt": "list the top-level files of this repository and return the list",
  "agentId": "<agent-1>",
  "agentType": "Explore",
  "content": [
   {
    "type": "text",
    "text": "<subagent output: redacted>"
   }
  ],
  "resolvedModel": "claude-sonnet-5",
  "totalDurationMs": 5922,
  "totalTokens": 24929,
  "totalToolUseCount": 1,
  "usage": {
   "input_tokens": 2,
   "cache_creation_input_tokens": 433,
   "cache_read_input_tokens": 24301,
   "output_tokens": 193,
   "output_tokens_details": {
    "thinking_tokens": 0
   },
   "server_tool_use": {
    "web_search_requests": 0,
    "web_fetch_requests": 0
   },
   "service_tier": "standard",
   "cache_creation": {
    "ephemeral_1h_input_tokens": 0,
    "ephemeral_5m_input_tokens": 433
   },
   "inference_geo": "not_available",
   "speed": "standard"
  },
  "toolStats": {
   "readCount": 0,
   "searchCount": 0,
   "bashCount": 1,
   "editFileCount": 0,
   "linesAdded": 0,
   "linesRemoved": 0,
   "otherToolCount": 0
  }
 },
 "tool_use_id": "<tooluse-3>",
 "duration_ms": 5923
}
```

