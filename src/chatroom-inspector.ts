import type React from 'cordisx/react';
import { type RefObject, useLayoutEffect, useRef, useState } from 'cordisx/react';

export function inspectorMaximumWidth(containerWidth: number): number {
  return containerWidth > 0 ? Math.min(640, Math.max(320, containerWidth * 0.62)) : 640;
}

export function clampInspectorWidth(width: number, containerWidth: number): number {
  return Math.round(
    Math.min(inspectorMaximumWidth(containerWidth), Math.max(300, Number.isFinite(width) ? width : 360)),
  );
}

/** Uses only the plugin page and its separator; capture belongs to this mount. */
export function useChatroomInspector(root: RefObject<HTMLElement | null>, open: boolean, signal: AbortSignal) {
  const [preferredWidth, setPreferredWidth] = useState(360);
  const [containerWidth, setContainerWidth] = useState(0);
  const drag = useRef<
    {
      element: HTMLDivElement;
      pointerId: number;
      startX: number;
      width: number;
    } | undefined
  >(undefined);
  const endResize = () => {
    const current = drag.current;
    drag.current = undefined;
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  };
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    const measure = () => {
      setContainerWidth(element.clientWidth);
      if (element.clientWidth < 900) endResize();
    };
    measure();
    const Observer = element.ownerDocument.defaultView?.ResizeObserver;
    const observer = Observer === undefined ? undefined : new Observer(measure);
    observer?.observe(element);
    signal.addEventListener('abort', endResize, { once: true });
    return () => {
      observer?.disconnect();
      signal.removeEventListener('abort', endResize);
      endResize();
    };
  }, [root, signal]);
  useLayoutEffect(() => {
    if (!open || signal.aborted) endResize();
  }, [open, signal]);
  const narrow = containerWidth > 0 && containerWidth < 900;
  const width = clampInspectorWidth(preferredWidth, containerWidth);
  const updateWidth = (next: number) => setPreferredWidth(clampInspectorWidth(next, root.current?.clientWidth ?? 0));
  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerId === drag.current?.pointerId) endResize();
  };
  return {
    width,
    narrow,
    separatorProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': 300,
      'aria-valuemax': Math.round(inspectorMaximumWidth(containerWidth)),
      'aria-valuenow': width,
      tabIndex: narrow ? -1 : 0,
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !open || signal.aborted || (root.current?.clientWidth ?? 0) < 900) return;
        event.preventDefault();
        endResize();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { element: event.currentTarget, pointerId: event.pointerId, startX: event.clientX, width };
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (current === undefined || event.pointerId !== current.pointerId) return;
        updateWidth(current.width + current.startX - event.clientX);
      },
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onLostPointerCapture: endPointer,
      onKeyDown: (event: { key: string; preventDefault: () => void; }) => {
        if (!open || narrow || signal.aborted) return;
        const next = event.key === 'ArrowLeft' ? width + 24 : event.key === 'ArrowRight'
          ? width - 24
          : event.key === 'Home'
          ? 300
          : event.key === 'End'
          ? inspectorMaximumWidth(containerWidth)
          : undefined;
        if (next === undefined) return;
        event.preventDefault();
        updateWidth(next);
      },
    },
  };
}
