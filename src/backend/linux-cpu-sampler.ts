// user/nice already include guest/guest_nice in /proc/stat. Sum only the first
// eight counters; adding guest again would double count virtual CPU execution.
const CPU_COUNTER_COUNT = 8;

export function parseLinuxCPUCounters(raw: string): bigint[] | null {
  const line = raw.split('\n').find((line) => /^cpu\s/.test(line));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1);
  // Linux always supplies user, nice, system and idle. Older kernels may omit
  // subsequent fields; missing optional fields are zero, malformed fields aren't.
  if (fields.length < 4 || fields.some((field) => !/^\d+$/.test(field))) return null;
  return Array.from({ length: CPU_COUNTER_COUNT }, (_, i) => BigInt(fields[i] ?? '0'));
}

export class LinuxCPUSampler {
  private previous: bigint[] | null = null;

  reset(): void {
    this.previous = null;
  }

  sample(raw: string): number | null {
    const counters = parseLinuxCPUCounters(raw);
    const previous = this.previous;
    // Invalid/missing samples break continuity. Recover with a new baseline
    // instead of comparing against counters from before a telemetry gap.
    this.previous = counters;
    if (!counters || !previous) return null;
    const deltas = counters.map((value, i) => value - previous[i]);
    // Reboot, rollover, hotplug or a backwards iowait counter: rebaseline rather
    // than clamp a negative delta into a plausible but incorrect percentage.
    if (deltas.some((delta) => delta < 0n)) return null;
    const total = deltas.reduce((sum, delta) => sum + delta, 0n);
    if (total === 0n) return null;
    // This monitor counts iowait as idle (not CPU execution), like common
    // utilization dashboards. steal remains busy. Report percent, not load average.
    const idle = deltas[3] + deltas[4];
    return Number(((total - idle) * 1_000_000n) / total) / 10_000;
  }
}
