<script setup lang="ts">
import {
  createMarkdownRenderer,
  type MarkdownRenderOptions,
} from "@codex-gateway/browser-runtime/markdown";
import { buttonVariants } from "@codex-gateway/ui/button";
import { toast } from "@codex-gateway/ui/sonner";
import { useEventListener } from "@vueuse/core";
import { computed, ref } from "vue";
import { parseRemoteFileLink } from "@/utils/file-preview-links";
import {
  escapeAttribute,
  escapeHtml,
  highlightCode,
  normalizeLanguage,
} from "@/utils/code-highlight";
import { copyCodeBlockText } from "@/utils/copy-code-block";
import { useFilePreviewContext } from "@/composables/files/useFilePreviewContext";
import { useGatewayFileWorkspaceStore } from "@/stores/file-workspace";
import { useStreamRenderScheduler } from "@/composables/rendering/useStreamRenderScheduler";

const props = withDefaults(
  defineProps<{
    content: string;
    compact?: boolean;
    diffLanguage?: string;
    streaming?: boolean;
  }>(),
  {
    compact: false,
    diffLanguage: "",
    streaming: false,
  },
);

const markdown = createMarkdownRenderer();
const { t } = useI18n();
const copyLabelPlaceholder = "<span data-code-copy-label></span>";
const copyButtonClass = escapeAttribute(buttonVariants({ variant: "ghost", size: "lg" }));

const root = ref<HTMLElement | null>(null);
const filePreviewContext = useFilePreviewContext();
const fileWorkspace = useGatewayFileWorkspaceStore();
const markdownScheduler = useStreamRenderScheduler({
  source: () => [props.content || "", props.diffLanguage] as const,
  renderImmediately: ([content]) => renderMarkdownImmediately(content),
  shouldEnhance: ([content]) => markdown.hasCodeFences(content),
  renderEnhanced: ([content, diffLanguage], signal) =>
    renderMarkdownEnhanced(content, diffLanguage, signal),
  streaming: () => props.streaming,
});

// Translate only the generated label: locale changes must not rerun syntax highlighting.
const rendered = computed(() =>
  (markdownScheduler.output.value?.html ?? "").replaceAll(copyLabelPlaceholder, () =>
    escapeHtml(t("app.copyCodeBlock")),
  ),
);

function codeBlockSnapshot() {
  const codeBlocks: string[] = [];
  const options: MarkdownRenderOptions = {
    wrapCodeBlock(block, html) {
      const index = codeBlocks.push(block.content) - 1;
      return `<div class="markdown-code-block"><div class="markdown-code-toolbar"><button type="button" class="${copyButtonClass}" data-copy-code-block="${index}">${copyLabelPlaceholder}</button></div>${html}</div>`;
    },
  };
  return { codeBlocks, options };
}

function renderMarkdownImmediately(content: string) {
  const { codeBlocks, options } = codeBlockSnapshot();
  return { html: markdown.render(content, options), codeBlocks };
}

async function renderMarkdownEnhanced(content: string, diffLanguage: string, signal: AbortSignal) {
  const { codeBlocks, options } = codeBlockSnapshot();
  const html = await markdown.renderEnhanced(
    content,
    async (fence) => {
      const normalizedLanguage = normalizeLanguage(fence.language.trim().split(/\s+/)[0] ?? "");
      if (normalizedLanguage === "diff") {
        return `<pre class="syntax-highlight language-diff"><code>${await renderDiff(fence.content, diffLanguage, signal)}</code></pre>`;
      }
      return `<pre class="shiki-block syntax-highlight language-${escapeAttribute(normalizedLanguage || "text")}"><code>${await highlightCode(fence.content, normalizedLanguage)}</code></pre>`;
    },
    signal,
    options,
  );
  // Publish the source map with its HTML; discarded async renders cannot alter visible copies.
  return { html, codeBlocks };
}

async function renderDiff(value: string, language: string, signal: AbortSignal) {
  const normalizedLanguage = normalizeLanguage(language);
  const lines: string[] = [];
  // This runs only after the shared streaming scheduler settles. Keep it sequential: launching
  // hundreds of Shiki jobs with Promise.all makes a large completed patch contend with UI layout.
  for (const line of value.split("\n")) {
    signal.throwIfAborted();
    const className = diffLineClass(line);
    lines.push(
      `<span class="${className}">${await renderDiffLine(line, normalizedLanguage)}</span>`,
    );
  }
  return lines.join("");
}

function diffCodeLine(line: string) {
  const marker = line[0];
  return marker === "+" || marker === "-" || marker === " " ? line.slice(1) : line;
}

async function renderDiffLine(line: string, language: string) {
  if (!line) return " ";
  if (
    line.startsWith("@@") ||
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("+++") ||
    line.startsWith("---")
  ) {
    return escapeHtml(line);
  }
  const marker = line[0];
  if (marker !== "+" && marker !== "-" && marker !== " ") {
    return await highlightCode(line, language);
  }
  const code = diffCodeLine(line);
  return `<span class="diff-line-marker">${escapeHtml(marker)}</span>${await highlightCode(code || " ", language)}`;
}

function diffLineClass(line: string) {
  if (line.startsWith("@@")) {
    return "diff-line diff-line-hunk";
  }
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("+++") ||
    line.startsWith("---")
  ) {
    return "diff-line diff-line-meta";
  }
  if (line.startsWith("+")) {
    return "diff-line diff-line-add";
  }
  if (line.startsWith("-")) {
    return "diff-line diff-line-remove";
  }
  return "diff-line";
}

function handleClick(event: MouseEvent) {
  const copyButton = (event.target as Element | null)?.closest?.<HTMLButtonElement>(
    "button[data-copy-code-block]",
  );
  if (copyButton && root.value?.contains(copyButton)) {
    event.preventDefault();
    const index = Number(copyButton.dataset.copyCodeBlock);
    const value = markdownScheduler.output.value?.codeBlocks[index];
    if (value !== undefined) void copyCode(value);
    return;
  }
  const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || !filePreviewContext) {
    return;
  }
  const target = parseRemoteFileLink(anchor.href, window.location.href);
  if (!target) {
    return;
  }
  const hostId = filePreviewContext.hostId.value;
  const threadId = filePreviewContext.threadId.value;
  if (!hostId || !threadId) {
    return;
  }
  event.preventDefault();
  void fileWorkspace.openFile({
    hostId,
    projectId: filePreviewContext.projectId.value,
    threadId,
    path: target.path,
    line: target.line,
  });
}

async function copyCode(value: string) {
  try {
    await copyCodeBlockText(value);
    toast.success(t("app.codeBlockCopied"));
  } catch {
    toast.error(t("app.copyCodeBlockFailed"));
  }
}

useEventListener(root, "click", handleClick);
</script>

<template>
  <div
    ref="root"
    class="markdown-content"
    :class="{ 'markdown-content-compact': compact }"
    v-html="rendered"
  />
</template>
