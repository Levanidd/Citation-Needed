import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

interface Props {
  disabled: boolean;
  onSubmit: (question: string) => void;
  onStop?: () => void;
  autoFocus?: boolean;
}

export function ChatInput({ disabled, onSubmit, onStop, autoFocus }: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const valid = value.trim().length >= 5 && value.trim().length <= 500;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled || !valid) return;
    onSubmit(value.trim());
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-2 shadow-card focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/15"
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        maxLength={500}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={disabled ? "Research in progress…" : "Name a company or vendor, or ask a research question…"}
        aria-label="Research question"
        className="max-h-44 min-h-11 flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] text-fg outline-none placeholder:text-subtle disabled:opacity-60"
      />
      {disabled && onStop ? (
        <button
          type="button"
          onClick={onStop}
          className="h-11 shrink-0 rounded-[14px] border border-neg/30 bg-neg/15 px-4 text-sm font-semibold text-neg transition active:scale-[0.97]"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!valid}
          className="h-11 shrink-0 rounded-[14px] bg-gradient-to-br from-[#935CFF] to-[#6D28D9] px-5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(147,92,255,0.35)] transition active:scale-[0.97] disabled:opacity-40 disabled:shadow-none"
        >
          Research
        </button>
      )}
    </form>
  );
}
