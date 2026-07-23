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
        const d2 = await getD2();
        // compile(source) -> { diagram, renderOptions, ... }
        const result = await d2.compile(source);
        // The theme is a render-time concern in d2js and `themeID` is only
        // correctly typed on RenderOptions, so apply it here. render() returns
        // the SVG string.
        const svg = await d2.render(result.diagram, {
          ...result.renderOptions,
          themeID,
          // Omit the <?xml ...?> tag so the SVG embeds cleanly inline.
          noXMLTag: true,
        });
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
          setPreview(
            `<div class="${classes.error}">${t("D2 diagram error:")} ${DOMPurify.sanitize(message)}</div>`,
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
