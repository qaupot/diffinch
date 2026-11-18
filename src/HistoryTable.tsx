import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "./i18n";
import { preferences } from "./lib/preferences";

const columns = ["graphColumn", "labelsColumn", "commit", "author", "dateTime"] as const;
const minimums = [48, 64, 100, 60, 72];
const commitColumn = columns.indexOf("commit");

function readWidths(key: string): number[] | null {
  try {
    const widths: unknown = JSON.parse(preferences.getItem(key) ?? "null");
    if (!Array.isArray(widths)) return null;
    // Older layouts stored Graph, Commit, Author and Date. Keep their width settings.
    if (widths.length === 4) widths.splice(1, 0, 120);
    if (
      widths.length === columns.length &&
      widths.every((width, index) => Number.isFinite(width) && width >= minimums[index])
    )
      return widths;
  } catch {
    // Fall back to content-sized columns.
  }
  return null;
}

function resizePair(widths: number[], index: number, delta: number) {
  const next = [...widths];
  const change = Math.max(
    minimums[index] - widths[index],
    Math.min(widths[index + 1] - minimums[index + 1], delta),
  );
  next[index] += change;
  next[index + 1] -= change;
  return next;
}

export default function HistoryTable({
  path,
  id,
  graphWidth,
  children,
}: {
  path: string;
  id: string;
  graphWidth: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const key = `diffinch.graphColumns:${path || "example"}`;
  const [saved, setSaved] = useState(() => readWidths(key));
  const [preview, setPreview] = useState<number[] | null>(null);
  const [measured, setMeasured] = useState<number[]>([]);
  const header = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; index: number; x: number; widths: number[] } | null>(null);
  const widths = preview ?? saved;

  function measure() {
    return Array.from(header.current!.children, (cell) => cell.getBoundingClientRect().width);
  }
  function layoutFor(next: number[]) {
    // The commit column fills spare space as the pane grows or shrinks.
    // Preserve horizontal scrolling when the original tracks already overflow.
    const viewport = header.current!.parentElement!.parentElement!;
    const total = next.reduce((sum, width) => sum + width, 0);
    if (total > viewport.clientWidth + 1) return next;
    return next.map((width, index) => (index === commitColumn ? minimums[index] : width));
  }
  useLayoutEffect(() => {
    const update = () => {
      const next = measure();
      if (next.every((value) => value > 0)) setMeasured(next);
    };
    const observer = new ResizeObserver(update);
    for (const cell of header.current!.children) observer.observe(cell);
    update();
    return () => observer.disconnect();
  }, []);

  function save(next: number[] | null) {
    setSaved(next);
    if (next) preferences.setItem(key, JSON.stringify(next));
    else preferences.removeItem(key);
  }
  function stop(handle: HTMLDivElement) {
    const pointer = drag.current?.pointer;
    drag.current = null;
    setPreview(null);
    if (pointer !== undefined && handle.hasPointerCapture(pointer))
      handle.releasePointerCapture(pointer);
  }
  function move(event: PointerEvent<HTMLDivElement>, finish: boolean) {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    const delta = event.clientX - start.x;
    const next = resizePair(start.widths, start.index, delta);
    if (finish) {
      if (next[start.index] !== start.widths[start.index]) save(layoutFor(next));
      stop(event.currentTarget);
    } else {
      setPreview(delta ? layoutFor(next) : null);
    }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>, index: number) {
    const step = event.shiftKey ? 40 : 10;
    const deltas: Record<string, number> = {
      ArrowLeft: -step,
      ArrowRight: step,
      Home: -Infinity,
      End: Infinity,
    };
    if (event.key === "Escape") stop(event.currentTarget);
    else if (event.key === "Enter") {
      stop(event.currentTarget);
      save(null);
    } else if (Object.hasOwn(deltas, event.key) && !drag.current) {
      const current = measure();
      const next = resizePair(current, index, deltas[event.key]);
      if (next[index] !== current[index]) save(layoutFor(next));
    } else return;
    event.preventDefault();
  }

  const style: CSSProperties = widths
    ? {
        gridTemplateColumns: widths
          .map((width, index) =>
            index === commitColumn ? `minmax(${width}px, 1fr)` : `${width}px`,
          )
          .join(" "),
        minWidth: widths.reduce((sum, width) => sum + width, 0),
      }
    : ({ "--graph-lanes": `${Math.max(graphWidth, minimums[0])}px` } as CSSProperties);
  return (
    <div id={id} className="graph-table" style={style}>
      <div ref={header} data-virtual-sticky className="graph-columns">
        {columns.map((column, index) => (
          <div className="graph-column" key={column} style={{ minWidth: minimums[index] }}>
            <span className="truncate">{t(column)}</span>
            {index < columns.length - 1 && (
              <div
                className="graph-column-divider"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-controls={id}
                aria-label={t("resizeColumnPair", {
                  left: t(column),
                  right: t(columns[index + 1]),
                })}
                aria-valuemin={minimums[index]}
                aria-valuemax={
                  measured.length
                    ? Math.round(measured[index] + measured[index + 1] - minimums[index + 1])
                    : undefined
                }
                aria-valuenow={Math.round(measured[index] ?? minimums[index])}
                aria-valuetext={t("sizeInPixels", {
                  size: Math.round(measured[index] ?? minimums[index]),
                })}
                title={t("resizeGraphColumns")}
                onPointerDown={(event) => {
                  if (event.button !== 0 || drag.current) return;
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                  drag.current = {
                    pointer: event.pointerId,
                    index,
                    x: event.clientX,
                    widths: measure(),
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => move(event, false)}
                onPointerUp={(event) => move(event, true)}
                onLostPointerCapture={(event) => {
                  if (drag.current?.pointer === event.pointerId) stop(event.currentTarget);
                }}
                onPointerCancel={(event) => {
                  if (drag.current?.pointer === event.pointerId) stop(event.currentTarget);
                }}
                onKeyDown={(event) => keyDown(event, index)}
                onDoubleClick={() => save(null)}
              />
            )}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}
