/*
 * *****************************************************************************
 * Copyright (C) 2019-2026 Chrystian Huot <chrystian.huot@saubeo.solutions>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>
 * ****************************************************************************
 */

/**
 * Canvas-based ribbon waveform — modelled on vue-audio-visual's <AvWaveform>.
 * Renders one peak pair (top/bottom) per output pixel column, so resolution
 * scales with the canvas's actual pixel width. Handles HiDPI, click-to-seek,
 * and resize.
 *
 * Framework-agnostic on purpose: a component instantiates it with a canvas
 * element and a peaks array, then calls `set()` to update playback state.
 */

export interface WaveformRibbonOptions {
    /** Peaks array. Either:
     *  - number[] with values in [0, 1] — single peak per column (we
     *    mirror it for the bottom). Matches RdioScannerService.computePeaks.
     *  - [top, bottom][] pairs in [0, 1] — explicit ribbon shape.
     */
    peaks: number[] | [number, number][];

    /** Total clip duration in seconds. */
    duration: number;

    /** Current playback position in seconds. */
    currentTime: number;

    /** Color for the unplayed (right of cursor) portion. */
    bgColor?: string;

    /** Color for the played (left of cursor) portion. */
    fgColor?: string;

    /** Color of the vertical cursor line. */
    cursorColor?: string;

    /** Cursor line width in CSS pixels (will be DPR-scaled). */
    cursorWidth?: number;

    /** Whether to draw the cursor line at all. */
    showCursor?: boolean;

    /** Click-to-seek callback. Receives target time in seconds. */
    onSeek?: (timeSec: number) => void;
}

const DEFAULTS: Required<Omit<WaveformRibbonOptions, 'peaks' | 'duration' | 'currentTime' | 'onSeek'>> = {
    bgColor: 'rgba(0, 230, 118, 0.4)',
    fgColor: 'rgb(0, 230, 118)',
    cursorColor: 'rgb(220, 255, 235)',
    cursorWidth: 2,
    showCursor: true,
};

export class WaveformRibbon {
    private canvas: HTMLCanvasElement;
    private opts: Required<WaveformRibbonOptions>;
    private resampled: [number, number][] | null = null;
    private resampledWidth = 0;
    private resizeObserver: ResizeObserver | null = null;
    private onClickBound: (ev: MouseEvent) => void;

    constructor(canvas: HTMLCanvasElement, opts: WaveformRibbonOptions) {
        this.canvas = canvas;
        this.opts = { ...DEFAULTS, onSeek: () => undefined, ...opts };
        this.onClickBound = (ev) => this.onClick(ev);

        canvas.addEventListener('click', this.onClickBound);

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.draw());
            this.resizeObserver.observe(canvas);
        }

        this.draw();
    }

    /** Update one or more options and redraw. */
    set(next: Partial<WaveformRibbonOptions>): void {
        const prevPeaks = this.opts.peaks;
        Object.assign(this.opts, next);
        if (next.peaks !== undefined && next.peaks !== prevPeaks) {
            // peaks changed → drop the cached resample
            this.resampled = null;
        }
        this.draw();
    }

    destroy(): void {
        this.canvas.removeEventListener('click', this.onClickBound);
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    /** Force a redraw — useful after the host element becomes visible. */
    redraw(): void {
        this.draw();
    }

    private onClick(ev: MouseEvent): void {
        if (!this.opts.onSeek || this.opts.duration <= 0) {
            return;
        }
        const rect = this.canvas.getBoundingClientRect();
        const ratio = (ev.clientX - rect.left) / Math.max(1, rect.width);
        const clamped = Math.max(0, Math.min(1, ratio));
        this.opts.onSeek(clamped * this.opts.duration);
    }

    private draw(): void {
        const canvas = this.canvas;
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth || 1;
        const cssH = canvas.clientHeight || 1;
        const pxW = Math.max(1, Math.floor(cssW * dpr));
        const pxH = Math.max(1, Math.floor(cssH * dpr));

        if (canvas.width !== pxW || canvas.height !== pxH) {
            canvas.width = pxW;
            canvas.height = pxH;
        }

        if (!this.resampled || this.resampledWidth !== pxW) {
            this.resampled = this.resamplePeaksTo(pxW);
            this.resampledWidth = pxW;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, pxW, pxH);

        const mid = pxH / 2;
        const maxBar = pxH / 2 - 1;
        const duration = Math.max(0.001, this.opts.duration);
        const playX = Math.max(0, Math.min(pxW, Math.floor((this.opts.currentTime / duration) * pxW)));

        // Unplayed ribbon — full width in bg color
        ctx.strokeStyle = this.opts.bgColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < pxW; x++) {
            const [top, bot] = this.resampled[x];
            const topY = mid - top * maxBar;
            const botY = mid + bot * maxBar;
            ctx.moveTo(x + 0.5, topY);
            ctx.lineTo(x + 0.5, botY === topY ? botY + 1 : botY);
        }
        ctx.stroke();

        // Played ribbon — left of cursor in fg color
        if (playX > 0) {
            ctx.strokeStyle = this.opts.fgColor;
            ctx.beginPath();
            for (let x = 0; x < playX; x++) {
                const [top, bot] = this.resampled[x];
                const topY = mid - top * maxBar;
                const botY = mid + bot * maxBar;
                ctx.moveTo(x + 0.5, topY);
                ctx.lineTo(x + 0.5, botY === topY ? botY + 1 : botY);
            }
            ctx.stroke();
        }

        // Cursor line
        if (this.opts.showCursor && this.opts.duration > 0) {
            ctx.strokeStyle = this.opts.cursorColor;
            ctx.lineWidth = this.opts.cursorWidth * dpr;
            ctx.beginPath();
            ctx.moveTo(playX + 0.5, 0);
            ctx.lineTo(playX + 0.5, pxH);
            ctx.stroke();
        }
    }

    /**
     * Resample the source peaks down to exactly `n` columns. Source peaks
     * may be:
     *   - number[]  — single peak per column (we mirror for the bottom)
     *   - [t, b][]  — explicit ribbon pairs
     *
     * Decimation takes the maximum over each input bucket so we don't
     * smooth away transients.
     */
    private resamplePeaksTo(n: number): [number, number][] {
        const src = this.opts.peaks;
        const len = src.length;
        if (len === 0) {
            // No peaks yet — return a flat zero ribbon
            const out = new Array<[number, number]>(n);
            for (let i = 0; i < n; i++) out[i] = [0, 0];
            return out;
        }

        const isPaired = Array.isArray(src[0]);
        const out = new Array<[number, number]>(n);
        const step = len / n;

        for (let i = 0; i < n; i++) {
            const from = Math.floor(i * step);
            const to = Math.max(from + 1, Math.floor((i + 1) * step));
            let top = 0;
            let bot = 0;
            for (let j = from; j < to && j < len; j++) {
                if (isPaired) {
                    const pair = src[j] as [number, number];
                    if (pair[0] > top) top = pair[0];
                    if (pair[1] > bot) bot = pair[1];
                } else {
                    const v = src[j] as number;
                    if (v > top) top = v;
                    if (v > bot) bot = v;
                }
            }
            out[i] = [top, bot];
        }
        return out;
    }
}
