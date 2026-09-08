/**
 * Return the stable id whatsapp-web.js expects for message lookups.
 *
 * WhatsApp Web renamed the serialized field from `_serialized` to `$1` in a
 * 2.3000 build. whatsapp-web.js still reads `_serialized`, so media downloads
 * receive `undefined` and fail inside IndexedDB. Prefer either supplied shape,
 * then reconstruct the same value from the three parts that remain stable.
 */
export function serializedMessageId(id) {
  if (!id || typeof id !== "object") return undefined;

  for (const value of [id._serialized, id.$1]) {
    if (typeof value === "string" && value.trim()) return value;
  }

  const remote = typeof id.remote === "string"
    ? id.remote
    : id.remote?._serialized ?? id.remote?.$1;
  const local = typeof id.id === "string" || typeof id.id === "number"
    ? String(id.id)
    : undefined;
  if (typeof id.fromMe !== "boolean" || !remote || !local) return undefined;
  return `${id.fromMe}_${remote}_${local}`;
}

/**
 * Repair the Message instance in place because downloadMedia(), reply(), and
 * several other whatsapp-web.js methods read `this.id._serialized` directly.
 */
export function repairSerializedMessageId(message) {
  const serialized = serializedMessageId(message?.id);
  if (!serialized || message.id._serialized === serialized) return serialized;

  try {
    message.id._serialized = serialized;
  } catch { /* try replacing the small id object below */ }

  if (message.id._serialized !== serialized) {
    try {
      message.id = { ...message.id, _serialized: serialized };
    } catch { /* the caller will retain the id for its own fallback */ }
  }
  return serialized;
}
