import { NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useComputedColorScheme } from "@mantine/core";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";
import type { D2 as D2Type } from "@terrastruct/d2";
import classes from "./code-block.module.css";

interface D2ViewProps {
  props: NodeViewProps;
}

interface D2CompileError {
  range?: string;
  errmsg?: string;
}

// D2's compiler rejects with an Error whose `.message` is a JSON array of
// { range, errmsg } objects — e.g.
//   [{"range":"index,2:2:38-2:11:47","errmsg":"index:3:3: edge map keys ..."}]
// Turn that into readable, line-prefixed text. Render/WASM errors come through
// as plain strings, so fall back to the raw message whenever it isn't the
// expected JSON array shape.
function formatD2Error(message: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return [message];
  }
  if (!Array.isArray(parsed)) return [message];
  const lines = (parsed as D2CompileError[])
    .map((e) => e?.errmsg)
    .filter((m): m is string => typeof m === "string")
    // "index:3:3: edge map keys ..." -> "Line 3: edge map keys ..."
    .map((m) => m.replace(/^index:(\d+):\d+:\s*/, "Line $1: "));
  return lines.length ? lines : [message];
}

// D2 built-in theme IDs. 0 is the neutral default (light); 200 is "Dark Mauve".
const D2_LIGHT_THEME = 0;
const D2_DARK_THEME = 200;

// The D2 package ships a multi-MB WASM build and spins up a Web Worker the
// moment a `D2` instance is constructed. Create a single shared instance
// (lazily, so the WASM only loads when the first D2 block renders) and reuse
// it for every block and every re-render.
let d2InstancePromise: Promise<D2Type> | null = null;
function getD2(): Promise<D2Type> {
  if (!d2InstancePromise) {
    d2InstancePromise = import("@terrastruct/d2")
      .then(({ D2 }) => new D2())
      .catch((err) => {
        // Don't cache a rejected load; otherwise every future D2 block would
        // be stuck on the failure. Clearing it lets a later render retry.
        d2InstancePromise = null;
        throw err;
      });
  }
  return d2InstancePromise;
}

// The shared worker correlates responses to requests through a single resolver
// slot with no request IDs. So two overlapping compile()/render() calls — e.g.
// two D2 blocks, or one block re-running its effect when the resolved color
// scheme settles on mount — cross their results: a render() can resolve with a
// compile()'s response object, which then sanitizes to the string
// "[object Object]". Serialize every access to the instance so only one request
// is ever in flight. The worker already handles messages one at a time, so this
// only fixes the JS-side correlation and costs no real throughput.
let d2Queue: Promise<unknown> = Promise.resolve();
function withD2<T>(fn: (d2: D2Type) => Promise<T>): Promise<T> {
  const run = d2Queue.then(() => getD2()).then(fn);
  // Keep the chain alive whether this run resolves or rejects, without leaking
  // the rejection to the next queued caller.
  d2Queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export default function D2View({ props }: D2ViewProps) {
  const { t } = useTranslation();
  const computedColorScheme = useComputedColorScheme();
  const { node } = props;
  const [preview, setPreview] = useState<string>("");

  // D2 is much heavier than Mermaid (a WASM compile + render round-trip through
  // a worker), so debounce the source instead of recompiling on every keystroke.
  const [debouncedContent] = useDebouncedValue(node.textContent, 300);

  // Re-render whenever the debounced content or the theme changes.
  useEffect(() => {
    let cancelled = false;
    const source = debouncedContent;

    if (source.trim().length === 0) {
      setPreview("");
      return;
    }

    const themeID =
      computedColorScheme === "light" ? D2_LIGHT_THEME : D2_DARK_THEME;

    (async () => {
      try {
        // Run compile + render as one atomic unit on the serialized queue so a
        // concurrent block/re-render can't cross its result into ours.
        const svg = await withD2((d2) =>
          // compile(source) -> { diagram, renderOptions, ... }
          d2.compile(source).then((result) =>
            // The theme is a render-time concern in d2js and `themeID` is only
            // correctly typed on RenderOptions, so apply it here. render()
            // returns the SVG string.
            d2.render(result.diagram, {
              ...result.renderOptions,
              themeID,
              // Omit the <?xml ...?> tag so the SVG embeds cleanly inline.
              noXMLTag: true,
            }),
          ),
        );
        // Defensive: a correctly-serialized render always yields a string. If it
        // somehow doesn't, fail into the error branch instead of sanitizing an
        // object down to the literal "[object Object]".
        if (typeof svg !== "string") {
          throw new Error("D2 render did not return an SVG string");
        }
        // D2 gives no XSS guarantee for its SVG output (unlike Mermaid's
        // strict mode), and this goes into dangerouslySetInnerHTML in a
        // collaborative doc, so sanitize it. D2 renders text/markdown labels
        // inside <foreignObject> HTML, so the `html` profile is enabled
        // alongside the svg profiles to preserve labels; DOMPurify still
        // strips <script>, on* handlers, and javascript:/dangerous URIs.
        const clean = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
        });
        if (!cancelled) setPreview(clean);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (props.editor.isEditable) {
          const lines = formatD2Error(message).map((line) =>
            DOMPurify.sanitize(line),
          );
          setPreview(
            `<div class="${classes.error}">${t("D2 diagram error:")}<br>${lines.join("<br>")}</div>`,
          );
        } else {
          setPreview(
            `<div class="${classes.error}">${t("Invalid D2 diagram")}</div>`,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [debouncedContent, computedColorScheme]);

  return (
    <div
      className={classes.d2}
      contentEditable={false}
      dangerouslySetInnerHTML={{ __html: preview }}
    ></div>
  );
}
