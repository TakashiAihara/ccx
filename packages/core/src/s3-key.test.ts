import { expect, test } from "bun:test";

import { s3AccessKeyId } from "./transcript.ts";

const center = { endpoint: "http://c:8791", bucket: "ccx", prefix: "", token: "center-tok" };
const external = { endpoint: "http://s3", bucket: "ccx", prefix: "" };

test("保存先が center なら、export された AWS の鍵より center の token を送る (#158)", () => {
  expect(s3AccessKeyId(center, { AWS_ACCESS_KEY_ID: "aws-key", S3_ACCESS_KEY_ID: "s3-key" })).toBe("center-tok");
});

test("外部の S3 は標準の env、無ければダミー", () => {
  expect(s3AccessKeyId(external, { AWS_ACCESS_KEY_ID: "aws-key" })).toBe("aws-key");
  expect(s3AccessKeyId(external, { S3_ACCESS_KEY_ID: "s3-key" })).toBe("s3-key");
  expect(s3AccessKeyId(external, {})).toBe("ccx");
});
