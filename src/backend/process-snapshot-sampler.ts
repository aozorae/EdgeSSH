import { LinuxCPUSampler } from './linux-cpu-sampler';
import { parseTopSnapshot, type ProcessSnapshot } from './top-parser';

export const PROCESS_LINUX_CPU_MARKER = '__CF_WEBSSH_LINUX_CPU__';

// One instance per monitor exec channel, never shared between SSH connections.
export class ProcessSnapshotSampler {
  private readonly cpu = new LinuxCPUSampler();
  private linux = false;

  reset(): void {
    this.cpu.reset();
    this.linux = false;
  }

  parse(raw: string, timestamp = Date.now()): ProcessSnapshot | null {
    const lines = raw.replace(/\r/g, '').split('\n');
    const index = lines.indexOf(PROCESS_LINUX_CPU_MARKER);
    if (index >= 0) this.linux = true;
    const snapshot = parseTopSnapshot(raw, timestamp);
    if (this.linux) {
      // Read exactly the line after the marker. Missing/malformed /proc/stat
      // must yield null, not top's unreliable first-frame CPU percentage.
      const percent = this.cpu.sample(index >= 0 ? lines[index + 1] ?? '' : '');
      if (snapshot) snapshot.metrics.cpuPercent = percent;
    }
    return snapshot;
  }
}
