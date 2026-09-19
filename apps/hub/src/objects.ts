import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Context, Hono } from "hono";

/**
 * S3 互換の object API。center が transcript の保存先そのものになるためのもの (#121)。
 *
 * S3 の API 表面に合わせるのは、読む側を center に縛らないため。`ccx transcript` も
 * DuckDB の httpfs も既製の S3 クライアントで、center を向けても外部の S3 互換
 * サービスを向けても同じコードで動く。center は「どこにでもある S3」の 1 つに
 * 過ぎず、center が居なければ利用者は自分の bucket を指せばよい。
 *
 * 実装しているのは transcript の push / pull / 検索が実際に使う範囲だけ:
 * PUT / GET (Range) / HEAD / DELETE / ListObjectsV2 / multipart upload。
 * bucket は暗黙に存在する (CreateBucket を要求すると、どのクライアントも
 * 最初の 1 回で止まる)。versioning / ACL / 署名の検証は無い。認証は center 全体で
 * 持つべきもので (今は無い、README「非 loopback bind は既定で拒む」)、ここだけ
 * 先に持たせても穴が 1 つ減るだけで塞がらない。
 *
 * 置き場所は <root>/<bucket>/<key>。key の `/` はそのままディレクトリになるので、
 * 利用者は center を止めて `ls` するだけで何があるか分かる。
 */

const MAX_KEYS_DEFAULT = 1000;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,62}$/;

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function xmlError(status: number, code: string, message: string): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`;
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

/** `..` と空セグメントを持つ key は root の外に出うるので拒む。 */
export function validKey(key: string): boolean {
  if (key === "" || key.length > 1024) return false;
  return key.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const etagOf = (buf: Uint8Array) => `"${createHash("md5").update(buf).digest("hex")}"`;

export class ObjectStore {
  constructor(readonly root: string) {}

  private objectPath(bucket: string, key: string): string {
    return join(this.root, bucket, key);
  }

  private uploadDir(uploadId: string): string {
    return join(this.root, ".multipart", uploadId);
  }

  /** 書きかけを読まれないよう、隣に書いてから rename する。 */
  async put(bucket: string, key: string, body: Uint8Array): Promise<string> {
    const path = this.objectPath(bucket, key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await Bun.write(tmp, body);
    await rename(tmp, path);
    return etagOf(body);
  }

  async head(bucket: string, key: string): Promise<{ size: number; mtime: Date; etag: string } | null> {
    const path = this.objectPath(bucket, key);
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
      // ETag は S3 では単一 PUT なら本文の md5。読み直して計算するのは、置いた
      // ときの値を別に持たない (ファイル 1 つで完結させる) ため
      const etag = etagOf(new Uint8Array(await Bun.file(path).arrayBuffer()));
      return { size: s.size, mtime: s.mtime, etag };
    } catch {
      return null;
    }
  }

  file(bucket: string, key: string) {
    return Bun.file(this.objectPath(bucket, key));
  }

  /** S3 と同じく、無い key の DELETE も成功として返す。 */
  async delete(bucket: string, key: string): Promise<void> {
    try {
      await unlink(this.objectPath(bucket, key));
    } catch {
      /* 無ければ無いでよい */
    }
  }

  /**
   * bucket 配下の key を辞書順で返す。prefix の下だけ歩く。
   * 数が効いてくるまでは index を持たない (ファイルが真実源)。
   */
  async listKeys(bucket: string, prefix: string): Promise<{ key: string; size: number; mtime: Date }[]> {
    const base = join(this.root, bucket);
    // prefix の最後の `/` までは確実にディレクトリ。そこから歩く
    const slash = prefix.lastIndexOf("/");
    const startRel = slash === -1 ? "" : prefix.slice(0, slash);
    const out: { key: string; size: number; mtime: Date }[] = [];

    const walk = async (rel: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(join(base, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) await walk(key);
        } else if (e.isFile() && key.startsWith(prefix) && !e.name.endsWith(".tmp")) {
          const s = await stat(join(base, key));
          out.push({ key, size: s.size, mtime: s.mtime });
        }
      }
    };
    await walk(startRel);
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  async createUpload(bucket: string, key: string): Promise<string> {
    const id = randomUUID();
    await mkdir(this.uploadDir(id), { recursive: true });
    await Bun.write(join(this.uploadDir(id), "meta.json"), JSON.stringify({ bucket, key }));
    return id;
  }

  async putPart(uploadId: string, n: number, body: Uint8Array): Promise<string | null> {
    const dir = this.uploadDir(uploadId);
    if (!(await Bun.file(join(dir, "meta.json")).exists())) return null;
    await Bun.write(join(dir, String(n)), body);
    return etagOf(body);
  }

  /** part を番号順に連結して object にする。part の一覧は body の XML ではなくディスクから取る (順序は番号が決める)。 */
  async completeUpload(uploadId: string): Promise<{ bucket: string; key: string; etag: string } | null> {
    const dir = this.uploadDir(uploadId);
    const metaFile = Bun.file(join(dir, "meta.json"));
    if (!(await metaFile.exists())) return null;
    const { bucket, key } = (await metaFile.json()) as { bucket: string; key: string };

    const parts = (await readdir(dir))
      .filter((n) => /^\d+$/.test(n))
      .map(Number)
      .sort((a, b) => a - b);
    const chunks: Uint8Array[] = [];
    for (const n of parts) chunks.push(new Uint8Array(await Bun.file(join(dir, String(n))).arrayBuffer()));
    const body = Buffer.concat(chunks);

    const etag = await this.put(bucket, key, body);
    await rm(dir, { recursive: true, force: true });
    return { bucket, key, etag };
  }

  async abortUpload(uploadId: string): Promise<void> {
    await rm(this.uploadDir(uploadId), { recursive: true, force: true });
  }
}

const headersOf = (h: { size: number; mtime: Date; etag: string }) => ({
  "content-length": String(h.size),
  "last-modified": h.mtime.toUTCString(),
  etag: h.etag,
  "accept-ranges": "bytes",
});

/** path-style (`/<bucket>/<key>`) の route を app に足す。Connect の route より後に呼ぶこと。 */
export function mountObjects(app: Hono, store: ObjectStore): void {
  // ListObjectsV2。bucket は暗黙に存在するので、未知の bucket も空の一覧を返す
  const list = async (c: Context, bucket: string) => {
    const q = c.req.query();
    const prefix = q.prefix ?? "";
    const delimiter = q.delimiter ?? "";
    const maxKeys = Math.min(Number(q["max-keys"] ?? MAX_KEYS_DEFAULT) || MAX_KEYS_DEFAULT, MAX_KEYS_DEFAULT);
    // continuation-token は「前のページの最後の key」をそのまま使う。不透明であればよい
    const after = q["continuation-token"] ?? q["start-after"] ?? "";

    const all = (await store.listKeys(bucket, prefix)).filter((o) => o.key > after);
    const contents: typeof all = [];
    const common = new Set<string>();
    for (const o of all) {
      if (delimiter) {
        const rest = o.key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i !== -1) {
          common.add(prefix + rest.slice(0, i + delimiter.length));
          continue;
        }
      }
      contents.push(o);
    }
    const page = contents.slice(0, maxKeys);
    const truncated = contents.length > maxKeys;
    const last = page.at(-1)?.key ?? "";

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>`,
      `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>`,
      `<IsTruncated>${truncated}</IsTruncated>`,
      truncated ? `<NextContinuationToken>${xmlEscape(last)}</NextContinuationToken>` : "",
      ...page.map(
        (o) =>
          `<Contents><Key>${xmlEscape(o.key)}</Key><Size>${o.size}</Size><LastModified>${o.mtime.toISOString()}</LastModified><StorageClass>STANDARD</StorageClass></Contents>`,
      ),
      ...[...common].sort().map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`),
      "</ListBucketResult>",
    ].join("");
    return c.body(xml, 200, { "content-type": "application/xml" });
  };

  app.get("/:bucket", (c) => {
    const bucket = c.req.param("bucket");
    if (!BUCKET.test(bucket)) return xmlError(400, "InvalidBucketName", bucket);
    return list(c, bucket);
  });

  app.on(["GET", "HEAD", "PUT", "POST", "DELETE"], "/:bucket/*", async (c) => {
    const bucket = c.req.param("bucket");
    if (!BUCKET.test(bucket)) return xmlError(400, "InvalidBucketName", bucket);
    const key = decodeURIComponent(new URL(c.req.url).pathname.slice(bucket.length + 2));
    // `GET /<bucket>/?list-type=2` — 末尾 `/` 付きで一覧を頼むクライアント (Bun.S3Client) がいる
    if (key === "" && c.req.method === "GET") return list(c, bucket);
    if (!validKey(key)) return xmlError(400, "InvalidArgument", `invalid key: ${key}`);
    const q = c.req.query();
    const method = c.req.method;

    if (method === "POST" && "uploads" in q) {
      const id = await store.createUpload(bucket, key);
      return c.body(
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        200,
        { "content-type": "application/xml" },
      );
    }
    if (method === "PUT" && q.uploadId) {
      const n = Number(q.partNumber);
      if (!Number.isInteger(n) || n < 1) return xmlError(400, "InvalidArgument", "partNumber");
      const etag = await store.putPart(q.uploadId, n, new Uint8Array(await c.req.arrayBuffer()));
      if (!etag) return xmlError(404, "NoSuchUpload", q.uploadId);
      return c.body(null, 200, { etag });
    }
    if (method === "POST" && q.uploadId) {
      const done = await store.completeUpload(q.uploadId);
      if (!done) return xmlError(404, "NoSuchUpload", q.uploadId);
      return c.body(
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(done.etag)}</ETag></CompleteMultipartUploadResult>`,
        200,
        { "content-type": "application/xml" },
      );
    }
    if (method === "DELETE" && q.uploadId) {
      await store.abortUpload(q.uploadId);
      return c.body(null, 204);
    }

    if (method === "PUT") {
      const etag = await store.put(bucket, key, new Uint8Array(await c.req.arrayBuffer()));
      return c.body(null, 200, { etag });
    }
    if (method === "DELETE") {
      await store.delete(bucket, key);
      return c.body(null, 204);
    }

    const h = await store.head(bucket, key);
    if (!h) return xmlError(404, "NoSuchKey", key);
    if (method === "HEAD") return c.body(null, 200, headersOf(h));

    // Range (DuckDB httpfs が使う) は Bun.serve がファイルの stream に対して自分で
    // 切る (206 / Content-Range まで付く。objects.test.ts が HTTP 越しに pin している)。
    // ここで切り直すと同じことを 2 回やるだけなので持たない
    return c.body(store.file(bucket, key).stream(), 200, headersOf(h));
  });
}
