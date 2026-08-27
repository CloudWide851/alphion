export interface ChatViewportSource {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly displayText: string;
}

export interface ChatViewportRow {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly content: boolean;
}

export interface ChatViewportSegment {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly continued: boolean;
}

export interface ChatViewportSelection {
  readonly segments: readonly ChatViewportSegment[];
  readonly offset: number;
  readonly maxOffset: number;
  readonly totalRows: number;
}

export function projectChatRows(messages: readonly ChatViewportSource[], width: number): readonly ChatViewportRow[] {
  const safeWidth = Math.max(8, Math.floor(width));
  const rows: ChatViewportRow[] = [];
  for (const message of messages) {
    rows.push(Object.freeze({ id: message.id, role: message.role, text: "", content: false }));
    const lines = message.displayText.replace(/\r\n?/gu, "\n").split("\n");
    for (const line of lines) {
      for (const text of wrapLine(line, safeWidth)) rows.push(Object.freeze({ id: message.id, role: message.role, text, content: true }));
    }
    rows.push(Object.freeze({ id: message.id, role: message.role, text: "", content: false }));
  }
  return Object.freeze(rows);
}

export function selectChatViewport(rows: readonly ChatViewportRow[], height: number, requestedOffset: number): ChatViewportSelection {
  const safeHeight = Math.max(1, Math.floor(height));
  const maxOffset = Math.max(0, rows.length - safeHeight);
  const offset = Math.min(maxOffset, Math.max(0, Math.floor(requestedOffset)));
  const end = Math.max(0, rows.length - offset);
  const visible = rows.slice(Math.max(0, end - safeHeight), end).filter((row) => row.content);
  const segments: ChatViewportSegment[] = [];
  for (const row of visible) {
    const previous = segments.at(-1);
    if (previous?.id === row.id) {
      segments[segments.length - 1] = Object.freeze({ ...previous, text: previous.text ? `${previous.text}\n${row.text}` : row.text });
    } else {
      const sourceIndex = rows.indexOf(row);
      const continued = rows.slice(0, sourceIndex).some((candidate) => candidate.id === row.id && candidate.content);
      segments.push(Object.freeze({ id: row.id, role: row.role, text: row.text, continued }));
    }
  }
  return Object.freeze({ segments: Object.freeze(segments), offset, maxOffset, totalRows: rows.length });
}

function wrapLine(value: string, width: number): readonly string[] {
  const characters = [...value];
  if (characters.length === 0) return Object.freeze([""]);
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += width) lines.push(characters.slice(index, index + width).join(""));
  return Object.freeze(lines);
}
