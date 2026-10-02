/**
 * `ccx transcript stats` の集計 (kaneo ccx#54 / #46 の分析ビュー)。人がどれだけ介入しているかを日別に出す。
 *
 * 数え方は実 transcript (2026-10-02、197 session) で確かめた形に拠る (memory reference_transcript_record_shapes):
 * - 同じ session は 1 写しだけ読む。resume した session は別の machine からも push され、後の写しが前の写しを含む
 *   (3 件)。行数の多い写しを取る。fork は親の記録を同じ uuid・同じ時刻のまま新しい session に写すので、uuid ごとに 1 件だけ残す。
 *   どちらの session に付くかは決められない (時刻が同じ) が、日別の合計は変わらない
 * - 手入力 = subagent (isSidechain) でも meta でも compact の要約でもない user 記録のうち、`origin.kind = human` のもの。
 *   origin が無い古い版だけ、本文が文字列で `<` で始まらないものとする。人が打った slash command も数える
 * - ターン途中に打った入力は `queue-operation` の enqueue にだけ出て、user 記録にならないことがある。それも手入力に数える。
 *   user 記録になった分 (同じ session・同じ本文で、enqueue から 1 時間以内。実測の最大は 18 分) は二重に数えない。
 *   次の操作が popAll の enqueue は入力欄に戻されたもので、打ち直した方を数える。1 秒以内に dequeue された enqueue は
 *   AI が待っているところへ打った普通の入力 (実測 57 件) なので割り込みに数えない。
 *   hook が入れる文 (`[Cross-session idle notice]` 等、372 件中 10 件) は origin を持たず見分けられないので、手入力に入っている
 * - 1 回の指示 (turn) = 人の入力から次の人の入力まで。通知・channel・hook の返しで AI が続けた作業も、その指示の作業に含める。
 *   自走時間は AI が実際に動いた時間で、turn の中の区切り (人の入力・通知・channel ごと) の始まりからその区切りの最後の応答までの和。
 *   通知や人の答えを待っていた空き時間は入れない (入れると夜通し待った通知で 2.5 日の turn になる)。区切りには enqueue と
 *   AskUserQuestion の答えも含め、合成の応答 (model `<synthetic>`) は応答に数えない。tool 数も 1 turn が数千を持つので中央値を取る。
 *   待ち時間は前の指示の最後の応答から人の入力まで (同じ session の中だけ)。
 *   heartbeat への "." の返事は応答に数えない (数えると待ち時間が heartbeat の間隔で切れる)。
 *   6 時間を超える待ちは席を外していたとみなし、中央値に入れない (claude-idle-reaper の既定と同じ)
 * - Esc 中断は本文が `[Request interrupted by user]` のもの。`… for tool use` は、直前 5 秒に人の拒否があればその付随記録 (rejected と
 *   重なる、20 件中 14 件) で、無ければ tool の実行中に押した Esc なので数える
 * - 拒否は `toolDenialKind`: `user-rejected` は人が断ったもの、`permission-rule` は hook か設定の規則が止めたもの。
 *   `interrupted` (session の終了) と `cancelled` は介入ではないので数えない。許可を求められて人が通したものは記録に無い
 * - subagent の transcript は読まない (保存先の transcript.jsonl は親だけ)
 * - 中央値は秒に直してから取る。INTERVAL の median は離散 (下側) の値を返し、2 件なら短い方になる
 *
 * `->>` は `=` / `AND` より結合が弱く、括弧が無いと `json ->> ('a' = …)` と読まれて落ちるので、全部括弧で包む
 */
export function interactionSql(timeZone: string): string {
  const tz = `'${timeZone.replaceAll("'", "''")}'`;
  return `
WITH copies AS (SELECT session_id, machine, count(*) AS n FROM lines GROUP BY ALL),
pick AS (SELECT session_id, arg_max(machine, n) AS machine FROM copies GROUP BY 1),
r0 AS (
  SELECT session_id, machine, (json->>'type') AS type, ((json->>'timestamp'))::TIMESTAMPTZ AS ts, (json->>'uuid') AS uuid,
    json_type((json->'$.message.content')) AS ct, (json->>'$.message.content') AS c,
    coalesce((json->>'isMeta'), 'false') = 'true' AS meta, json
  FROM lines JOIN pick USING (session_id, machine)
  WHERE coalesce((json->>'isSidechain'), 'false') <> 'true'
),

-- ponytail: fork の写しのうち uuid を持たない記録 (queue-operation) は重複のまま残る。fork が増えたら写しの範囲で落とす
r AS (
  SELECT * FROM r0
  QUALIFY uuid IS NULL OR row_number() OVER (PARTITION BY uuid ORDER BY session_id) = 1
),
-- AskUserQuestion の答えは人の入力。待っている間を AI の自走に数えないよう、答えも区切りの始まりにする (203 件、答えまで最長 79 時間)
asked AS (
  SELECT DISTINCT (b->>'id') AS id FROM (SELECT unnest(json_extract(json, '$.message.content[*]')) AS b FROM r WHERE type = 'assistant')
  WHERE (b->>'type') = 'tool_use' AND (b->>'name') = 'AskUserQuestion'
),
q AS (
  SELECT session_id, ts, (json->>'operation') AS op, (json->>'content') AS qc,
    lead((json->>'operation')) OVER (PARTITION BY session_id ORDER BY ts) AS next_op,
    lead(ts) OVER (PARTITION BY session_id ORDER BY ts) - ts AS next_after
  FROM r WHERE type = 'queue-operation'
),
ev AS (
  SELECT session_id, machine, ts,
    type = 'user' AND NOT meta AND coalesce((json->>'isCompactSummary'), 'false') <> 'true'
      AND CASE WHEN (json->>'$.origin.kind') IS NOT NULL THEN (json->>'$.origin.kind') = 'human'
               ELSE ct = 'VARCHAR' AND NOT starts_with(ltrim(c, ' ' || chr(10)), '<') END AS prompt,
    -- 待っている AI への通知・別 session のメッセージは user 記録にならず enqueue だけで届くことがある (空白の後の記録の 757 件)
    (type = 'user' AND ct = 'VARCHAR') OR (type = 'queue-operation' AND (json->>'operation') = 'enqueue')
      OR (type = 'user' AND (json->>'$.message.content[0].tool_use_id') IN (SELECT id FROM asked)) AS boundary,
    type = 'user' AND meta AND contains(coalesce(c, ''), ' kind="heartbeat"') AS heartbeat,
    type = 'user' AND (json->>'$.message.content[0].text') = '[Request interrupted by user]' AS interrupt,
    type = 'user' AND (json->>'$.message.content[0].text') = '[Request interrupted by user for tool use]' AS interrupt_tool,
    (json->>'toolDenialKind') = 'user-rejected' AS rejected,
    (json->>'toolDenialKind') = 'permission-rule' AS rule_denied,
    -- '<synthetic>' は Claude Code が合成した応答 (API エラー / 日を置いて開き直したときの "No response requested.")。AI は動いていない
    type = 'assistant' AND coalesce((json->>'isApiErrorMessage'), 'false') <> 'true' AND coalesce((json->>'$.message.model'), '') <> '<synthetic>' AS reply,
    CASE WHEN type = 'assistant' AND coalesce((json->>'isApiErrorMessage'), 'false') <> 'true'
      THEN coalesce(len(list_filter(json_extract_string(json, '$.message.content[*].type'), lambda t: t = 'tool_use')), 0) ELSE 0 END AS tools,
    c
  FROM r
),
queued AS (
  SELECT session_id, ts, NOT EXISTS (
      SELECT 1 FROM ev u WHERE u.prompt AND u.session_id = q.session_id AND u.c = q.qc AND u.ts >= q.ts AND u.ts < q.ts + INTERVAL 1 HOUR
    ) AS unmatched
  FROM q WHERE op = 'enqueue' AND coalesce(next_op, '') <> 'popAll'
    AND NOT (coalesce(next_op, '') = 'dequeue' AND next_after < INTERVAL 1 SECOND) AND NOT starts_with(ltrim(coalesce(qc, '<'), ' ' || chr(10)), '<')
),
-- 同じ時刻の記録は、turn を始める記録を先に置く (順序を決めないと turn の割り当てが実行ごとに揺れる)
seq AS (
  SELECT *,
    sum((boundary OR prompt)::INT) OVER w AS seg,
    sum(prompt::INT) OVER w AS turn
  FROM ev WINDOW w AS (PARTITION BY session_id ORDER BY ts, (boundary OR prompt) DESC, prompt DESC ROWS UNBOUNDED PRECEDING)
),
segs AS (SELECT *, bool_or(heartbeat) OVER (PARTITION BY session_id, seg) AS in_heartbeat FROM seq),
worked AS (
  SELECT session_id, turn, seg, min(ts) AS seg_start, max(ts) FILTER (WHERE reply AND NOT in_heartbeat) AS seg_end, sum(tools) AS tools
  FROM segs GROUP BY ALL
),
turns AS (
  SELECT session_id, turn, min(seg_start) AS started, max(seg_end) AS ended,
    sum(epoch(seg_end - seg_start)) AS ran, sum(tools) AS tools
  FROM worked GROUP BY ALL
),
paced AS (
  SELECT *, started - max(ended) OVER (PARTITION BY session_id ORDER BY turn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS waited
  FROM turns
),
by_turn AS (
  SELECT (started AT TIME ZONE ${tz})::DATE AS day, count(*) AS turns,
    median(tools) AS tools_per_turn,
    round(median(coalesce(ran, 0)) / 60, 1) AS run_min_p50,
    round(median(epoch(waited)) FILTER (WHERE waited <= INTERVAL 6 HOUR) / 60, 1) AS wait_min_p50
  FROM paced WHERE turn > 0 GROUP BY 1
),
by_queue AS (
  SELECT (ts AT TIME ZONE ${tz})::DATE AS day, count(*) AS queued, count(*) FILTER (WHERE unmatched) AS queued_only FROM queued GROUP BY 1
),
by_mark AS (
  SELECT (ts AT TIME ZONE ${tz})::DATE AS day,
    count(*) FILTER (WHERE interrupt OR (interrupt_tool AND NOT EXISTS (
      SELECT 1 FROM ev x WHERE x.rejected AND x.session_id = ev.session_id AND x.ts BETWEEN ev.ts - INTERVAL 5 SECOND AND ev.ts
    ))) AS interrupts, count(*) FILTER (WHERE rejected) AS rejected,
    count(*) FILTER (WHERE rule_denied) AS rule_denied,
    count(DISTINCT session_id) FILTER (WHERE prompt OR interrupt OR rejected) AS sessions,
    count(DISTINCT machine) AS machines
  FROM ev GROUP BY 1
),
span AS (SELECT unnest(range(min(day), max(day) + INTERVAL 1 DAY, INTERVAL 1 DAY))::DATE AS day FROM by_mark)
SELECT strftime(day, '%Y-%m-%d') AS day,
  (coalesce(turns, 0) + coalesce(queued_only, 0))::INT AS prompts, coalesce(queued, 0)::INT AS queued,
  coalesce(interrupts, 0)::INT AS interrupts, coalesce(rejected, 0)::INT AS rejected, coalesce(rule_denied, 0)::INT AS rule_denied,
  coalesce(turns, 0)::INT AS turns, tools_per_turn, run_min_p50, wait_min_p50,
  coalesce(sessions, 0)::INT AS sessions, coalesce(machines, 0)::INT AS machines
FROM span LEFT JOIN by_turn USING (day) LEFT JOIN by_queue USING (day) LEFT JOIN by_mark USING (day)
ORDER BY day DESC`;
}
