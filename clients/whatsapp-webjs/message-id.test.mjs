import { expect, test } from "bun:test";
import { repairSerializedMessageId, serializedMessageId } from "./message-id.mjs";

test("keeps the whatsapp-web.js serialized message id", () => {
  expect(serializedMessageId({
    _serialized: "false_123@c.us_ABC",
    fromMe: false,
    remote: "123@c.us",
    id: "ABC",
  })).toBe("false_123@c.us_ABC");
});

test("accepts the renamed WhatsApp Web $1 message id", () => {
  expect(serializedMessageId({
    $1: "true_456@lid_DEF",
    fromMe: true,
    remote: "456@lid",
    id: "DEF",
  })).toBe("true_456@lid_DEF");
});

test("reconstructs the id when neither serialized field is present", () => {
  expect(serializedMessageId({ fromMe: false, remote: "789@g.us", id: "GHI" }))
    .toBe("false_789@g.us_GHI");
});

test("repairs the field used internally by downloadMedia and reply", () => {
  const message = {
    id: { $1: "true_456@lid_DEF", fromMe: true, remote: "456@lid", id: "DEF" },
  };
  expect(repairSerializedMessageId(message)).toBe("true_456@lid_DEF");
  expect(message.id._serialized).toBe("true_456@lid_DEF");
});

test("does not invent an id from incomplete data", () => {
  expect(serializedMessageId({ fromMe: true, remote: "456@lid" })).toBeUndefined();
});
