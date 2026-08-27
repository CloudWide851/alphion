import type { ProviderMessage } from "../../src/domain/contracts.js";
import type { ImageAttachmentRef } from "../../src/domain/attachment-contracts.js";
import type { AttachmentReader } from "../../src/ports/index.js";
import { AlphionError } from "../../src/application/errors.js";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions/completions";
import type { ResponseInputContent } from "openai/resources/responses/responses";

type UserContent = Extract<ProviderMessage, { readonly role: "user" }>["content"];

export async function toChatUserContent(content: UserContent, reader: AttachmentReader | undefined, signal: AbortSignal): Promise<string | ChatCompletionContentPart[]> {
  if (typeof content === "string") return content;
  const parts: ChatCompletionContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else parts.push({ type: "image_url", image_url: { url: await dataUrl(part.attachment.mediaType, part.attachment, reader, signal) } });
  }
  return parts;
}

export async function toResponsesUserContent(content: UserContent, reader: AttachmentReader | undefined, signal: AbortSignal): Promise<string | ResponseInputContent[]> {
  if (typeof content === "string") return content;
  const parts: ResponseInputContent[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ type: "input_text", text: part.text });
    else parts.push({ type: "input_image", image_url: await dataUrl(part.attachment.mediaType, part.attachment, reader, signal), detail: "auto" });
  }
  return parts;
}

async function dataUrl(mediaType: string, attachment: ImageAttachmentRef, reader: AttachmentReader | undefined, signal: AbortSignal): Promise<string> {
  if (!reader) throw new AlphionError("dependency-unavailable", "Provider image reader is unavailable.", { stage: "attachment" });
  const bytes = await reader.readAttachment(attachment, signal);
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}
