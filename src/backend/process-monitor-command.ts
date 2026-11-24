export const PROCESS_SNAPSHOT_MARKER = '__CF_WEBSSH_TOP_SNAPSHOT__';
// Octal escapes keep the delimiter itself out of the command line shown by top.
// `top` flags differ across platforms: Linux procps uses `-n 1` (1 iteration) + `-c` (full command line),
// but on FreeBSD `-n 1` means "show 1 process" and `-w` is unsupported — so the previous
// Linux-only fallback chain silently truncated FreeBSD output to a single process row.
// `-c` is required on Linux/macOS because their top defaults to showing just the program name;
// FreeBSD top shows the full command line by default.
// Width handling: without a tty, top (both procps and busybox) defaults to a narrow width and
// truncates long command lines with a '+' marker. procps supports `-w 0` (unlimited); busybox
// rejects `-w` and falls back to the plain form, but honors the COLUMNS env var — so we export
// COLUMNS=4096 and use a fallback chain on Linux to cover both implementations.
//   Linux:    top -b -c -n 1 -w 0  ||  top -b -c -n 1  ||  top -b -n 1
//   FreeBSD:  top -b -a -d 1            (batch, all processes, 1 iteration)
//   macOS:    top -l 1 -c -n 0 -s 0     (1 log sample, full command line, all processes, no delay)
// Network sampling: every loop iteration prints an empty `__CF_WEBSSH_NETWORK__` block after top
// and (best-effort) populates it with every non-virtual interface's cumulative rx/tx bytes, capped
// at 32 rows so a host with many adapters cannot bloat the snapshot. The Linux branch reads
// /sys/class/net/<iface>/statistics/{rx,tx}_bytes and skips lo/docker/veth/bridge/tun/tailscale
// names so we never accidentally chart a container virtual NIC. The macOS fallback runs
// `netstat -ibn` and takes the first 32 <Link#N> rows that are not `lo*`. Any failure
// (no /sys/class/net, netstat missing, non-numeric counters) leaves the block empty and the
// frontend treats the tick as "no network sample".
// Linux CPU is sampled independently of top: its first frame is not an interval sample.
// Emit the marker even if /proc/stat is unavailable, so consumers never use top as a fallback.
export const PROCESS_MONITOR_COMMAND = "LC_ALL=C LANG=C sh -c 'os=$(uname -s 2>/dev/null || echo Linux); export COLUMNS=4096; while :; do printf \"\\137\\137CF_WEBSSH_TOP_SNAPSHOT\\137\\137\\n\"; case \"$os\" in Linux) printf \"\\137\\137CF_WEBSSH_LINUX_CPU\\137\\137\\n\"; CPU_LINE=; { IFS= read -r CPU_LINE < /proc/stat; } 2>/dev/null; printf \"%s\\n\" \"$CPU_LINE\";; esac; case \"$os\" in FreeBSD) top -b -a -d 1 2>/dev/null || exit 127;; Darwin) top -l 1 -c -n 0 -s 0 2>/dev/null || exit 127;; *) top -b -c -n 1 -w 0 2>/dev/null || top -b -c -n 1 2>/dev/null || top -b -n 1 2>/dev/null || exit 127;; esac; printf \"\\137\\137CF_WEBSSH_NETWORK\\137\\137\\n\"; NETN=0; if [ -d /sys/class/net ]; then for NDIR in /sys/class/net/*; do [ -d \"$NDIR\" ] || continue; NAME=${NDIR##*/}; case \"$NAME\" in lo|docker*|veth*|br-*|tun*|tailscale*) continue;; esac; RX=$(cat \"$NDIR/statistics/rx_bytes\" 2>/dev/null) || continue; TX=$(cat \"$NDIR/statistics/tx_bytes\" 2>/dev/null) || continue; case \"$RX$TX\" in *[!0-9]*) continue;; esac; NETN=$((NETN+1)); [ \"$NETN\" -ge 32 ] && break; printf \"%s\\t%s\\t%s\\n\" \"$NAME\" \"$RX\" \"$TX\"; done; elif command -v netstat >/dev/null 2>&1; then netstat -ibn 2>/dev/null | grep -v \"^lo\" | grep \"<Link#[0-9]>\" | head -n 32 | awk -v OFS=\"\\t\" \"{print \\$1, \\$7, \\$10}\"; fi; sleep 2; done'";
