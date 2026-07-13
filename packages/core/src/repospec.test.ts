import { describe, expect, test } from "bun:test";

import { cloneUrl, parseRepoSpec, specToSlug } from "./repospec.ts";

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
});
