import { katex } from "@mdit/plugin-katex";
import "katex/dist/katex.min.css";
import MarkdownIt from "markdown-it";

export interface MarkdownCodeFence {
  content: string;
  language: string;
}

export type MarkdownCodeFenceRenderer = (fence: MarkdownCodeFence) => Promise<string | undefined>;

export interface MarkdownRenderOptions extends Record<string, unknown> {
  wrapCodeBlock?: (block: MarkdownCodeFence, html: string) => string;
}

export interface MarkdownRenderer {
  hasCodeFences(content: string): boolean;
  render(content: string, options?: MarkdownRenderOptions): string;
  renderEnhanced(
    content: string,
    renderFence: MarkdownCodeFenceRenderer,
    signal?: AbortSignal,
    options?: MarkdownRenderOptions,
  ): Promise<string>;
}

export function createMarkdownRenderer(): MarkdownRenderer {
  const highlightedFences = new WeakMap<object, string>();
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
  });

  markdown.use(katex, {
    delimiters: "all",
    throwOnError: false,
    // Plugin 1.1.3 owns KaTeX's strict callback through logger; strict:false is overwritten.
    // Keep tolerant rendering for model-authored math via the plugin's documented hook.
    logger: (): "ignore" => "ignore",
    trust: false,
  });

  for (const type of ["fence", "code_block"] as const) {
    const defaultRenderer = markdown.renderer.rules[type];
    markdown.renderer.rules[type] = (tokens, index, options, environment, self) => {
      const token = tokens[index];
      const highlightedHtml = token === undefined ? undefined : highlightedFences.get(token);
      const html =
        highlightedHtml ??
        (defaultRenderer === undefined
          ? self.renderToken(tokens, index, options)
          : defaultRenderer(tokens, index, options, environment, self));
      const { wrapCodeBlock } = environment as MarkdownRenderOptions;
      return token === undefined || wrapCodeBlock === undefined
        ? html
        : wrapCodeBlock({ content: token.content, language: token.info }, html);
    };
  }

  function parse(content: string) {
    return markdown.parse(content, {});
  }

  function renderTokens(tokens: ReturnType<typeof parse>, options: MarkdownRenderOptions = {}) {
    const environment = options as unknown as Parameters<typeof markdown.renderer.render>[2];
    return markdown.renderer.render(tokens, markdown.options, environment);
  }

  return {
    hasCodeFences(content) {
      return parse(content).some((token) => token.type === "fence");
    },
    render(content, options) {
      return renderTokens(parse(content), options);
    },
    async renderEnhanced(content, renderFence, signal, options) {
      signal?.throwIfAborted();
      const tokens = parse(content);
      for (const token of tokens) {
        signal?.throwIfAborted();
        if (token.type !== "fence") {
          continue;
        }
        const highlightedHtml = await renderFence({
          content: token.content,
          language: token.info,
        });
        signal?.throwIfAborted();
        if (highlightedHtml !== undefined) {
          highlightedFences.set(token, highlightedHtml);
        }
      }
      return renderTokens(tokens, options);
    },
  };
}
