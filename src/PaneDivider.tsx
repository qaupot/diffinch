import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "./i18n";

export type PaneAxis = "width" | "height";

function measure(divider: HTMLDivElement) {
  const pane = divider.previousElementSibling!;
  const layout = divider.parentElement!;
  const styles = getComputedStyle(layout);
  const bounds = pane.getBoundingClientRect();
  const axis: PaneAxis =
    styles.getPropertyValue("--pane-axis").trim() === "height" ? "height" : "width";
  const available =
    axis === "height"
      ? layout.getBoundingClientRect().bottom - bounds.top - divider.offsetHeight
      : layout.getBoundingClientRect().right - bounds.left - divider.offsetWidth;
  return {
    axis,
    available,
    min: Math.round(
      Math.min(available / 2, parseFloat(styles.getPropertyValue("--pane-min-size"))),
    ),
    max: Math.round(
      Math.max(available / 2, available - parseFloat(styles.getPropertyValue("--review-min-size"))),
    ),
    value: Math.round(bounds[axis]),
  };
}

export default function PaneDivider({
  controls,
  label,
  title,
  onResize,
}: {
  controls: string;
  label: string;
  title: string;
  onResize: (size: number | null, axis: PaneAxis, available: number) => void;
}) {
  const { t } = useTranslation();
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    axis: PaneAxis;
    startPosition: number;
    startSize: number;
  } | null>(null);
  const [size, setSize] = useState<ReturnType<typeof measure>>();

  useLayoutEffect(() => {
    const node = divider.current!;
    const layout = node.parentElement!;
    function updateSize() {
      if (!node.offsetWidth || !node.offsetHeight) return;
      const next = measure(node);
      if (drag.current && drag.current.axis !== next.axis) stopDrag(node);
      setSize(next);
    }
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node.previousElementSibling!);
    observer.observe(layout);
    return () => {
      observer.disconnect();
      stopDrag(node);
    };
  }, []);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return;
    const node = event.currentTarget;
    const { axis, value } = measure(node);
    event.preventDefault();
    node.focus({ preventScroll: true });
    drag.current = {
      pointerId: event.pointerId,
      axis,
      startPosition: axis === "height" ? event.clientY : event.clientX,
      startSize: value,
    };
    node.setPointerCapture(event.pointerId);
    node.dataset.resizing = "";
  }

  function resize(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const { axis, startPosition, startSize } = drag.current;
    const measured = measure(event.currentTarget);
    if (axis !== measured.axis) {
      stopDrag(event.currentTarget);
      return;
    }
    const position = axis === "height" ? event.clientY : event.clientX;
    const value = Math.max(
      measured.min,
      Math.min(measured.max, startSize + position - startPosition),
    );
    event.currentTarget.parentElement!.style.setProperty(`--pane-preview-${axis}`, `${value}px`);
  }

  function stopDrag(node: HTMLDivElement) {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    node.parentElement?.style.removeProperty("--pane-preview-width");
    node.parentElement?.style.removeProperty("--pane-preview-height");
    delete node.dataset.resizing;
    if (pointerId !== undefined && node.hasPointerCapture(pointerId))
      node.releasePointerCapture(pointerId);
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const node = event.currentTarget;
    if (event.type === "pointerup") {
      resize(event);
      const { value, axis, available } = measure(node);
      if (drag.current && value !== drag.current.startSize) onResize(value, axis, available);
    }
    stopDrag(node);
  }

  function resizeWithKey(event: KeyboardEvent<HTMLDivElement>) {
    const { min, max, value, axis, available } = measure(event.currentTarget);
    const step = event.shiftKey ? 40 : 10;
    switch (event.key) {
      case axis === "height" ? "ArrowUp" : "ArrowLeft":
        onResize(Math.max(min, value - step), axis, available);
        break;
      case axis === "height" ? "ArrowDown" : "ArrowRight":
        onResize(Math.min(max, value + step), axis, available);
        break;
      case "Home":
        onResize(min, axis, available);
        break;
      case "End":
        onResize(max, axis, available);
        break;
      case "Enter":
        onResize(null, axis, available);
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
      className="pane-divider"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={size?.axis === "height" ? "horizontal" : "vertical"}
      aria-controls={controls}
      aria-valuemin={size?.min}
      aria-valuemax={size?.max}
      aria-valuenow={size?.value}
      aria-valuetext={size && t("sizeInPixels", { size: size.value })}
      title={title}
      onPointerDown={startDrag}
      onPointerMove={resize}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onKeyDown={resizeWithKey}
      onDoubleClick={(event) => {
        const { axis, available } = measure(event.currentTarget);
        onResize(null, axis, available);
      }}
    />
  );
}
