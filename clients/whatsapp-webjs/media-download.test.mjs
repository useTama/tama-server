import { expect, test } from "bun:test";
import { downloadRawMedia, rawMediaDescriptor } from "./media-download.mjs";

const raw = {
  directPath: "/v/t62/example",
  encFilehash: "encrypted",
  filehash: "plain",
  mediaKey: "key",
  mediaKeyTimestamp: 123,
  type: "ptt",
  mimetype: "audio/ogg; codecs=opus",
  size: 42,
};

test("takes only media download fields from the raw message", () => {
  expect(rawMediaDescriptor({ rawData: { ...raw, body: "private caption" } })).toEqual({
    directPath: "/v/t62/example",
    encFilehash: "encrypted",
    filehash: "plain",
    mediaKey: "key",
    mediaKeyTimestamp: 123,
    type: "ptt",
    mimetype: "audio/ogg; codecs=opus",
    filename: undefined,
    filesize: 42,
  });
});

test("does not attempt a raw download without its required fields", async () => {
  let called = false;
  const page = { evaluate: async () => { called = true; } };
  expect(await downloadRawMedia({ rawData: { type: "ptt" } }, page)).toBeUndefined();
  expect(called).toBe(false);
});

test("passes the narrow descriptor to the browser fallback", async () => {
  let supplied;
  const page = {
    evaluate: async (_browserFunction, descriptor) => {
      supplied = descriptor;
      return { data: "YXVkaW8=", mimetype: descriptor.mimetype };
    },
  };
  expect(await downloadRawMedia({ rawData: raw }, page)).toEqual({
    data: "YXVkaW8=",
    mimetype: "audio/ogg; codecs=opus",
  });
  expect(supplied.directPath).toBe(raw.directPath);
  expect("body" in supplied).toBe(false);
});
