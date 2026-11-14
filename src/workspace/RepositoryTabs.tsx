import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "../i18n";
import { FolderGit2, X } from "../icons";
import { native } from "../lib/git";
import type { RepositoryTab } from "./types";

type DropTarget = { path: string; side: "before" | "after" };
type Drag = {
  path: string;
  node: HTMLButtonElement;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  frame?: number;
  target: DropTarget | null;
};

export default function RepositoryTabs({
  tabs,
  activePath,
  onSelect,
  onClose,
  onReorder,
}: {
  tabs: RepositoryTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (path: string, targetPath: string, side: "before" | "after") => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const activeTab = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const stopDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.frame !== undefined) cancelAnimationFrame(current.frame);
    if (current?.node.hasPointerCapture(current.pointerId))
      current.node.releasePointerCapture(current.pointerId);
    setDragging(null);
    setTarget(null);
  }, []);

  useEffect(() => {
    function cancelWithKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        stopDrag();
      }
    }
    window.addEventListener("blur", stopDrag);
    window.addEventListener("keydown", cancelWithKey);
    return () => {
      window.removeEventListener("blur", stopDrag);
      window.removeEventListener("keydown", cancelWithKey);
      stopDrag();
    };
  }, [stopDrag]);

  useLayoutEffect(() => {
    if (native) activeTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs.length]);

  function previewDrop() {
    const current = drag.current;
    const container = list.current;
    if (!current || !container) return;
    const bounds = container.getBoundingClientRect();
    const inside =
      current.x >= bounds.left &&
      current.x <= bounds.right &&
      current.y >= bounds.top &&
      current.y <= bounds.bottom;
    let next: DropTarget | null = null;
    if (inside) {
      const edge = Math.min(32, bounds.width / 4);
      if (current.x < bounds.left + edge) container.scrollLeft -= 8;
      else if (current.x > bounds.right - edge) container.scrollLeft += 8;
      for (const node of container.querySelectorAll<HTMLElement>("[data-repository-path]")) {
        const path = node.dataset.repositoryPath!;
        if (path === current.path) continue;
        const rect = node.getBoundingClientRect();
        if (current.x < rect.left + rect.width / 2) {
          next = { path, side: "before" };
          break;
        }
        next = { path, side: "after" };
      }
    }
    current.target = next;
    setTarget((previous) =>
      previous?.path === next?.path && previous?.side === next?.side ? previous : next,
    );
  }

  function autoScroll() {
    previewDrop();
    if (drag.current) drag.current.frame = requestAnimationFrame(autoScroll);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, path: string) {
    if (event.button !== 0 || tabs.length < 2 || drag.current) return;
    suppressClick.current = false;
    drag.current = {
      path,
      node: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      target: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (!current.moved) {
      if (Math.hypot(current.x - current.startX, current.y - current.startY) < 5) return;
      current.moved = true;
      suppressClick.current = true;
      setDragging(current.path);
      current.frame = requestAnimationFrame(autoScroll);
    }
    event.preventDefault();
    previewDrop();
  }

  function reorder(path: string, destination: DropTarget) {
    const remaining = tabs.filter((tab) => tab.snapshot.path !== path);
    const index = remaining.findIndex((tab) => tab.snapshot.path === destination.path);
    const source = tabs.find((tab) => tab.snapshot.path === path);
    if (!source || index === -1) return;
    const position = index + (destination.side === "after" ? 1 : 0);
    if (tabs[position]?.snapshot.path === path) return;
    onReorder(path, destination.path, destination.side);
    setAnnouncement(
      t("repositoryPosition", {
        name: source.snapshot.name,
        position: position + 1,
        count: tabs.length,
      }),
    );
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.moved) {
      current.x = event.clientX;
      current.y = event.clientY;
      previewDrop();
      if (current.target) reorder(current.path, current.target);
    }
    stopDrag();
  }

  function reorderWithKey(event: KeyboardEvent<HTMLButtonElement>, path: string) {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const offset = event.key === "ArrowLeft" ? -1 : 1;
    const index = tabs.findIndex((tab) => tab.snapshot.path === path);
    const neighbor = tabs[index + offset];
    if (neighbor) {
      reorder(path, { path: neighbor.snapshot.path, side: offset < 0 ? "before" : "after" });
      const node = event.currentTarget;
      requestAnimationFrame(() => node.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
  }

  return (
    <div ref={list} className="repository-tab-list" data-reordering={dragging !== null}>
      {tabs.map(({ snapshot: { path, name } }) => (
        <div
          key={path}
          className={`repository-tab${path === activePath ? " selected" : ""}`}
          data-repository-path={path}
          data-dragging={dragging === path}
          data-drop-side={target?.path === path ? target.side : undefined}
        >
          <button
            ref={path === activePath ? activeTab : undefined}
            className="tab-select"
            aria-pressed={path === activePath}
            aria-description={tabs.length > 1 ? t("reorderRepository") : undefined}
            aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
            title={tabs.length > 1 ? `${path}\n${t("reorderRepository")}` : path}
            data-reorderable={tabs.length > 1}
            onPointerDown={(event) => startDrag(event, path)}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={stopDrag}
            onLostPointerCapture={stopDrag}
            onDragStart={(event) => event.preventDefault()}
            onKeyDown={(event) => reorderWithKey(event, path)}
            onClick={(event) => {
              if (suppressClick.current && event.detail !== 0) {
                suppressClick.current = false;
                return;
              }
              onSelect(path);
            }}
          >
            <FolderGit2 size={14} />
            <span className="truncate">{name}</span>
          </button>
          <button
            className="tab-close icon-button"
            aria-label={t("closeRepository", { name })}
            title={t("closeRepository", { name: path })}
            onClick={() => onClose(path)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
    </div>
  );
}
