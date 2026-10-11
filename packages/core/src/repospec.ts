/**
 * repo の指定を <host>/<owner>/<repo> に正規化する。
 *
 * 受け付ける形:
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 *   github.com/owner/repo
 *   owner/repo            → defaultHost で補完
 *   repo                  → defaultHost + defaultOwner で補完
 */

export type RepoSpec = {
  host: string;
  owner: string;
  repo: string;
};

export type ResolveOptions = {
  defaultHost: string;
  defaultOwner?: string;
};

const strip = (s: string) => s.replace(/\.git$/, "").replace(/\/+$/, "");

export function parseRepoSpec(input: string, opts: ResolveOptions): RepoSpec {
  const raw = input.trim();
  if (!raw) throw new Error("repository is required");

  // scp-like: git@host:owner/repo
  const scp = raw.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (scp) {
    const [, host, path] = scp;
    return fromPath(strip(path!), host!);
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = new URL(raw);
    // http(s) はポートまでが forge の識別 (同じ host の別ポートは別の forge)。ssh のポートは経路なので
    // host に入れない (#215)。ssh と http を同じ場所に置けるのは http が既定ポート (443 / 80。URL が落とす)
    // のときだけで、http が別ポートの forge は ssh と http で別の repo として扱われる
    const host = /^https?:$/i.test(url.protocol) ? url.host : url.hostname;
    return fromPath(strip(url.pathname.replace(/^\//, "")), host);
  }

  const parts = strip(raw).split("/").filter(Boolean);

  if (parts.length >= 3) return fromPath(parts.slice(1).join("/"), parts[0]!);
  if (parts.length === 2) return { host: opts.defaultHost, owner: parts[0]!, repo: parts[1]! };

  if (parts.length === 1) {
    if (!opts.defaultOwner) {
      throw new Error(
        `cannot resolve owner for "${raw}": set defaultOwner in config, or pass <owner>/<repo>`,
      );
    }
    return { host: opts.defaultHost, owner: opts.defaultOwner, repo: parts[0]! };
  }

  throw new Error(`cannot parse repository: ${input}`);
}

function fromPath(path: string, host: string): RepoSpec {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`cannot parse repository path: ${path}`);
  // owner が nested (GitLab subgroup 等) の場合は最後を repo、残りを owner とする
  const repo = parts.at(-1)!;
  const owner = parts.slice(0, -1).join("/");
  return { host, owner, repo };
}

export const specToSlug = (s: RepoSpec) => `${s.host}/${s.owner}/${s.repo}`;

/**
 * clone に使う protocol。https しか無いと SSH のみのフォージで使えない。
 *
 * ssh 側は scp-like (git@host:owner/repo.git) を採る。ssh://git@host/owner/repo.git でも
 * 等価だが、フォージが UI に出す文字列は scp-like が多く、git の設定 (insteadOf 等) も
 * この形を前提に書かれていることが多いため、見慣れた形に合わせる。
 */
export type Protocol = "https" | "ssh";

export const PROTOCOLS: readonly Protocol[] = ["https", "ssh"];

export function parseProtocol(v: string): Protocol {
  const p = v.trim().toLowerCase();
  if (p === "https" || p === "ssh") return p;
  throw new Error(`invalid protocol: ${v} (expected ${PROTOCOLS.join(" or ")})`);
}

/**
 * 入力が、組み立てた clone URL では表せない URL (http、またはポート付き) なら、それを返す。
 * repodir new はそれを mirror の origin にする (#215)。https / ssh の既定ポートの URL は
 * 組み立てで足りるので返さない (protocol の設定が効く)。認証情報は落とす: origin は
 * .git/config と警告文に残る。ssh のユーザ名 (git@) は認証情報ではなく接続先の一部なので残す
 */
export function explicitCloneUrl(input: string): string | undefined {
  const raw = input.trim();
  if (!/^(https?|ssh):\/\//i.test(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.port === "") return undefined;
  url.password = "";
  if (url.protocol !== "ssh:") url.username = "";
  return url.href;
}

/**
 * ssh のユーザ名は git 固定。GitHub / GitLab / Bitbucket / Gitea いずれも git であり、
 * 例外的なフォージは ~/.ssh/config か git の insteadOf で吸収できる (ccx 側で持つと
 * 設定キーが増えるだけで、git 側の既存の仕組みと二重管理になる)。
 */
export function cloneUrl(s: RepoSpec, protocol: Protocol = "https"): string {
  return protocol === "ssh"
    ? `git@${s.host}:${s.owner}/${s.repo}.git`
    : `https://${s.host}/${s.owner}/${s.repo}.git`;
}
