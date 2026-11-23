import { useEffect, useState } from "react";
import { uiNow } from "./text";

/** Re-renders every `ms` while mounted (texts like "2 min ago" stay current). Returns the time of the last tick. */
export function useTicker(ms: number, on = true): number {
  const [now, setNow] = useState(() => uiNow());
  useEffect(() => {
    if (!on) return;
    setNow(uiNow());
    const h = setInterval(() => setNow(uiNow()), ms);
    return () => clearInterval(h);
  }, [ms, on]);
  return now;
}
