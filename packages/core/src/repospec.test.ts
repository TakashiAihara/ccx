import { describe, expect, test } from "bun:test";

import { cloneUrl, explicitCloneUrl, parseProtocol, parseRepoSpec, specToSlug } from "./repospec.ts";

const opts = { defaultHost: "github.com", defaultOwner: "TakashiAihara" };

describe("parseRepoSpec", () => {
  test.each([
    ["https://github.com/micoworks/delivery-foundation", "github.com/micoworks/delivery-foundation"],
    ["https://github.com/micoworks/delivery-foundation.git", "github.com/micoworks/delivery-foundation"],
    ["git@github.com:micoworks/delivery-foundation.git", "github.com/micoworks/delivery-foundation"],
    ["ssh://git@github.com/micoworks/delivery-foundation.git", "github.com/micoworks/delivery-foundation"],
    ["github.com/micoworks/delivery-foundation", "github.com/micoworks/delivery-foundation"],
    ["micoworks/delivery-foundation", "github.com/micoworks/delivery-foundation"],
    ["vault", "github.com/TakashiAihara/vault"],
  ])("%s → %s", (input, expected) => {
    expect(specToSlug(parseRepoSpec(input, opts))).toBe(expected);
  });

  test("自ホスト以外も host 階層で表現できる", () => {
    expect(specToSlug(parseRepoSpec("gitlab.example.com/team/app", opts)))
      .toBe("gitlab.example.com/team/app");
  });

  test("nested owner (GitLab subgroup) は最後の要素を repo とする", () => {
    const spec = parseRepoSpec("https://gitlab.com/group/sub/app.git", opts);
    expect(spec).toEqual({ host: "gitlab.com", owner: "group/sub", repo: "app" });
  });

  test("defaultOwner 未設定で bare repo 名だけ渡すと、理由を添えて失敗する", () => {
    expect(() => parseRepoSpec("vault", { defaultHost: "github.com" }))
      .toThrow(/defaultOwner/);
  });

  test("空文字を弾く", () => {
    expect(() => parseRepoSpec("  ", opts)).toThrow();
  });

  test("clone URL を組み立てる", () => {
    expect(cloneUrl(parseRepoSpec("micoworks/lepus-short-link", opts)))
      .toBe("https://github.com/micoworks/lepus-short-link.git");
  });

  test("protocol に ssh を指定すると scp-like URL になる", () => {
    expect(cloneUrl(parseRepoSpec("micoworks/lepus-short-link", opts), "ssh"))
      .toBe("git@github.com:micoworks/lepus-short-link.git");
  });

  test("nested owner (GitLab subgroup) でも ssh URL が壊れない", () => {
    const s = parseRepoSpec("gitlab.example.com/group/sub/repo", opts);
    expect(cloneUrl(s, "ssh")).toBe("git@gitlab.example.com:group/sub/repo.git");
    expect(cloneUrl(s, "https")).toBe("https://gitlab.example.com/group/sub/repo.git");
  });

  test("ssh URL を入力に渡しても、同じ spec に正規化される (往復する)", () => {
    const s = parseRepoSpec("git@github.com:micoworks/lepus-short-link.git", opts);
    expect(cloneUrl(s, "ssh")).toBe("git@github.com:micoworks/lepus-short-link.git");
  });

  test("http(s) はポートまでが host、ssh のポートは host に入れない (#215)", () => {
    expect(parseRepoSpec("http://localhost:13000/o/app.git", opts).host).toBe("localhost:13000");
    expect(parseRepoSpec("https://forge.example:8443/o/app", opts).host).toBe("forge.example:8443");
    expect(parseRepoSpec("https://forge.example:443/o/app", opts).host).toBe("forge.example");
    expect(parseRepoSpec("ssh://git@forge.example:2222/o/app.git", opts).host).toBe("forge.example");
  });

  test("組み立てでは表せない URL (http / ポート付き) だけを明示の clone URL とする (#215)", () => {
    expect(explicitCloneUrl("http://localhost:13000/o/app.git")).toBe("http://localhost:13000/o/app.git");
    expect(explicitCloneUrl("http://forge.example/o/app")).toBe("http://forge.example/o/app");
    expect(explicitCloneUrl("https://forge.example:8443/o/app")).toBe("https://forge.example:8443/o/app");
    expect(explicitCloneUrl("ssh://git@forge.example:2222/o/app.git")).toBe("ssh://git@forge.example:2222/o/app.git");
    expect(explicitCloneUrl("http://me:secret@localhost:13000/o/app.git")).toBe("http://localhost:13000/o/app.git");
    expect(explicitCloneUrl("ssh://git:pw@forge.example:2222/o/app.git")).toBe("ssh://git@forge.example:2222/o/app.git");
    expect(explicitCloneUrl("https://github.com/o/app")).toBeUndefined();
    expect(explicitCloneUrl("localhost:13000/o/app")).toBeUndefined();
    expect(explicitCloneUrl("o/app")).toBeUndefined();
  });

  test("protocol の既定は https", () => {
    expect(cloneUrl(parseRepoSpec("owner/repo", opts))).toStartWith("https://");
  });

  test("protocol をパースする。未知の値は理由を添えて弾く", () => {
    expect(parseProtocol("ssh")).toBe("ssh");
    expect(parseProtocol("HTTPS")).toBe("https");
    expect(parseProtocol(" ssh ")).toBe("ssh");
    expect(() => parseProtocol("git")).toThrow(/invalid protocol/);
    expect(() => parseProtocol("")).toThrow(/invalid protocol/);
  });
});
