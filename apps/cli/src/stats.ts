/**
 * `ccx transcript stats` の集計 (kaneo ccx#54 / #46 の分析ビュー)。人がどれだけ介入しているかを日別に出す。
 *
 * 数え方は実 transcript (2026-10-02、197 session) で確かめた形に拠る (memory reference_transcript_record_shapes):
 * - 同じ session は 1 写しだけ読む。resume した session は別の machine からも push され、後の写しが前の写しを含む
 *   (3 件)。行数の多い写しを取る。fork は親の記録を同じ uuid のまま新しい session に写すので、uuid は最も古い session の 1 件だけ残す
 * - 手入力 = subagent (isSidechain) でも meta でも compact の要約でもない user 記録のうち、`origin.kind = human` のもの。
 *   origin が無い古い版だけ、本文が文字列で `<` で始まらないものとする。人が打った slash command も数える
 * - ターン途中に打った入力は `queue-operation` の enqueue にだけ出て、user 記録にならないことがある。それも手入力に数える。
 *   user 記録になった分 (同じ session・同じ本文で、enqueue から 1 時間以内。実測の最大は 18 分) は二重に数えない。
 *   次の操作が popAll の enqueue は入力欄に戻されたもので、打ち直した方を数える
 * - 1 回の指示 (turn) = 人の入力から次の人の入力まで。通知・channel・hook の返しで AI が続けた作業も、その指示の作業に含める。
 *   自走時間はその間の最後の応答まで、待ち時間は前の指示の最後の応答から人の入力まで (同じ session の中だけ)。
 *   heartbeat への "." の返事は応答に数えない (数えると待ち時間が heartbeat の間隔で切れる)。
 *   6 時間を超える待ちは席を外していたとみなし、中央値に入れない (claude-idle-reaper の既定と同じ)
 * - Esc 中断は本文が `[Request interrupted by user]` ちょうどのもの。`… for tool use` は tool を断ったときの付随記録で、rejected と重なる
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
born AS (SELECT session_id, min(ts) AS t0 FROM r0 GROUP BY 1),
-- ponytail: fork の写しのうち uuid を持たない記録 (queue-operation) は重複のまま残る。fork が増えたら写しの範囲で落とす
r AS (
  SELECT r0.* FROM r0 JOIN born USING (session_id)
  QUALIFY uuid IS NULL OR row_number() OVER (PARTITION BY uuid ORDER BY t0, session_id) = 1
),
q AS (
  SELECT session_id, ts, (json->>'operation') AS op, (json->>'content') AS qc,
    lead((json->>'operation')) OVER (PARTITION BY session_id ORDER BY ts) AS next_op
  FROM r WHERE type = 'queue-operation'
),
ev AS (
  SELECT session_id, machine, ts,
    type = 'user' AND NOT meta AND coalesce((json->>'isCompactSummary'), 'false') <> 'true'
      AND CASE WHEN (json->>'$.origin.kind') IS NOT NULL THEN (json->>'$.origin.kind') = 'human'
               ELSE ct = 'VARCHAR' AND NOT starts_with(ltrim(c, ' ' || chr(10)), '<') END AS prompt,
    type = 'user' AND ct = 'VARCHAR' AS boundary,
    type = 'user' AND meta AND contains(coalesce(c, ''), ' kind="heartbeat"') AS heartbeat,
    type = 'user' AND (json->>'$.message.content[0].text') = '[Request interrupted by user]' AS interrupt,
    (json->>'toolDenialKind') = 'user-rejected' AS rejected,
    (json->>'toolDenialKind') = 'permission-rule' AS rule_denied,
    type = 'assistant' AND coalesce((json->>'isApiErrorMessage'), 'false') <> 'true' AS reply,
    CASE WHEN type = 'assistant' AND coalesce((json->>'isApiErrorMessage'), 'false') <> 'true'
      THEN coalesce(len(list_filter(json_extract_string(json, '$.message.content[*].type'), t -> t = 'tool_use')), 0) ELSE 0 END AS tools,
    c
  FROM r
),
queued AS (
  SELECT session_id, ts, NOT EXISTS (
      SELECT 1 FROM ev u WHERE u.prompt AND u.session_id = q.session_id AND u.c = q.qc AND u.ts >= q.ts AND u.ts < q.ts + INTERVAL 1 HOUR
    ) AS unmatched
  FROM q WHERE op = 'enqueue' AND coalesce(next_op, '') <> 'popAll' AND NOT starts_with(ltrim(coalesce(qc, '<'), ' ' || chr(10)), '<')
),
-- 同じ時刻の記録は、turn を始める記録を先に置く (順序を決めないと turn の割り当てが実行ごとに揺れる)
seq AS (
  SELECT *,
    sum((boundary OR prompt)::INT) OVER w AS seg,
    sum(prompt::INT) OVER w AS turn
  FROM ev WINDOW w AS (PARTITION BY session_id ORDER BY ts, (boundary OR prompt) DESC, prompt DESC ROWS UNBOUNDED PRECEDING)
),
segs AS (SELECT *, bool_or(heartbeat) OVER (PARTITION BY session_id, seg) AS in_heartbeat FROM seq),
turns AS (
  SELECT session_id, turn, min(ts) FILTER (WHERE prompt) AS started,
    max(ts) FILTER (WHERE reply AND NOT in_heartbeat) AS ended, sum(tools) AS tools
  FROM segs GROUP BY ALL
),
paced AS (
  SELECT *, started - max(ended) OVER (PARTITION BY session_id ORDER BY turn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS waited
  FROM turns
),
by_turn AS (
  SELECT (started AT TIME ZONE ${tz})::DATE AS day, count(*) AS turns,
    round(sum(tools) / count(*), 1) AS tools_per_turn,
    round(median(epoch(ended - started)) / 60, 1) AS run_min_p50,
    round(median(epoch(waited)) FILTER (WHERE waited <= INTERVAL 6 HOUR) / 60, 1) AS wait_min_p50
  FROM paced WHERE turn > 0 AND started IS NOT NULL GROUP BY 1
),
by_queue AS (
  SELECT (ts AT TIME ZONE ${tz})::DATE AS day, count(*) AS queued, count(*) FILTER (WHERE unmatched) AS queued_only FROM queued GROUP BY 1
),
by_mark AS (
  SELECT (ts AT TIME ZONE ${tz})::DATE AS day,
    count(*) FILTER (WHERE interrupt) AS interrupts, count(*) FILTER (WHERE rejected) AS rejected,
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
