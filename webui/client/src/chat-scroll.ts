import { useCallback, useEffect, useRef, useState, type RefObject, type UIEvent } from "react";

export interface ChatScrollController {
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly unseenCount: number;
  readonly onScroll: (event: UIEvent<HTMLElement>) => void;
  readonly returnToLatest: () => void;
}

export function useChatScroll(itemCount: number, contentRevision: number, resetKey: string): ChatScrollController {
  const viewportRef = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const previousCount = useRef(itemCount);
  const [unseenCount, setUnseenCount] = useState(0);

  const returnToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    atBottom.current = true;
    setUnseenCount(0);
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const viewport = event.currentTarget;
    atBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 8;
    if (atBottom.current) setUnseenCount(0);
  }, []);

  useEffect(() => {
    previousCount.current = itemCount;
    atBottom.current = true;
    setUnseenCount(0);
    const frame = requestAnimationFrame(returnToLatest);
    return () => cancelAnimationFrame(frame);
  }, [resetKey, returnToLatest]);

  useEffect(() => {
    const added = Math.max(0, itemCount - previousCount.current);
    previousCount.current = itemCount;
    if (atBottom.current) {
      const frame = requestAnimationFrame(returnToLatest);
      return () => cancelAnimationFrame(frame);
    }
    if (added > 0) setUnseenCount((value) => value + added);
    return undefined;
  }, [contentRevision, itemCount, returnToLatest]);

  return { viewportRef, unseenCount, onScroll, returnToLatest };
}
