/**
 * パース境界。ccxd が不透明なバイト列として運んできた payload を、ここで初めて
 * 解釈する。
 *
 * ここが center 側にあることの意味は ingest.proto に書いてある。要点だけ言うと、
 * ccxd は他人のマシンで動く単一バイナリでこちらから直せないが、center のパーサは
 * 直せて、生バイトは常に残っているので後から読み直せる。だからパースは全部ここ。
 *
 * 方針は 1 つ。**読めなくても捨てない。** 読めなかった event も行として残し、
 * parsed=false で印を付ける。捨ててしまうと「パーサが壊れている」と「その event が
 * 来ていない」が区別できなくなる — この repo が何度も踏んだ「観測の不在を対象の
 * 不在と読む」形そのものになる。
 */

export type Derived = {
  /** payload が JSON オブジェクトとして読めたか。 */
  parsed: boolean;
  sessionId: string;
  hookEventName: string;
  cwd: string;
  transcriptPath: string;
};

const EMPTY: Derived = {
  parsed: false,
  sessionId: "",
  hookEventName: "",
  cwd: "",
  transcriptPath: "",
};

/**
 * 文字列のキーだけを拾う。数値やオブジェクトが入っていたら「無かった」として扱い、
 * String() で潰さない。潰すと `[object Object]` のような値が session_id として
 * 保存され、実在しない session が一覧に出る。
 */
function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

export function derive(payload: Uint8Array): Derived {
  let text: string;
  try {
    // fatal: true にしないと不正なバイト列が U+FFFD に置換されて「読めた」ことに
    // なる。読めないものは読めないと言う。
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return EMPTY;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return EMPTY;
  }

  // 配列・数値・文字列・null はオブジェクトではない。hook payload は必ず
  // オブジェクトなので、そうでないものは読めなかったものとして扱う。
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return EMPTY;
  }

  const o = value as Record<string, unknown>;
  return {
    parsed: true,
    sessionId: str(o, "session_id"),
    hookEventName: str(o, "hook_event_name"),
    cwd: str(o, "cwd"),
    transcriptPath: str(o, "transcript_path"),
  };
}
