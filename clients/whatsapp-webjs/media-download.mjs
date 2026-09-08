/**
 * The fields needed to decrypt media without looking the message up again.
 *
 * whatsapp-web.js already transported this data out of the browser when it
 * created the Message instance. Keeping the fallback to this narrow object
 * avoids sending the rest of a chat message back into page.evaluate().
 */
export function rawMediaDescriptor(message) {
  const raw = message?.rawData ?? message?._data;
  if (!raw || typeof raw !== "object") return undefined;

  const descriptor = {
    directPath: raw.directPath,
    encFilehash: raw.encFilehash,
    filehash: raw.filehash,
    mediaKey: raw.mediaKey ?? message.mediaKey,
    mediaKeyTimestamp: raw.mediaKeyTimestamp,
    type: raw.type ?? message.type,
    mimetype: raw.mimetype ?? "audio/ogg",
    filename: raw.filename,
    filesize: raw.size,
  };

  if (!descriptor.directPath || !descriptor.mediaKey || !descriptor.type) return undefined;
  return descriptor;
}

/**
 * Bypass whatsapp-web.js's broken message-model lookup and run the same
 * download/decrypt operation using the media fields already on the Message.
 */
export async function downloadRawMedia(message, page) {
  const descriptor = rawMediaDescriptor(message);
  if (!descriptor || !page?.evaluate) return undefined;

  return page.evaluate(async (media) => {
    const mockQpl = {
      addAnnotations() { return this; },
      addPoint() { return this; },
    };
    try {
      const decrypted = await window
        .require("WAWebDownloadManager")
        .downloadManager.downloadAndMaybeDecrypt({
          directPath: media.directPath,
          encFilehash: media.encFilehash,
          filehash: media.filehash,
          mediaKey: media.mediaKey,
          mediaKeyTimestamp: media.mediaKeyTimestamp,
          type: media.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        });
      return {
        data: await window.WWebJS.arrayBufferToBase64Async(decrypted),
        mimetype: media.mimetype,
        filename: media.filename,
        filesize: media.filesize,
      };
    } catch (error) {
      if (error?.status === 404) return undefined;
      throw error;
    }
  }, descriptor);
}
