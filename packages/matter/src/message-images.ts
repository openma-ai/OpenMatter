import { Schema } from "effect";
import type { JsonValue } from "./json.js";

/**
 * An image a message carries, as every Integration puts it on an Event's
 * `payload.images`. `id` is the provider's own handle: a Feishu `image_key`,
 * a Slack file id, or the URL of a markdown image in a GitHub, GitLab, or
 * Linear comment. Each provider package exports the helper that turns it
 * into bytes, given the message it came from.
 */
export const MessageImageSchema = Schema.Struct({
  id: Schema.String,
  mimeType: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}).annotations({ identifier: "MessageImage" });

export type MessageImage = typeof MessageImageSchema.Type;

/** The largest image a provider download helper returns: 10 MiB. */
export const MESSAGE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The body of a download, or undefined when it is larger than `maxBytes`.
 * A declared `content-length` over the cap is refused before reading; else
 * the body is read until it passes the cap and then cancelled.
 */
export const readMessageImageBytes = async (
  response: Response,
  maxBytes: number = MESSAGE_IMAGE_MAX_BYTES,
): Promise<Uint8Array | undefined> => {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * `{ images }` for an Event payload, or `{}` when there are none. Images
 * with the same `id` are kept once, in order.
 */
export const messageImagesField = (
  images: readonly MessageImage[],
): { readonly images?: JsonValue } => {
  const seen = new Set<string>();
  const portable: JsonValue[] = [];
  for (const image of images) {
    if (image.id.length === 0 || seen.has(image.id)) continue;
    seen.add(image.id);
    portable.push({
      id: image.id,
      ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }),
      ...(image.name === undefined ? {} : { name: image.name }),
    });
  }
  return portable.length === 0 ? {} : { images: portable };
};

const MARKDOWN_IMAGE =
  /!\[([^\]]*)\]\(\s*<?([^\s<>)]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const HTML_ALT = /\balt\s*=\s*["']([^"']*)["']/i;

/**
 * The images of a markdown body: `![alt](url)` and HTML `<img src>`, in
 * order of appearance. `id` is the URL as written, which may be relative
 * (GitLab writes `/uploads/…`); `name` is the alt text when present.
 */
export const markdownImages = (text: string): MessageImage[] => {
  const found: { readonly at: number; readonly image: MessageImage }[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const alt = match[1]?.trim() ?? "";
    found.push({
      at: match.index,
      image: { id: match[2]!, ...(alt.length === 0 ? {} : { name: alt }) },
    });
  }
  for (const match of text.matchAll(HTML_IMAGE)) {
    const alt = HTML_ALT.exec(match[0])?.[1]?.trim() ?? "";
    found.push({
      at: match.index,
      image: { id: match[1]!, ...(alt.length === 0 ? {} : { name: alt }) },
    });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.image);
};
