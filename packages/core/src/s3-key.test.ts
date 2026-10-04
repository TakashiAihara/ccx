import { expect, test } from "bun:test";

import { s3AccessKeyId } from "./transcript.ts";

test("access key id は center の token、無ければダミー。export された AWS の鍵は送らない (#158, #210)", () => {
  const saved = process.env.AWS_ACCESS_KEY_ID;
  process.env.AWS_ACCESS_KEY_ID = "aws-key";
  try {
    expect(s3AccessKeyId({ endpoint: "http://c:8791", bucket: "ccx", prefix: "", token: "tok" })).toBe("tok");
    expect(s3AccessKeyId({ endpoint: "http://c:8791", bucket: "ccx", prefix: "" })).toBe("ccx");
  } finally {
    if (saved === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = saved;
  }
});
