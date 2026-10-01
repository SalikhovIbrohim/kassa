import type { ReactNode } from "react";
import type { EntryNote } from "./useEntry";

/**
 * Where a form says what became of its last entry. The place is always there, and empty when there is
 * nothing to say: a message put into a place that already exists is read out by a screen reader, while
 * one that arrives together with its container often is not.
 */
export function EntryStatus({ note, children }: { note: EntryNote | null; children?: ReactNode }) {
  return (
    <div className="entry-status" role="status" aria-live="polite">
      {note && <p className={note.kind === "blocked" ? "queued blocked" : "queued"}>{note.text}</p>}
      {children}
    </div>
  );
}
