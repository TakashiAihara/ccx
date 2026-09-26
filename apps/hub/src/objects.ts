import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

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
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/**
 * prefix は key の先頭なので、末尾以外は key と同じ規則。`a/../` のような prefix は
 * listKeys の走査を root の外に向けるので拒む。空と、`/` で終わるものは通す。
 */
export function validPrefix(prefix: string): boolean {
  if (prefix === "") return true;
  if (prefix.length > 1024) return false;
  const segs = prefix.split("/");
  const last = segs.pop()!;
  if (last === "." || last === "..") return false;
  return segs.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** 読み込みながら md5 を取る。object 全体をメモリに載せない */
async function md5Of(path: string): Promise<string> {
  const h = createHash("md5");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return `"${h.digest("hex")}"`;
}

/** CompleteMultipartUpload の本文から PartNumber を出現順に取る */
export function partNumbersOf(xml: string): number[] {
  return [...xml.matchAll(/<PartNumber>\s*(\d+)\s*<\/PartNumber>/g)].map((m) => Number(m[1]));
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

export class ObjectStore {
  constructor(readonly root: string) {}

  private objectPath(bucket: string, key: string): string {
    return join(this.root, bucket, key);
  }

  private uploadDir(uploadId: string): string {
    return join(this.root, ".multipart", uploadId);
  }

  /**
   * 書きかけを読まれないよう、staging に書いてから rename する。staging は root 直下の
   * `.staging/` で、bucket 名は `.` で始められないので一覧に混ざらない (object の隣に
   * `.tmp` を置く形だと、`.tmp` で終わる key を一覧から隠すことになる)
   */
  async put(bucket: string, key: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    const path = this.objectPath(bucket, key);
    await mkdir(dirname(path), { recursive: true });
    await mkdir(join(this.root, ".staging"), { recursive: true });
    const tmp = join(this.root, ".staging", randomUUID());
    const h = createHash("md5");
    const w = createWriteStream(tmp);
    // stream のまま書く。transcript は数 MB から数十 MB で、本文を丸ごと持つと
    // 同時に来た数本ぶんがそのままメモリになる
    const src = body instanceof Uint8Array ? [body] : body;
    try {
      for await (const chunk of src) {
        h.update(chunk);
        if (!w.write(chunk)) await new Promise((r) => w.once("drain", r));
      }
      await new Promise<void>((resolve, reject) => w.end((e?: Error | null) => (e ? reject(e) : resolve())));
      await rename(tmp, path);
    } catch (e) {
      // 途中で落ちた staging を残さない
      await rm(tmp, { force: true });
      throw e;
    }
    return `"${h.digest("hex")}"`;
  }

  /** bucket を用意する。既にあっても成功 (S3 の CreateBucket と同じ) */
  async createBucket(bucket: string): Promise<void> {
    await mkdir(join(this.root, bucket), { recursive: true });
  }

  async listBuckets(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
    return names.filter((n) => BUCKET.test(n)).sort();
  }

  /** 無ければ null。無い以外の失敗 (権限 / I/O) は投げる — 404 に化けると消えたように見える */
  async head(bucket: string, key: string): Promise<{ size: number; mtime: Date; etag: string } | null> {
    const path = this.objectPath(bucket, key);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(path);
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    if (!s.isFile()) return null;
    // ETag は S3 では単一 PUT なら本文の md5。読み直して計算するのは、置いた
    // ときの値を別に持たない (ファイル 1 つで完結させる) ため
    return { size: s.size, mtime: s.mtime, etag: await md5Of(path) };
  }

  file(bucket: string, key: string) {
    return Bun.file(this.objectPath(bucket, key));
  }

  /** S3 と同じく、無い key の DELETE も成功として返す。無い以外の失敗は投げる */
  async delete(bucket: string, key: string): Promise<void> {
    try {
      await unlink(this.objectPath(bucket, key));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }

  /**
   * bucket 配下の key を辞書順で返す。prefix の下だけ歩く。
   * 数が効いてくるまでは index を持たない (ファイルが真実源)。
   * prefix は呼び出し側 (validPrefix) が検証済みのものを渡す。
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
        } else if (e.isFile() && key.startsWith(prefix)) {
          // readdir と stat の間に消えたものは一覧に出さない (消えた以外は投げる)
          try {
            const s = await stat(join(base, key));
            out.push({ key, size: s.size, mtime: s.mtime });
          } catch (err) {
            if (!isEnoent(err)) throw err;
          }
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

  async putPart(uploadId: string, n: number, body: ReadableStream<Uint8Array>): Promise<string | null> {
    const dir = this.uploadDir(uploadId);
    if (!(await Bun.file(join(dir, "meta.json")).exists())) return null;
    const h = createHash("md5");
    await pipeline(
      body,
      async function* (src) {
        for await (const chunk of src) {
          h.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(join(dir, String(n))),
    );
    return `"${h.digest("hex")}"`;
  }

  /**
   * 完了要求に並んだ part をその順に連結して object にする。要求に無い part は
   * 捨て、要求にあってディスクに無い part は InvalidPart で断る (S3 と同じ)。
   * 連結は stream で、object 全体をメモリに載せない。
   */
  async completeUpload(
    uploadId: string,
    parts: number[],
  ): Promise<{ bucket: string; key: string; etag: string } | "no-such-upload" | "invalid-part"> {
    const dir = this.uploadDir(uploadId);
    const metaFile = Bun.file(join(dir, "meta.json"));
    if (!(await metaFile.exists())) return "no-such-upload";
    const { bucket, key } = (await metaFile.json()) as { bucket: string; key: string };

    if (parts.length === 0) return "invalid-part";
    for (const n of parts) {
      if (!(await Bun.file(join(dir, String(n))).exists())) return "invalid-part";
    }
    const concatenated = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const n of parts) {
          for await (const chunk of Bun.file(join(dir, String(n))).stream()) controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const etag = await this.put(bucket, key, concatenated);
    await rm(dir, { recursive: true, force: true });
    return { bucket, key, etag };
  }

  /** 無い uploadId は false (S3 は NoSuchUpload) */
  async abortUpload(uploadId: string): Promise<boolean> {
    const dir = this.uploadDir(uploadId);
    if (!(await Bun.file(join(dir, "meta.json")).exists())) return false;
    await rm(dir, { recursive: true, force: true });
    return true;
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
    if (!validPrefix(prefix)) return xmlError(400, "InvalidArgument", `invalid prefix: ${prefix}`);
    const delimiter = q.delimiter ?? "";
    // max-keys=0 は「0 件返す」で、未指定や読めない値だけが既定に落ちる
    const maxKeysRaw = q["max-keys"] === undefined ? Number.NaN : Number(q["max-keys"]);
    const maxKeys = Number.isInteger(maxKeysRaw) && maxKeysRaw >= 0 ? Math.min(maxKeysRaw, MAX_KEYS_DEFAULT) : MAX_KEYS_DEFAULT;
    // encoding-type=url を頼まれたら key と prefix を URL エンコードして返す (aws cli と DuckDB が頼む)
    const enc = q["encoding-type"] === "url" ? (s: string) => encodeURIComponent(s).replace(/%2F/g, "/") : (s: string) => s;
    // continuation-token は「前のページの最後の要素 (key か common prefix)」の base64url。
    // 生の key を返すと、encoding-type で URL エンコードしても XML の実体参照にしても、
    // それを戻さずに送り返すクライアント (DuckDB 1.5 の httpfs) で別の位置から再開し、
    // ループ (#173) や重複・欠落になる。base64url は URL でも XML でも手を加えられない
    const token = q["continuation-token"];
    let after = q["start-after"] ?? "";
    if (token !== undefined) {
      after = Buffer.from(token, "base64url").toString();
      if (Buffer.from(after).toString("base64url") !== token) {
        return xmlError(400, "InvalidArgument", "The continuation token provided is incorrect");
      }
    }

    // Contents と CommonPrefixes を 1 本の辞書順に並べてからページを切る。
    // 別々に数えると、delimiter 付きの一覧が max-keys を超えても truncated にならない
    type Entry = { key: string; size: number; mtime: Date } | { commonPrefix: string };
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const o of await store.listKeys(bucket, prefix)) {
      if (delimiter) {
        const rest = o.key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i !== -1) {
          const p = prefix + rest.slice(0, i + delimiter.length);
          if (!seen.has(p)) {
            seen.add(p);
            entries.push({ commonPrefix: p });
          }
          continue;
        }
      }
      entries.push(o);
    }
    const nameOf = (e: Entry) => ("commonPrefix" in e ? e.commonPrefix : e.key);
    const remaining = entries.filter((e) => nameOf(e) > after);
    const page = remaining.slice(0, maxKeys);
    const truncated = remaining.length > maxKeys;
    const last = page.length ? nameOf(page[page.length - 1]!) : "";

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(enc(prefix))}</Prefix>`,
      delimiter ? `<Delimiter>${xmlEscape(enc(delimiter))}</Delimiter>` : "",
      q["encoding-type"] === "url" ? "<EncodingType>url</EncodingType>" : "",
      // token は encoding-type の対象外で、StartAfter は対象 (S3 と同じ)。受け取ったものだけを返す
      token !== undefined ? `<ContinuationToken>${token}</ContinuationToken>` : "",
      token === undefined && after ? `<StartAfter>${xmlEscape(enc(after))}</StartAfter>` : "",
      `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>`,
      `<IsTruncated>${truncated}</IsTruncated>`,
      truncated ? `<NextContinuationToken>${Buffer.from(last).toString("base64url")}</NextContinuationToken>` : "",
      ...page.map((e) =>
        "commonPrefix" in e
          ? `<CommonPrefixes><Prefix>${xmlEscape(enc(e.commonPrefix))}</Prefix></CommonPrefixes>`
          : `<Contents><Key>${xmlEscape(enc(e.key))}</Key><Size>${e.size}</Size><LastModified>${e.mtime.toISOString()}</LastModified><StorageClass>STANDARD</StorageClass></Contents>`,
      ),
      "</ListBucketResult>",
    ].join("");
    return c.body(xml, 200, { "content-type": "application/xml" });
  };

  // ListBuckets。rclone / aws cli が最初に叩く
  app.get("/", async (c) => {
    const names = await store.listBuckets();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets>${names
      .map((n) => `<Bucket><Name>${xmlEscape(n)}</Name><CreationDate>1970-01-01T00:00:00.000Z</CreationDate></Bucket>`)
      .join("")}</Buckets></ListAllMyBucketsResult>`;
    return c.body(xml, 200, { "content-type": "application/xml" });
  });

  // bucket 単位。GET は一覧、PUT は CreateBucket (既にあっても成功)、HEAD は存在確認。
  // bucket は暗黙に存在するので、どれも「作った / ある」としか答えない
  app.on(["GET", "PUT", "HEAD"], "/:bucket", async (c) => {
    const bucket = c.req.param("bucket");
    if (!BUCKET.test(bucket)) return xmlError(400, "InvalidBucketName", bucket);
    if (c.req.method === "GET") return list(c, bucket);
    if (c.req.method === "PUT") await store.createBucket(bucket);
    return c.body(null, 200);
  });

  app.on(["GET", "HEAD", "PUT", "POST", "DELETE"], "/:bucket/*", async (c) => {
    const bucket = c.req.param("bucket");
    if (!BUCKET.test(bucket)) return xmlError(400, "InvalidBucketName", bucket);
    let key: string;
    try {
      // `new URL().pathname` は `%2e%2e` を `..` と読んで畳む (WHATWG)。畳まれた後の
      // パスからは何が来たか分からないので、生のパスから切る
      key = decodeURIComponent(c.req.path.slice(bucket.length + 2));
    } catch {
      return xmlError(400, "InvalidArgument", "key is not valid percent-encoding");
    }
    // `GET /<bucket>/?list-type=2` (Bun.S3Client) と `PUT /<bucket>/` (rclone の CreateBucket) は
    // 末尾 `/` 付きで来る
    if (key === "") {
      if (c.req.method === "GET") return list(c, bucket);
      if (c.req.method === "PUT") {
        await store.createBucket(bucket);
        return c.body(null, 200);
      }
      if (c.req.method === "HEAD") return c.body(null, 200);
    }
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
    // uploadId はこちらが採番した UUID しか無い。それ以外はディレクトリ名として
    // 使う前に断る (`../../x` を abort に渡すと root の外を消す)
    if (q.uploadId !== undefined && !UPLOAD_ID.test(q.uploadId)) return xmlError(404, "NoSuchUpload", q.uploadId);
    if (method === "PUT" && q.uploadId) {
      const n = Number(q.partNumber);
      if (!Number.isInteger(n) || n < 1 || n > 10000) return xmlError(400, "InvalidArgument", "partNumber");
      const etag = await store.putPart(q.uploadId, n, c.req.raw.body ?? new ReadableStream());
      if (!etag) return xmlError(404, "NoSuchUpload", q.uploadId);
      return c.body(null, 200, { etag });
    }
    if (method === "POST" && q.uploadId) {
      const done = await store.completeUpload(q.uploadId, partNumbersOf(await c.req.text()));
      if (done === "no-such-upload") return xmlError(404, "NoSuchUpload", q.uploadId);
      if (done === "invalid-part") return xmlError(400, "InvalidPart", "a listed part was not uploaded");
      // 置いた先は開始時に記録した bucket / key。URL のものではなく実際の置き場所を返す
      return c.body(
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${xmlEscape(done.bucket)}</Bucket><Key>${xmlEscape(done.key)}</Key><ETag>${xmlEscape(done.etag)}</ETag></CompleteMultipartUploadResult>`,
        200,
        { "content-type": "application/xml" },
      );
    }
    if (method === "DELETE" && q.uploadId) {
      if (!(await store.abortUpload(q.uploadId))) return xmlError(404, "NoSuchUpload", q.uploadId);
      return c.body(null, 204);
    }

    if (method === "PUT") {
      try {
        const etag = await store.put(bucket, key, c.req.raw.body ?? new Uint8Array());
        return c.body(null, 200, { etag });
      } catch (e) {
        // ファイルシステムの上では `a` と `a/b` は両立しない (S3 では両方置ける)。
        // 500 ではなく、何と衝突したかが分かる形で断る
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "ENOTDIR" || code === "EISDIR" || code === "EEXIST") {
          return xmlError(409, "KeyConflict", `${key} conflicts with an existing object that is a prefix of it, or that it is a prefix of`);
        }
        if (code === "ENAMETOOLONG") return xmlError(400, "KeyTooLongError", key);
        throw e;
      }
    }
    // POST は multipart の開始と完了にしか意味が無い。素の POST を GET に読み替えない
    if (method === "POST") return xmlError(405, "MethodNotAllowed", "POST needs ?uploads or ?uploadId");
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
