import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useVirtualRows(count: number, height: number, sticky = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const measuredHeight = useRef(height);
  const [viewport, setViewport] = useState({ top: 0, height: 0, rowHeight: height, sticky });
  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    // CSS owns row sizing. Measuring it keeps spacers and reveal offsets correct
    // when the user enlarges text, including while already scrolled into a list.
    const rowHeight =
      node.querySelector<HTMLElement>("[data-virtual-row]")?.getBoundingClientRect().height ||
      measuredHeight.current;
    const stickyHeight =
      node.querySelector<HTMLElement>("[data-virtual-sticky]")?.getBoundingClientRect().height ||
      sticky;
    if (rowHeight !== measuredHeight.current) {
      node.scrollTop *= rowHeight / measuredHeight.current;
      measuredHeight.current = rowHeight;
    }
    const top = node.scrollTop;
    const height = node.clientHeight;
    setViewport((current) =>
      current.top === top &&
      current.height === height &&
      current.rowHeight === rowHeight &&
      current.sticky === stickyHeight
        ? current
        : { top, height, rowHeight, sticky: stickyHeight },
    );
  }, [sticky]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const selector of ["[data-virtual-row]", "[data-virtual-sticky]"]) {
      const row = node.querySelector(selector);
      if (row) observer.observe(row);
    }
    measure();
    return () => observer.disconnect();
  });

  function reveal(index: number) {
    const node = ref.current;
    if (!node || index < 0 || index >= count) return;
    const { rowHeight: height, sticky } = viewport;
    const top = index * height;
    if (node.scrollTop > top) node.scrollTop = top;
    else if (node.scrollTop + node.clientHeight - sticky < top + height) {
      node.scrollTop = top + height + sticky - node.clientHeight;
    }
    measure();
  }

  const rowHeight = viewport.rowHeight;
  const visible = Math.max(1, Math.ceil(viewport.height / rowHeight));
  const start = Math.max(0, Math.min(count - visible, Math.floor(viewport.top / rowHeight)) - 12);
  const end = Math.min(count, start + visible + 25);
  return {
    ref,
    measure,
    rowHeight,
    start,
    end,
    before: start * rowHeight,
    after: (count - end) * rowHeight,
    reveal,
  };
}
