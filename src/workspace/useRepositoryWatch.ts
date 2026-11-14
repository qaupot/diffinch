import { useEffect, useEffectEvent } from "react";
import { git, type RefreshScope } from "../lib/git";

export function useRepositoryWatch(
  active: boolean,
  path: string,
  onRefresh: (scope: RefreshScope) => boolean,
) {
  const refresh = useEffectEvent(onRefresh);
  useEffect(() => {
    if (!active || !path) return;
    const id = crypto.randomUUID();
    let stopped = false;
    let watching = false;
    let fallback = false;
    let timer = 0;
    let batchStarted = 0;
    let pending: RefreshScope | null = null;
    function flush() {
      if (!pending) return;
      if (refresh(pending)) {
        pending = null;
        batchStarted = 0;
      } else timer = window.setTimeout(flush, 300);
    }
    function enqueue(scope: RefreshScope) {
      if (stopped) return;
      if (scope === "unavailable") fallback = true;
      pending = pending === "full" || scope !== "working" ? "full" : "working";
      const now = performance.now();
      batchStarted ||= now;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, Math.max(0, Math.min(200, batchStarted + 1000 - now)));
    }
    const onFocus = () => enqueue("full");
    const stopWatching = () => {
      void git.unwatch(id).catch(() => {});
    };
    void git
      .watch(path, id, enqueue)
      .then(() => {
        watching = true;
        if (stopped) stopWatching();
        else enqueue("full");
      })
      .catch(() => enqueue("unavailable"));
    const poll = window.setInterval(() => {
      if (fallback && document.hasFocus()) onFocus();
    }, 7000);
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      if (watching) stopWatching();
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [active, path]);
}
