import { isLand } from 'mappo';
import type { CloudHost } from './cloud-api';
import { fitZoom, type RegionView } from './continents';
import { countryFlagEmoji } from './flags';

type Point = [number, number, number];
export type GlobeView = 'sphere' | 'flat';
/** Land and graticule samples stay geographic so both projections can read them. */
type Sample = { lat: number; lon: number; unit: Point };
const AUTO_ROTATION_SPEED = 0.000099;
const MORPH_MS = 720;
const FLAT_CORNER = 10;
/** Sphere diameter as a share of the square canvas — unchanged, it is the baseline every other size morphs against. */
const SPHERE_RATIO = 0.405;
/** Unrolled, the paper takes the column's full width — half a percent left over for its stroke. */
const FLAT_WIDTH_RATIO = 0.995;
/**
 * Map-only lattice, one step in both directions. On a 2:1 projection equal
 * steps in latitude and longitude land exactly square, so the dots come out
 * evenly spaced instead of thinning towards the poles the way the globe's
 * equal-area rows do.
 */
const FLAT_STEP = 2.5;
/**
 * Unrolling stretches high latitudes sideways, which thins the dot rows exactly
 * where the shared sampling is already coarsest. Softening the vertical term of
 * the radial falloff pays those rows back their brightness — and with it their
 * size, since both derive from the same depth value.
 */
const FLAT_DEPTH_V = 0.7;

function sphere(lat: number, lon: number): Point {
  const a = lat * Math.PI / 180, b = lon * Math.PI / 180;
  return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)];
}

function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function wrap(lon: number): number { return ((lon + 540) % 360) - 180; }

export class HostGlobe {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly samples: Sample[] = [];
  /** Separate even lattice for the unrolled map; see FLAT_STEP. */
  private readonly flatSamples: Sample[] = [];
  private readonly graticule: Sample[][] = [];
  private markers: { sample: Sample; button: HTMLButtonElement }[] = [];
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)');
  private angle = -1.5;
  private frame = 0;
  private last = 0;
  private active = false;
  private paused = false;
  private dragging = false;
  private pointerX = 0;
  private width = 0;
  private height = 0;
  private view: GlobeView = 'sphere';
  /** 0 = sphere, 1 = fully unrolled; the one knob every draw path reads. */
  private progress = 0;
  private morphFrom = 0;
  private morphAt = 0;
  /** Latest frame *after* the release: 0 shows the world, 1 frames one region. */
  private focusT = 0;
  private focusFrom = 0;
  private focusAt = 0;
  private focused = false;
  /** Eased centre + magnification of the unrolled map; defaults frame the world. */
  private mapLon = 0;
  private mapLat = 0;
  private mapZoom = 1;
  private focusEase = { lon: 0, lat: 0, zoom: 1, angle: 0 };
  private focusStart = { lon: 0, lat: 0, zoom: 1, angle: 0 };
  private readonly resize: ResizeObserver;
  private readonly orange: string;
  private readonly grid: string;
  private readonly paper: string;

  constructor(private readonly root: HTMLElement, private readonly connect: (host: CloudHost) => void) {
    this.context = this.canvas.getContext('2d')!;
    this.canvas.setAttribute('aria-hidden', 'true');
    root.append(this.canvas);
    const style = getComputedStyle(root);
    this.orange = style.getPropertyValue('--home-accent').trim();
    this.grid = style.getPropertyValue('--home-line').trim();
    this.paper = style.getPropertyValue('--home-surface').trim();
    // 复用 Mappo 的真实陆地掩码；一次预计算坐标，旋转时不再遍历地理数据。
    for (let lat = -82; lat <= 84; lat += 1.8) {
      const step = 1.8 / Math.max(0.2, Math.cos(lat * Math.PI / 180));
      for (let lon = -180; lon < 180; lon += step) {
        if (isLand(lat, lon)) this.samples.push({ lat, lon, unit: sphere(lat, lon) });
      }
    }
    for (let lat = -82; lat <= 84; lat += FLAT_STEP) {
      for (let lon = -180; lon < 180; lon += FLAT_STEP) {
        if (isLand(lat, lon)) this.flatSamples.push({ lat, lon, unit: sphere(lat, lon) });
      }
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      this.graticule.push(Array.from({ length: 121 }, (_, i): Sample => {
        const lon = i * 3 - 180;
        return { lat, lon, unit: sphere(lat, lon) };
      }));
    }
    for (let lon = -180; lon < 180; lon += 30) {
      this.graticule.push(Array.from({ length: 61 }, (_, i): Sample => {
        const lat = i * 3 - 90;
        return { lat, lon, unit: sphere(lat, lon) };
      }));
    }
    this.resize = new ResizeObserver(() => {
      // A transient relayout can report zero width; resizing to 0 would wipe
      // the bitmap and never repaint it.
      const width = root.clientWidth, height = root.clientHeight;
      if (!width || !height) return;
      this.width = width;
      this.height = height;
      const scale = Math.min(devicePixelRatio, 2);
      this.canvas.width = Math.round(width * scale);
      this.canvas.height = Math.round(height * scale);
      this.context.setTransform(scale, 0, 0, scale, 0, 0);
      this.draw();
    });
    this.resize.observe(root);
    this.canvas.addEventListener('pointerdown', (event) => {
      if (this.view === 'flat') return;
      this.dragging = true; this.pointerX = event.clientX;
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      this.angle += (event.clientX - this.pointerX) * 0.008;
      this.pointerX = event.clientX; this.draw();
    });
    const release = () => { this.dragging = false; };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
    root.addEventListener('pointerenter', () => { this.paused = true; });
    root.addEventListener('pointerleave', () => { this.paused = false; });
    root.addEventListener('focusin', () => { this.paused = true; });
    root.addEventListener('focusout', () => { this.paused = false; });
    document.addEventListener('visibilitychange', () => this.schedule());
    this.motion.addEventListener('change', () => this.schedule());
  }

  setHosts(hosts: CloudHost[]): void {
    for (const marker of this.markers) marker.button.remove();
    this.markers = hosts.filter((host) => host.location).map((host) => {
      const location = host.location!;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'globe-marker';
      button.setAttribute('aria-label', `连接 ${host.name}，${location.city || location.country}`);
      const pin = document.createElement('span'); pin.className = 'globe-pin';
      const copy = document.createElement('span'); copy.className = 'globe-label';
      const name = document.createElement('strong'); name.textContent = `${countryFlagEmoji(location.countryCode)} ${host.name}`;
      const city = document.createElement('small'); city.textContent = location.city || location.country;
      copy.append(name, city); button.append(pin, copy);
      button.addEventListener('click', () => this.connect(host));
      this.root.append(button);
      const lat = location.latitude, lon = location.longitude;
      return { sample: { lat, lon, unit: sphere(lat, lon) }, button };
    });
    this.draw();
  }

  setActive(active: boolean): void { this.active = active; this.schedule(); }
  setPaused(paused: boolean): void { this.active = !paused; this.schedule(); }

  /**
   * Switch between the spinning globe and the unrolled map. The unrolled view
   * shows every meridian at once, so it neither spins nor drags — it simply
   * settles and stops repainting.
   */
  setView(view: GlobeView, animate = true): void {
    if (this.view === view) return;
    this.view = view;
    if (!animate) this.progress = view === 'flat' ? 1 : 0;
    this.morphFrom = this.progress;
    this.morphAt = performance.now();
    this.canvas.style.cursor = view === 'flat' ? 'default' : '';
    this.root.dataset.view = view;
    this.schedule();
  }

  get currentView(): GlobeView { return this.view; }

  /**
   * Frame one region — the sphere turns to face it and holds still, the map
   * crops down to its bounds — or `null` to release it back to the whole,
   * spinning world. Kept as one call so switching shapes while a region is
   * selected keeps presenting whatever is already chosen.
   */
  focusRegion(view: RegionView | null, animate = true): void {
    const now = { lon: this.mapLon, lat: this.mapLat, zoom: this.mapZoom, angle: this.angle };
    const goal = view ? this.plan(view) : { lon: 0, lat: 0, zoom: 1, angle: this.angle };
    // t=0 always means `from` and t=1 always means `to`: framing a region runs
    // the timeline forwards, releasing it rewinds those same two frames — so
    // letting go lands on the whole world rather than on the crop it came from.
    const from = view ? now : goal;
    const to = view ? goal : now;
    // Pick the coterminal turn nearest the starting angle; without this the
    // globe would unwind several full revolutions to reach, say, Arizona.
    const turn = Math.PI * 2;
    to.angle += Math.round((from.angle - to.angle) / turn) * turn;
    this.focused = view !== null;
    this.focusStart = from;
    this.focusEase = to;
    this.focusFrom = this.focusT;
    this.focusAt = performance.now();
    if (!animate) { this.focusT = view ? 1 : 0; this.applyFocus(); return; }
    this.schedule();
  }

  /** Where a region sits on the map: its centre, plus how far to magnify it. */
  private plan(view: RegionView): { lon: number; lat: number; zoom: number; angle: number } {
    const [west, east, south, north] = view.bounds;
    const lon = wrap((west + east) / 2), lat = (south + north) / 2;
    return { lon, lat, zoom: fitZoom(view.bounds), angle: -view.centerLon * Math.PI / 180 };
  }

  private applyFocus(): void {
    const { lon, lat, zoom, angle } = this.focusEase;
    const t = this.focusT;
    this.mapLon = this.focusStart.lon + (lon - this.focusStart.lon) * t;
    this.mapLat = this.focusStart.lat + (lat - this.focusStart.lat) * t;
    this.mapZoom = this.focusStart.zoom + (zoom - this.focusStart.zoom) * t;
    this.angle = this.focusStart.angle + (angle - this.focusStart.angle) * t;
  }

  /** True while the turn/crop away from the whole world is still settling. */
  private focusMoving(): boolean { return this.focusT !== (this.focused ? 1 : 0); }

  private schedule(): void {
    cancelAnimationFrame(this.frame);
    this.last = 0;
    if (this.motion.matches) {
      this.progress = this.view === 'flat' ? 1 : 0;
      this.focusT = this.focused ? 1 : 0;
      this.applyFocus();
      this.draw();
      return;
    }
    if (!this.active || document.hidden) { this.draw(); return; }
    // Unrolled + settled: nothing will move again, so don't hold a frame loop.
    if (this.view === 'flat' && this.progress === 1 && !this.focusMoving()) { this.draw(); return; }
    this.frame = requestAnimationFrame(this.tick);
  }

  /** The turn towards (or the return from) a region, on its own eased timeline. */
  private advanceFocus(time: number): void {
    const target = this.focused ? 1 : 0;
    if (this.focusT === target) return;
    const ratio = Math.min(1, (time - this.focusAt) / MORPH_MS);
    const eased = ratio < 0.5 ? 2 * ratio * ratio : 1 - 2 * (1 - ratio) ** 2;
    this.focusT = ratio >= 1 ? target : mix(this.focusFrom, target, eased);
    this.applyFocus();
  }

  private advance(time: number): void {
    const target = this.view === 'flat' ? 1 : 0;
    if (this.progress === target) return;
    const ratio = Math.min(1, (time - this.morphAt) / MORPH_MS);
    const eased = ratio < 0.5 ? 2 * ratio * ratio : 1 - 2 * (1 - ratio) ** 2;
    this.progress = ratio >= 1 ? target : mix(this.morphFrom, target, eased);
  }

  private readonly tick = (time: number): void => {
    if (this.last && time - this.last < 32) { this.frame = requestAnimationFrame(this.tick); return; }
    const delta = this.last ? Math.min(time - this.last, 100) : 0;
    this.last = time;
    this.advance(time);
    this.advanceFocus(time);
    const settled = this.progress === (this.view === 'flat' ? 1 : 0);
    // Only the sphere spins — the map is the whole world laid out at once, and
    // a region being framed is held still until it is released.
    if (this.progress < 1 && !this.paused && !this.dragging && !this.focused && !this.focusMoving()) {
      this.angle += delta * AUTO_ROTATION_SPEED;
    }
    this.draw();
    // Holding a region still needs no frames once the turn/crop has arrived;
    // before that — and always when nothing is framed — the loop keeps running.
    if (settled && this.focused && !this.focusMoving()) { this.last = 0; return; }
    // A settled map holds nothing else that moves — unless it is mid-way through
    // zooming into, or back out of, a region.
    if (this.view === 'flat' && this.progress === 1 && !this.focusMoving()) { this.last = 0; return; }
    this.frame = requestAnimationFrame(this.tick);
  };

  /**
   * Screen position of a sample for the current morph progress: the sphere's
   * spinning projection eased into the flat one. The third value replaces the
   * sphere's depth with a radial falloff, so both shapes shade the same way —
   * brightest dead centre, fading to nothing at the rim.
   */
  private place(sample: Sample): Point {
    const { lat, lon, unit } = sample;
    const [x, y, z] = unit, s = Math.sin(this.angle), c = Math.cos(this.angle);
    const rx = x * c + z * s, rz = z * c - x * s;
    const tilt = 0.18;
    const sy = y * Math.cos(tilt) - rz * Math.sin(tilt);
    const sz = y * Math.sin(tilt) + rz * Math.cos(tilt);
    // The map is centred on the prime meridian; easing the offset out keeps
    // the unroll continuous even if the globe was mid-spin.
    // Zoomed in, an unrolled map *is* a window onto the degrees: the same
    // 1/180 scale keeps x and y in proportion, so magnifying never distorts.
    const u = wrap(lon + this.angle * (180 / Math.PI) * (1 - this.progress) - this.mapLon) / 180 * this.mapZoom;
    const v = (lat - this.mapLat) / 90 * this.mapZoom;
    const radial = 1 - Math.min(1, Math.hypot(u, v * FLAT_DEPTH_V));
    // Latitude runs north-up, matching the sphere where +y draws upward.
    return [mix(rx, u, this.progress), mix(sy, v * 0.5, this.progress), mix(sz, radial, this.progress)];
  }

  private draw(): void {
    if (!this.width || !this.height) return;
    const ctx = this.context;
    // The globe lives in the shorter side, so widening the box never changes it;
    // unrolled, the paper takes the whole width instead — that is what buying the
    // map a wider column buys. Both extents collapse to the sphere radius at t=0,
    // so the morph stays continuous, and keeping exactly 2:1 is what lets the
    // map's even lattice read as even once drawn.
    const base = Math.min(this.width, this.height);
    const radius = base * SPHERE_RATIO;
    const cx = this.width / 2, cy = this.height / 2;
    const halfWidth = mix(radius, this.width * FLAT_WIDTH_RATIO / 2, this.progress);
    // x spans ±1 and y spans ±0.5, so one scale covers both — it *is* half the
    // paper's width. Keeping the paper's own height in step with it at every t
    // (rather than easing two numbers independently) is what stops the dots from
    // spilling past the edges mid-unroll.
    const halfHeight = mix(1, 0.5, this.progress) * halfWidth;
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawFrame(ctx, cx, cy, halfWidth, halfHeight);
    // Zoomed into one region the map runs past its own paper, so everything has
    // to be clipped to it — otherwise the rest of the world's dots would spill
    // out across the dashboard. At world scale nothing can leave the paper and
    // no clip is ever set, leaving the unrolled look exactly as it was.
    const clipped = this.mapZoom > 1.001 && this.progress > 0.01;
    if (clipped) { ctx.save(); this.framePath(ctx, cx, cy, halfWidth, halfHeight); ctx.clip(); }
    const drawLine = (points: Sample[]) => {
      ctx.beginPath(); let started = false;
      for (const point of points) {
        const [x, y, z] = this.place(point);
        // z < 0 hides the far hemisphere on the globe; the map's radial depth
        // bottoms out at exactly 0, so nothing gets clipped once unrolled.
        if (z < 0) { started = false; continue; }
        if (started) ctx.lineTo(cx + x * halfWidth, cy - y * halfWidth);
        else ctx.moveTo(cx + x * halfWidth, cy - y * halfWidth);
        started = true;
      }
      ctx.stroke();
    };
    ctx.globalAlpha = 0.7;
    for (const line of this.graticule) drawLine(line);
    ctx.fillStyle = this.orange;
    // The two lattices cross-fade across the unroll. The globe's rows thin
    // towards the poles (equal area on a sphere) and streak once flattened; the
    // map's rows are even but would clump at the poles on the sphere; and no
    // amount of scaling turns one into the other point for point.
    const drawDots = (samples: readonly Sample[], weight: number): void => {
      if (weight <= 0.01) return;
      for (const point of samples) {
        const [x, y, z] = this.place(point);
        if (z < 0) continue;
        ctx.globalAlpha = (0.25 + z * 0.7) * weight;
        ctx.beginPath(); ctx.arc(cx + x * halfWidth, cy - y * halfWidth, (0.55 + z * 0.65) * base / 460, 0, Math.PI * 2); ctx.fill();
      }
    };
    drawDots(this.samples, 1 - this.progress);
    drawDots(this.flatSamples, this.progress);
    ctx.globalAlpha = 1;
    if (clipped) ctx.restore();
    const occupied: { x: number; y: number }[] = [];
    for (const marker of this.markers) {
      const [x, y, z] = this.place(marker.sample);
      const px = cx + x * halfWidth, py = cy - y * halfWidth;
      // Same idea as the clip above: the map stops hiding markers as it opens.
      // The second test drops whatever the zoom has pushed off the paper.
      const outside = Math.abs(x) > mix(1.05, 1.02, this.progress) || Math.abs(y) > mix(1.05, 0.52, this.progress);
      marker.button.hidden = z < 0.12 * (1 - this.progress) || outside;
      if (marker.button.hidden) continue;
      // 密集地区折叠文字而不是堆叠卡片；每台机器始终还可从左侧列表连接。
      const overlap = occupied.some((other) => Math.abs(other.x - px) < 100 && Math.abs(other.y - py) < 44);
      marker.button.classList.toggle('compact', overlap);
      if (!overlap) occupied.push({ x: px, y: py });
      marker.button.style.transform = `translate(${px}px, ${py}px)`;
      marker.button.style.zIndex = String(Math.round(z * 10));
    }
  }

  /** A circle that unrolls into a 2:1 rounded rect — at t=0 the rect *is* the circle. */
  private drawFrame(ctx: CanvasRenderingContext2D, cx: number, cy: number, halfWidth: number, halfHeight: number): void {
    this.framePath(ctx, cx, cy, halfWidth, halfHeight);
    ctx.fillStyle = this.paper; ctx.fill(); ctx.strokeStyle = this.grid; ctx.lineWidth = 0.8; ctx.stroke();
  }

  private framePath(ctx: CanvasRenderingContext2D, cx: number, cy: number, halfWidth: number, halfHeight: number): void {
    const corner = mix(Math.min(this.width, this.height) * SPHERE_RATIO, FLAT_CORNER, this.progress);
    ctx.beginPath();
    ctx.roundRect(cx - halfWidth, cy - halfHeight, halfWidth * 2, halfHeight * 2, Math.min(corner, halfHeight));
  }
}
