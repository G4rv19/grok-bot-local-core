import { o as interop } from "./chunk-rolldown-runtime-BCiCTKAo.js";
import {
  Kt as reactRuntime,
  Gt as jsxRuntime,
} from "./index.eager-common-B73tST-1.js";
import {
  tS as NativeButton,
  YS as typeStyle,
} from "./index.eager-app-Bpx4jnxc.js";
export const React = interop(reactRuntime(), 1),
  h = jsxRuntime();
export function Button({ children, pending = false, ...props }) {
  return h.jsx(NativeButton, {
    type: "button",
    size: "md",
    variant: "secondary",
    style: typeStyle.body2,
    ...props,
    disabled: pending || props.disabled,
    children: pending ? "Working…" : children,
  });
}
export function Glyph({ name, size = 18 }) {
  const paths = {
    clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    tasks: "m4 6 2 2 4-4M13 6h7M4 13h16M4 19h16",
    mail: "M3 5h18v14H3zM3 6l9 7 9-7",
    calendar: "M3 5h18v16H3zM7 3v4M17 3v4M3 10h18",
    code: "m8 6-6 6 6 6M16 6l6 6-6 6",
    plus: "M12 4v16M4 12h16",
    chevron: "m6 9 6 6 6-6",
    check: "m5 12 4 4L19 6",
    close: "m6 6 12 12M18 6 6 18",
  };
  return h.jsx("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.65,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: h.jsx("path", { d: paths[name] || paths.tasks }),
  });
}
export function useResource(channel, scope) {
  const [data, setData] = React.useState(null),
    [error, setError] = React.useState(null),
    [pending, setPending] = React.useState(null);
  const generation = React.useRef(0),
    sequence = React.useRef(0),
    applied = React.useRef(0);
  const request = async (input, gen) => {
    const seq = ++sequence.current;
    const result = await window.grokLocal[channel](input);
    if (gen === generation.current && seq >= applied.current) {
      applied.current = seq;
      setData(result);
    }
    return result;
  };
  React.useEffect(() => {
    const gen = ++generation.current;
    let alive = true,
      flight = false,
      again = false;
    setData(null);
    setError(null);
    setPending(null);
    const refresh = async () => {
      if (flight) {
        again = true;
        return;
      }
      flight = true;
      try {
        await request(
          { action: "status", ...(scope ? { agentId: scope } : {}) },
          gen,
        );
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        flight = false;
        if (again && alive) {
          again = false;
          refresh();
        }
      }
    };
    if (channel !== "work" || scope) refresh();
    const unsubscribe = window.grokLocal.subscribe((event) => {
      if (
        event.kind === (channel === "work" ? "work" : "connections") &&
        (!scope || event.agentIds?.includes(scope))
      )
        refresh();
    });
    const timer = setInterval(refresh, 15000);
    return () => {
      alive = false;
      generation.current++;
      clearInterval(timer);
      unsubscribe();
    };
  }, [channel, scope]);
  const send = async (input, key = input.id || input.action) => {
    const gen = generation.current;
    setPending(key);
    setError(null);
    try {
      return await request(
        { ...input, ...(scope ? { agentId: scope } : {}) },
        gen,
      );
    } catch (e) {
      if (gen === generation.current) setError(e.message);
      throw e;
    } finally {
      if (gen === generation.current) setPending(null);
    }
  };
  return {
    data: channel === "work" && data?.agentId !== scope ? null : data,
    error,
    pending,
    send,
    clearError: () => setError(null),
  };
}
export const nonce = () => crypto.randomUUID();
export function when(timestamp, timeZone) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
export function localDateTime(
  timestamp = Date.now() + 3600000,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(timestamp))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
