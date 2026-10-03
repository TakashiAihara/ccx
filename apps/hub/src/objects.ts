import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, type Stats } from "node:fs";
import { appendFile, mkdir, readdir, rename, rm, stat, truncate, unlink } from "node:fs/promises";
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
 * bucket 名。S3 の規則と同じ形。mountObjects の 400 (InvalidBucketName) と、
 * 保存先を名前で受ける TranscriptService.Append の検査が同じ判定を使う。
 */
export function validBucket(bucket: string): boolean {
  return BUCKET.test(bucket);
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

/**
 * 読み込みながら md5 を取る。object 全体をメモリに載せない。
 * limit があればその長さまでで切る (append の確定前を読む readers 用)。
 */
async function md5Of(path: string, limit?: number): Promise<string> {
  const h = createHash("md5");
  let read = 0;
  for await (const chunk of Bun.file(path).stream()) {
    const bytes = limit === undefined ? chunk : chunk.subarray(0, Math.min(chunk.length, limit - read));
    read += bytes.length;
    h.update(bytes);
    if (limit !== undefined && read >= limit) break;
  }
  return `"${h.digest("hex")}"`;
}

/** 1 つの object への書き込み (put と append) を直列化するのに使う識別子 */
const lockKeyOf = (bucket: string, key: string) => `${bucket}/${key}`;

/** append の 1 回分の設定。beforeCommit はテスト専用の継ぎ目。 */
export type AppendOptions = {
  /** 送り手のファイルで offset の直前にある bytes。object の末尾と違えば足さない */
  expectedTail?: Uint8Array;
  /**
   * bytes を書いてから新しい長さを確定するまでの間で待たせる。確定前の長さを
   * reader に見せられることを、外から確かめるための口。
   */
  beforeCommit?: () => Promise<void>;
};

/** CompleteMultipartUpload の本文から PartNumber を出現順に取る */
export function partNumbersOf(xml: string): number[] {
  return [...xml.matchAll(/<PartNumber>\s*(\d+)\s*<\/PartNumber>/g)].map((m) => Number(m[1]));
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

export class ObjectStore {
  constructor(readonly root: string) {}

  /**
   * 1 つの key への put と append の並びを 1 本にするための鎖。append は
   * 「offset == 今の size」という判定を挟んでから書くので、同じ key に put と append
   * が重なると size の取り合いになる (append が put の前に読んだ size へ書くと、
   * append した bytes が put の後始末に消える)。
   */
  private locks = new Map<string, Promise<void>>();

  /**
   * append の書き込みが済んでから長さが確定するまでの間だけ入る、その key で確定して
   * いる長さ。これがある間、reader (head / file / snapshot / 一覧) はファイルが
   * 持っている長さではなくこの長さまでしか見ない (追記の途中で走った検索が、
   * 書きかけの行を読まないようにするため)。
   */
  private pending = new Map<string, number>();

  /**
   * key ごとに、追記の開始と確定 (失敗を含む) で 1 ずつ進む番号。head が stat の前後で
   * 比べて、間に追記の境目が挟まったかを知る
   */
  private generation = new Map<string, number>();

  private bump(id: string): void {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
  }

  private objectPath(bucket: string, key: string): string {
    return join(this.root, bucket, key);
  }

  /** 確定前の長さの制限。記録が無ければ「制限なし」。 */
  private committedLimit(bucket: string, key: string): number | undefined {
    return this.pending.get(lockKeyOf(bucket, key));
  }

  /** 同じ key への書き込みを通しで 1 本にする。fn が失敗しても次の人は進める。 */
  private async locked<T>(bucket: string, key: string, fn: () => Promise<T>): Promise<T> {
    const id = lockKeyOf(bucket, key);
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn);
    // 鎖として渡すのは失敗しない promise。前の呼び出しが失敗しても次の人は進める
    const mine = run.then(
      () => {},
      () => {},
    );
    this.locks.set(id, mine);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === mine) this.locks.delete(id);
    }
  }

  private uploadDir(uploadId: string): string {
    return join(this.root, ".multipart", uploadId);
  }

  /**
   * 書きかけを読まれないよう、staging に書いてから rename する。staging は root 直下の
   * `.staging/` で、bucket 名は `.` で始められないので一覧に混ざらない (object の隣に
   * `.tmp` を置く形だと、`.tmp` で終わる key を一覧から隠すことになる)。
   *
   * 同じ key の append とは 1 本に並ぶ (append の offset 判定と put の rename が
   * 重なると、append した bytes が消えるか壊れる)。
   */
  async put(bucket: string, key: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    return this.write(bucket, key, body);
  }

  /**
   * 本文は staging に受け取り、置き換え (rename) のときだけ key の鎖に並ぶ。本文を受け
   * 取る間ずっと並んでいると、遅い (止まった) upload がその key の追記と DELETE を止める
   */
  private async write(
    bucket: string,
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<string> {
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
      await this.locked(bucket, key, () => rename(tmp, path));
    } catch (e) {
      // 途中で落ちた staging を残さない
      await rm(tmp, { force: true });
      throw e;
    }
    return `"${h.digest("hex")}"`;
  }

  /**
   * offset が今の size と一致したときだけ data を末尾に足し、{ ok, size } を返す。
   * 一致しなければ何も書かず { ok: false, 今の size } で終わる (object が無い size は 0)。
   *
   * 「offset == size」しか許さないことが、重複 (送り済みの bytes の再送は offset が size
   * より小さい) と欠け (offset が size より大きい) を両方書かせない唯一の手順 (#120)。
   * data が空なら size が一致しただけで成功として、何も書かない。
   */
  async append(
    bucket: string,
    key: string,
    offset: bigint,
    data: Uint8Array,
    opts: AppendOptions = {},
  ): Promise<{ ok: boolean; size: bigint; diverged?: true }> {
    // 同じ key の put と append を 1 本にする。判定も書き込みもこの鎖の中
    return this.locked(bucket, key, async () => {
      const id = lockKeyOf(bucket, key);
      const path = this.objectPath(bucket, key);
      // size は stat で取る。head は ETag のために object 全体の md5 を読むので、使うと
      // 追記のたびに transcript 全体を読み直すことになる
      const size = BigInt(await stat(path).then((s) => (s.isFile() ? s.size : 0), (e) => {
        if (isEnoent(e)) return 0;
        throw e;
      }));
      if (offset !== size) return { ok: false, size };
      // object が送り手のファイルの先頭か。末尾の数 KiB だけ読んで比べる (transcript.proto の expected_tail)
      const tail = opts.expectedTail;
      if (tail && tail.length > 0) {
        if (BigInt(tail.length) > size) return { ok: false, size, diverged: true };
        const have = new Uint8Array(await Bun.file(path).slice(Number(size) - tail.length, Number(size)).arrayBuffer());
        if (!Buffer.from(have).equals(Buffer.from(tail))) return { ok: false, size, diverged: true };
      }

      // ここから確定までは、reader に append 前の長さしか見せない
      this.pending.set(id, Number(size));
      this.bump(id);
      try {
        if (data.length > 0) {
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, data);
        }
        if (opts.beforeCommit) await opts.beforeCommit();
      } catch (e) {
        this.pending.delete(id);
      this.bump(id);
        // 途中まで書けた object を残すと、reader には次の append まで壊れた長さの
        // object が見えてしまう。確定前に戻した長さに切り戻す
        if (data.length > 0) {
          await truncate(path, Number(size)).catch((te) => {
            // 切り戻せなかった。reader には書きかけが見える。黙らない
            console.error(`ccx-center: could not roll back a failed append to ${bucket}/${key}: ${te}`);
          });
        }
        throw e;
      }
      this.pending.delete(id);
      this.bump(id);
      return { ok: true, size: size + BigInt(data.length) };
    });
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
    return names.filter(validBucket).sort();
  }

  /** 無ければ null。無い以外の失敗 (権限 / I/O) は投げる — 404 に化けると消えたように見える */
  /** テストの継ぎ目。stat が読む瞬間を追記の途中に置くため */
  protected async statOf(path: string): Promise<Stats> {
    return stat(path);
  }

  async head(bucket: string, key: string): Promise<{ size: number; mtime: Date; etag: string } | null> {
    const path = this.objectPath(bucket, key);
    const id = lockKeyOf(bucket, key);
    let s!: Stats;
    let limit: number | undefined;
    // stat と確定長の記録は別の瞬間に読む。その間に追記が始まるか確定すると、stat は
    // 書き込み途中の長さを読んでいるのに記録は消えている、が起こる。追記の開始と確定で
    // 進む番号が stat を挟んで同じときだけ、2 つを同じ瞬間のものとして使う
    for (;;) {
      const before = this.generation.get(id) ?? 0;
      limit = this.committedLimit(bucket, key);
      try {
        s = await this.statOf(path);
      } catch (e) {
        if (isEnoent(e)) return null;
        throw e;
      }
      if ((this.generation.get(id) ?? 0) === before) break;
    }
    if (!s.isFile()) return null;
    // append が確定するまでは、書けているぶんの長さを隠す (下の file / GET と同じ)
    const size = limit === undefined ? s.size : Math.min(s.size, limit);
    // ETag は S3 では単一 PUT なら本文の md5。読み直して計算するのは、置いた
    // ときの値を別に持たない (ファイル 1 つで完結させる) ため。読み返す長さも size に
    // 合わせる。そうしないと S3 のように「同じ ETag で別の長さ」になる
    return { size, mtime: s.mtime, etag: await md5Of(path, size) };
  }

  /**
   * head と本文を同じ長さで返す。GET は Content-Length を head から、本文を file から
   * 作るので、別々に呼ぶと間で追記が確定したとき本文が Content-Length より長くなる。
   * 揃うのは追記に対してだけ: 本文は path で遅れて読むので、put / DELETE の置き換えが
   * 読み出し中に入ると別の object の bytes になりうる (#209)
   */
  async snapshot(bucket: string, key: string): Promise<{ head: { size: number; mtime: Date; etag: string }; body: Blob } | null> {
    const head = await this.head(bucket, key);
    if (!head) return null;
    return { head, body: Bun.file(this.objectPath(bucket, key)).slice(0, head.size) };
  }

  /** 本文。append の途中なら確定した長さまでしか返さない Blob。 */
  file(bucket: string, key: string): Blob {
    const path = this.objectPath(bucket, key);
    const limit = this.committedLimit(bucket, key);
    return limit === undefined ? Bun.file(path) : Bun.file(path).slice(0, limit);
  }


  /** S3 と同じく、無い key の DELETE も成功として返す。無い以外の失敗は投げる */
  async delete(bucket: string, key: string): Promise<void> {
    // append と同じ鎖に並ぶ。append の size 判定と追記の間に消されると、追記が
    // 空のファイルを作り直して「足した」と答える
    await this.locked(bucket, key, async () => {
      try {
        await unlink(this.objectPath(bucket, key));
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    });
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
            // 追記の途中なら確定した長さ (head / GET と同じ。一覧の size で範囲読みする client が書きかけを読まないように)
            const limit = this.committedLimit(bucket, key);
            out.push({ key, size: limit === undefined ? s.size : Math.min(s.size, limit), mtime: s.mtime });
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
      // token は encoding-type の対象外で、StartAfter は対象 (S3 と同じ)。受け取ったものだけを返す。
      // 送られたら (空でも) 返す (AWS)。両方来たときの位置は token が決める (こちらの決め)
      token !== undefined ? `<ContinuationToken>${token}</ContinuationToken>` : "",
      q["start-after"] !== undefined ? `<StartAfter>${xmlEscape(enc(q["start-after"]))}</StartAfter>` : "",
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
    if (!validBucket(bucket)) return xmlError(400, "InvalidBucketName", bucket);
    if (c.req.method === "GET") return list(c, bucket);
    if (c.req.method === "PUT") await store.createBucket(bucket);
    return c.body(null, 200);
  });

  app.on(["GET", "HEAD", "PUT", "POST", "DELETE"], "/:bucket/*", async (c) => {
    const bucket = c.req.param("bucket");
    if (!validBucket(bucket)) return xmlError(400, "InvalidBucketName", bucket);
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

    const snap = await store.snapshot(bucket, key);
    if (!snap) return xmlError(404, "NoSuchKey", key);
    if (method === "HEAD") return c.body(null, 200, headersOf(snap.head));

    // Range (DuckDB httpfs が使う) は Bun.serve がファイルの stream に対して自分で
    // 切る (206 / Content-Range まで付く。objects.test.ts が HTTP 越しに pin している)。
    // ここで切り直すと同じことを 2 回やるだけなので持たない
    return c.body(snap.body.stream(), 200, headersOf(snap.head));
  });
}
