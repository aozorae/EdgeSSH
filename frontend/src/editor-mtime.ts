/** A missing post-save mtime must pause autosave until the user confirms a new baseline. */
/** Unknown is distinct from an explicitly approved unconditional overwrite. */
export const UNKNOWN_MTIME = -1;

/** 保存成功后回填基线：带回 mtime 就用它，否则标为未知。 */
export function nextMtimeBaseline(reported: number | null): number {
  return reported === null ? UNKNOWN_MTIME : reported;
}

/** Null requires confirmation in FileManager; it must never silently skip validation. */
export function expectedMtimeFor(baseline: number): number | null {
  return baseline === UNKNOWN_MTIME ? null : baseline;
}
