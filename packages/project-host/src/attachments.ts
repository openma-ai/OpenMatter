import type { ProjectAttachment } from "./types.js";
export const PROJECT_ATTACHMENT_LIMIT = 20 * 1024 * 1024;
export function validateProjectAttachments(
  input: unknown,
): asserts input is ProjectAttachment[] | undefined {
  if (input === undefined) return;
  if (!Array.isArray(input) || input.length > 20)
    throw new Error("Attach up to 20 files");
  let bytes = 0;
  const ids = new Set<string>();
  for (const file of input) {
    if (
      !file ||
      typeof file.id !== "string" ||
      !file.id ||
      ids.has(file.id) ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 255 ||
      !["file", "image"].includes(file.kind) ||
      typeof file.mimeType !== "string" ||
      !file.mimeType ||
      typeof file.data !== "string" ||
      file.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
    )
      throw new Error("Invalid project attachment");
    ids.add(file.id);
    bytes += Buffer.byteLength(file.data, "base64");
    if (bytes > PROJECT_ATTACHMENT_LIMIT)
      throw new Error("Attachments must total 20 MB or less");
  }
}
export function projectPromptAttachments(
  items: readonly { kind: string; value: unknown }[],
): ProjectAttachment[] {
  const event = items.find((item) => item.kind === "event")?.value as
    { payload?: { attachments?: ProjectAttachment[] } } | undefined;
  const attachments = event?.payload?.attachments;
  validateProjectAttachments(attachments);
  return attachments ?? [];
}
/** Binary payloads travel as native content blocks, never a base64 wall in text. */
export function projectContextText(items: unknown): string {
  return JSON.stringify(items, (key, value) =>
    key === "attachments" && Array.isArray(value)
      ? value.map(({ data, ...file }) => file)
      : value,
  );
}
