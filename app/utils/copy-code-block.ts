/** Copy from the click handler so plain HTTP deployments keep browser user activation. */
export async function copyCodeBlockText(value: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // A denied Clipboard API may still allow the user-initiated legacy operation.
    }
  }
  copyWithSelection(value);
}

function copyWithSelection(value: string) {
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) =>
    selection!.getRangeAt(index).cloneRange(),
  );
  const input =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const inputSelection =
    input?.selectionStart != null && input.selectionEnd != null
      ? {
          start: input.selectionStart,
          end: input.selectionEnd,
          direction: input.selectionDirection,
        }
      : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    // VueUse's legacy clipboard helper ignores this result and can report false success.
    const execCommand = Reflect.get(document, "execCommand");
    if (typeof execCommand !== "function" || !execCommand.call(document, "copy")) {
      throw new Error("Clipboard copy was rejected");
    }
  } finally {
    textarea.remove();
    if (focused instanceof HTMLElement && focused.isConnected) {
      focused.focus({ preventScroll: true });
    }
    if (input?.isConnected === true && inputSelection) {
      input.setSelectionRange(
        inputSelection.start,
        inputSelection.end,
        inputSelection.direction ?? undefined,
      );
    }
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
