/**
 * `ccx transcript stats` の集計 (kaneo ccx#54 / #46 の分析ビュー)。人がどれだけ介入しているかを日別に出す。
 *
 * 数え方は実 transcript (2026-10-02、197 session) で確かめた形に拠る (memory reference_transcript_record_shapes):
 * - 手入力 = isMeta でも subagent (isSidechain) でもない `type: user` で、本文が文字列かつ `<` で始まらないもの
 *   (tool_result の配列 / slash command / channel / task-notification を除く)。
 *   ターン途中に打った入力は `queue-operation` の enqueue にだけ出て、user 記録にならないことがある (412 件中 307 件)。
 *   それも手入力に数え、user 記録になった分は二重に数えない
 * - turn = 文字列本文の user 記録 (人でも通知でも) から次のそれまで。自走時間はその間の最後の assistant まで、
 *   待ち時間は前の turn の最後の assistant から人の入力まで (同じ session の中だけ。session をまたぐ空白は数えない)
 * - 拒否は `toolDenialKind`: `user-rejected` は人が止めたもの、`permission-rule` は hook / 設定が止めたもの
 * - 中央値は秒に直してから取る。INTERVAL の median は離散 (下側) の値を返し、2 件なら短い方になる
 *
 * `->>` は `=` / `AND` より結合が弱く、括弧が無いと `json ->> ('a' = …)` と読まれて落ちるので、全部括弧で包む
 */
export function interactionSql(timeZone: string): string {
  const tz = `'${timeZone.replaceAll("'", "''")}'`;
  return `
WITH r AS (
  SELECT session_id, (json->>'type') AS type, ((json->>'timestamp'))::TIMESTAMPTZ AS ts,
    json_type((json->'$.message.content')) AS ct, (json->>'$.message.content') AS c,
    coalesce((json->>'isMeta'), 'false') = 'true' AS meta, json
  FROM lines
  WHERE coalesce((json->>'isSidechain'), 'false') <> 'true' AND (json->>'timestamp') IS NOT NULL
),
ev AS (
  SELECT session_id, ts,
    type = 'user' AND NOT meta AND ct = 'VARCHAR' AND NOT starts_with(ltrim(c), '<') AS prompt,
    type = 'user' AND ct = 'VARCHAR' AS boundary,
    type = 'queue-operation' AND (json->>'operation') = 'enqueue' AND NOT starts_with(ltrim(coalesce((json->>'content'), '<')), '<') AS queued,
    type = 'user' AND starts_with(coalesce((json->>'$.message.content[0].text'), ''), '[Request interrupted') AS interrupt,
    (json->>'toolDenialKind') = 'user-rejected' AS rejected,
    (json->>'toolDenialKind') = 'permission-rule' AS gated,
    CASE WHEN type = 'assistant' AND coalesce((json->>'isApiErrorMessage'), 'false') <> 'true'
      THEN len(list_filter(json_extract_string(json, '$.message.content[*].type'), t -> t = 'tool_use')) ELSE 0 END AS tools,
    type = 'assistant' AS reply,
    (json->>'content') AS qc
  FROM r
),
typed AS (SELECT DISTINCT session_id, c FROM r WHERE type = 'user' AND ct = 'VARCHAR'),
turned AS (
  SELECT *, sum(boundary::INT) OVER (PARTITION BY session_id ORDER BY ts ROWS UNBOUNDED PRECEDING) AS turn FROM ev
),
turns AS (
  SELECT session_id, turn, bool_or(prompt) AS human,
    min(ts) FILTER (WHERE boundary) AS started, max(ts) FILTER (WHERE reply) AS ended, sum(tools) AS tools
  FROM turned GROUP BY ALL
),
paced AS (
  SELECT *, started - lag(ended) OVER (PARTITION BY session_id ORDER BY turn) AS waited FROM turns
),
days AS (
  SELECT strftime(started AT TIME ZONE ${tz}, '%Y-%m-%d') AS day, count(*) AS turns, count(DISTINCT session_id) AS sessions,
    round(sum(tools) / count(*), 1) AS tools_per_prompt,
    round(median(epoch(ended - started)) / 60, 1) AS run_min_p50,
    round(median(epoch(waited)) / 60, 1) AS wait_min_p50
  FROM paced WHERE human AND started IS NOT NULL GROUP BY 1
),
marks AS (
  SELECT strftime(ts AT TIME ZONE ${tz}, '%Y-%m-%d') AS day,
    count(*) FILTER (WHERE queued) AS queued,
    count(*) FILTER (WHERE queued AND NOT EXISTS (SELECT 1 FROM typed t WHERE t.session_id = ev.session_id AND t.c = ev.qc)) AS queued_only,
    count(*) FILTER (WHERE interrupt) AS interrupts,
    count(*) FILTER (WHERE rejected) AS rejected,
    count(*) FILTER (WHERE gated) AS gated
  FROM ev GROUP BY 1
)
SELECT day, coalesce(turns, 0) + coalesce(queued_only, 0) AS prompts, coalesce(queued, 0) AS queued,
  coalesce(interrupts, 0) AS interrupts, coalesce(rejected, 0) AS rejected, coalesce(gated, 0) AS gated,
  coalesce(sessions, 0) AS sessions, tools_per_prompt, run_min_p50, wait_min_p50
FROM days FULL JOIN marks USING (day)
WHERE coalesce(turns, 0) + coalesce(queued_only, 0) + coalesce(interrupts, 0) + coalesce(rejected, 0) + coalesce(gated, 0) > 0
ORDER BY day DESC`;
}
