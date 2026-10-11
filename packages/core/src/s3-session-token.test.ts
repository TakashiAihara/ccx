import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * 手元の AWS の一時資格情報を center に送らない (#213)。Bun は S3Client を作った時点ではなく
 * プロセス起動時の env から AWS_SESSION_TOKEN / S3_SESSION_TOKEN を読むので、env を持たせた
 * 子プロセスで TranscriptClient を動かし、center 役のサーバが受けたヘッダを見る。
 */
test("the store client does not send the env's AWS / S3 session token (#213)", async () => {
  const seen: (string | null)[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push(req.headers.get("x-amz-security-token"));
      return new Response(null, { status: 404 });
    },
  });
  try {
    const script = `
      import { TranscriptClient } from ${JSON.stringify(join(import.meta.dir, "transcript.ts"))};
      const c = new TranscriptClient({ endpoint: "http://127.0.0.1:${server.port}", bucket: "ccx", prefix: "" }, { machine: "m", user: "u" });
      await c.inStore("00000000-0000-4000-8000-000000000000");
    `;
    for (const name of ["AWS_SESSION_TOKEN", "S3_SESSION_TOKEN"]) {
      const p = Bun.spawn(["bun", "-e", script], { env: { ...process.env, [name]: "LEAKED-TOKEN" }, stdout: "ignore", stderr: "pipe" });
      expect(await p.exited).toBe(0);
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.filter((v) => v?.includes("LEAKED-TOKEN"))).toEqual([]);
  } finally {
    server.stop(true);
  }
});
