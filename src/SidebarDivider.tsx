import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "./i18n";

function measure(divider: HTMLDivElement) {
  const sidebar = divider.parentElement!;
  const layout = sidebar.parentElement!;
  const styles = getComputedStyle(layout);
  const min = parseFloat(styles.getPropertyValue("--sidebar-min-width"));
  const max = Math.max(
    min,
    Math.min(
      parseFloat(styles.getPropertyValue("--sidebar-max-width")),
      layout.getBoundingClientRect().width -
        parseFloat(styles.getPropertyValue("--workspace-min-width")),
    ),
  );
  return { min, max: Math.round(max), width: Math.round(sidebar.getBoundingClientRect().width) };
}

export default function SidebarDivider({
  controls,
  onResize,
}: {
  controls: string;
  onResize: (width: number | null) => void;
}) {
  const { t } = useTranslation();
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [size, setSize] = useState<ReturnType<typeof measure>>();

  function stopDrag(node: HTMLDivElement) {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    node.parentElement?.parentElement?.style.removeProperty("--sidebar-preview-width");
    delete node.dataset.resizing;
    if (pointerId !== undefined && node.hasPointerCapture(pointerId))
      node.releasePointerCapture(pointerId);
  }

  useLayoutEffect(() => {
    const node = divider.current!;
    const sidebar = node.parentElement!;
    function updateSize() {
      if (!node.offsetWidth) {
        stopDrag(node);
        return;
      }
      setSize(measure(node));
    }
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(sidebar);
    observer.observe(sidebar.parentElement!);
    return () => {
      observer.disconnect();
      stopDrag(node);
    };
  }, []);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return;
    const node = event.currentTarget;
    event.preventDefault();
    node.focus({ preventScroll: true });
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: measure(node).width,
    };
    node.setPointerCapture(event.pointerId);
    node.dataset.resizing = "";
  }

  function resize(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const { min, max } = measure(event.currentTarget);
    const width = Math.max(
      min,
      Math.min(max, drag.current.startWidth + event.clientX - drag.current.startX),
    );
    event.currentTarget.parentElement!.parentElement!.style.setProperty(
      "--sidebar-preview-width",
      `${width}px`,
    );
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.type === "pointerup") {
      resize(event);
      const { width } = measure(event.currentTarget);
      if (width !== drag.current.startWidth) onResize(width);
    }
    stopDrag(event.currentTarget);
  }

  function resizeWithKey(event: KeyboardEvent<HTMLDivElement>) {
    const { min, max, width } = measure(event.currentTarget);
    const step = event.shiftKey ? 40 : 10;
    switch (event.key) {
      case "ArrowLeft":
        onResize(Math.max(min, width - step));
        break;
      case "ArrowRight":
        onResize(Math.min(max, width + step));
        break;
      case "Home":
        onResize(min);
        break;
      case "End":
        onResize(max);
        break;
      case "Enter":
        onResize(null);
        break;
      case "Escape":
        stopDrag(event.currentTarget);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div
      ref={divider}
      className="sidebar-divider"
      role="separator"
      tabIndex={0}
      aria-label={t("sidebarWidth")}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={size?.min}
      aria-valuemax={size?.max}
      aria-valuenow={size?.width}
      aria-valuetext={size && t("sidebarWidthInPixels", { width: size.width })}
      title={t("resizeSidebar")}
      onPointerDown={startDrag}
      onPointerMove={resize}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onKeyDown={resizeWithKey}
      onDoubleClick={() => onResize(null)}
    />
  );
}
