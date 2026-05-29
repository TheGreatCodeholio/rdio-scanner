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

import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    OnDestroy,
    ViewChild,
} from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';
import {
    RdioScannerCall,
    RdioScannerConfig,
    RdioScannerEvent,
    RdioScannerLivefeedMode,
    RdioScannerPlaybackList,
    RdioScannerSearchOptions,
    RdioScannerSystem,
    RdioScannerTalkgroup,
} from '../rdio-scanner';
import { RdioScannerService } from '../rdio-scanner.service';
import { WaveformRibbon } from './waveform-ribbon';

type PresetKey = 'hour' | 'today' | 'day' | 'week' | null;

@Component({
    selector: 'rdio-scanner-search',
    styleUrls: [
        './search.component.scss',
        './search-cards-dock.scss',
    ],
    templateUrl: './search.component.html',
    standalone: false,
})
export class RdioScannerSearchComponent implements AfterViewInit, OnDestroy {
    call: RdioScannerCall | undefined;
    callPending: number | undefined;

    form: FormGroup;

    livefeedOnline = false;
    livefeedPlayback = false;

    playbackList: RdioScannerPlaybackList | undefined;

    optionsGroup: string[] = [];
    optionsSystem: string[] = [];
    optionsTag: string[] = [];
    optionsTalkgroup: string[] = [];

    paused = false;

    results = new BehaviorSubject<Array<RdioScannerCall | null>>(new Array<RdioScannerCall | null>(20));
    resultsPending = false;

    time12h = false;

    // --- Dock player state ---
    dockTime = 0;
    dockDuration = 0;
    dockPeaks: number[] = [];

    // --- UI state ---
    sidebarOpen = false;
    activePreset: PresetKey = null;

    private config: RdioScannerConfig | undefined;

    private eventSubscription;

    private limit = 200;
    private offset = 0;
    private pageSize = 20;
    private pageIndex = 0;

    @ViewChild('dockCanvas', { static: false }) private dockCanvasRef: ElementRef<HTMLCanvasElement> | undefined;
    @ViewChild('scrollableResults', { static: false }) private scrollableResultsRef: ElementRef<HTMLDivElement> | undefined;

    private ribbon: WaveformRibbon | undefined;
    private resultsResizeObserver: ResizeObserver | undefined;

    // Padding inside .results-scroll (must stay in sync with SCSS).
    private static readonly RESULTS_SCROLL_PADDING = 24;

    // Fallback card-slot height when no card is rendered yet (px).
    private static readonly DEFAULT_CARD_SLOT_HEIGHT = 70;

    constructor(
        private rdioScannerService: RdioScannerService,
        private ngChangeDetectorRef: ChangeDetectorRef,
        private ngFormBuilder: FormBuilder,
    ) {
        this.form = this.ngFormBuilder.group<{
            date: string | null;
            group: number;
            query: string;
            sort: number;
            system: number;
            tag: number;
            talkgroup: number;
            unit: number | null;
        }>({
            date: null,
            group: -1,
            query: '',
            sort: -1,
            system: -1,
            tag: -1,
            talkgroup: -1,
            unit: null,
        });

        this.eventSubscription = this.rdioScannerService.event
            .subscribe((event: RdioScannerEvent) => this.eventHandler(event));
    }

    ngAfterViewInit(): void {
        this.mountRibbon();
        this.observeResultsResize();
    }

    ngOnDestroy(): void {
        this.eventSubscription.unsubscribe();
        this.ribbon?.destroy();
        this.ribbon = undefined;
        this.resultsResizeObserver?.disconnect();
        this.resultsResizeObserver = undefined;
    }

    /** True iff audio is actively playing (drives the LCD time chip's
     *  lit/dull state, same convention as the main view drawer). */
    get isPlaying(): boolean {
        return !!this.call && !this.paused;
    }

    // --- Pagination ---

    canPrevPage(): boolean {
        return this.pageIndex > 0;
    }

    canNextPage(): boolean {
        const totalPages = Math.ceil((this.playbackList?.count || 0) / this.pageSize);
        return this.pageIndex + 1 < totalPages;
    }

    nextPage(): void {
        if (!this.canNextPage()) return;
        this.pageIndex++;
        this.refreshResults();
    }

    prevPage(): void {
        if (!this.canPrevPage()) return;
        this.pageIndex--;
        this.refreshResults();
    }

    firstPage(): void {
        if (this.pageIndex === 0) return;
        this.pageIndex = 0;
        this.refreshResults();
    }

    lastPage(): void {
        const total = this.playbackList?.count || 0;
        const last = Math.max(0, Math.ceil(total / this.pageSize) - 1);
        if (this.pageIndex === last) return;
        this.pageIndex = last;
        this.refreshResults();
    }

    pageIndicator(): string {
        const total = this.playbackList?.count || 0;
        if (!total) return '— of —';
        const totalPages = Math.max(1, Math.ceil(total / this.pageSize));
        const from = this.pageIndex * this.pageSize + 1;
        const to = Math.min(total, from + this.pageSize - 1);
        return `${from}–${to} of ${total} · pg ${this.pageIndex + 1}/${totalPages}`;
    }

    // --- Filter handlers ---

    applyPreset(key: Exclude<PresetKey, null>): void {
        const now = new Date();
        let from: Date;
        if (key === 'hour') from = new Date(now.getTime() - 60 * 60 * 1000);
        else if (key === 'today') { from = new Date(now); from.setHours(0, 0, 0, 0); }
        else if (key === 'day') from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        else from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        this.activePreset = key;
        // Format as datetime-local string. Server widens any picked time to
        // a 24h window today; once Phase 2 lands a real range, both ends
        // of the preset will be honored.
        const iso = new Date(from.getTime() - from.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        this.form.patchValue({ date: iso });
        this.formChangeHandler();
    }

    formChangeHandler(): void {
        if (this.livefeedPlayback) {
            this.rdioScannerService.stopPlaybackMode();
        }

        this.pageIndex = 0;
        this.refreshFilters();
        this.searchCalls();
    }

    refreshFilters(): void {
        if (!this.config) {
            return;
        }

        const selectedGroup = this.getSelectedGroup();
        const selectedSystem = this.getSelectedSystem();
        const selectedTag = this.getSelectedTag();
        const selectedTalkgroup = this.getSelectedTalkgroup();

        this.optionsSystem = this.config.systems
            .filter((system) => {
                const group = selectedGroup === undefined ||
                    system.talkgroups.some((talkgroup) => talkgroup.groups.includes(selectedGroup));
                const tag = selectedTag === undefined ||
                    system.talkgroups.some((talkgroup) => talkgroup.tag === selectedTag);
                return group && tag;
            })
            .map((system) => system.label);

        this.optionsTalkgroup = selectedSystem == undefined
            ? []
            : selectedSystem.talkgroups
                .filter((talkgroup) => {
                    const group = selectedGroup == undefined ||
                        talkgroup.groups.includes(selectedGroup);
                    const tag = selectedTag == undefined ||
                        talkgroup.tag === selectedTag;
                    return group && tag;
                })
                .map((talkgroup) => talkgroup.label);

        this.optionsGroup = Object.keys(this.config.groups)
            .filter((group) => {
                const system: boolean = selectedSystem === undefined ||
                    selectedSystem.talkgroups.some((talkgroup) => talkgroup.groups.includes(group));
                const talkgroup: boolean = selectedTalkgroup === undefined ||
                    selectedTalkgroup.groups.includes(group);
                const tag: boolean = selectedTag === undefined ||
                    (selectedTalkgroup !== undefined && selectedTalkgroup.tag === selectedTag) ||
                    (this.config !== undefined && this.config.systems
                        .flatMap((system) => system.talkgroups)
                        .some((talkgroup) => talkgroup.groups.includes(group) && talkgroup.tag === selectedTag));
                return system && talkgroup && tag;
            })
            .sort((a, b) => a.localeCompare(b));

        this.optionsTag = Object.keys(this.config.tags)
            .filter((tag) => {
                const system: boolean = selectedSystem === undefined ||
                    selectedSystem.talkgroups.some((talkgroup) => talkgroup.tag === tag);
                const talkgroup: boolean = selectedTalkgroup === undefined ||
                    selectedTalkgroup.tag === tag;
                const group: boolean = selectedGroup === undefined ||
                    (selectedTalkgroup !== undefined && selectedTalkgroup.groups.includes(selectedGroup)) ||
                    (this.config !== undefined && this.config.systems
                        .flatMap((system) => system.talkgroups)
                        .some((talkgroup) => talkgroup.tag === tag && talkgroup.groups.includes(selectedGroup)));
                return system && talkgroup && group;
            })
            .sort((a, b) => a.localeCompare(b));

        this.form.patchValue({
            group: selectedGroup ? this.optionsGroup.findIndex((group) => group === selectedGroup) : -1,
            system: selectedSystem ? this.optionsSystem.findIndex((system) => system === selectedSystem.label) : -1,
            tag: selectedTag ? this.optionsTag.findIndex((tag) => tag === selectedTag) : -1,
            talkgroup: selectedTalkgroup ? this.optionsTalkgroup.findIndex((talkgroup) => talkgroup === selectedTalkgroup.label) : -1,
        });
    }

    refreshResults(): void {
        const from = this.pageIndex * this.pageSize;
        const to = from + this.pageSize - 1;

        if (!this.callPending && (from >= this.offset + this.limit || from < this.offset)) {
            this.searchCalls();
        } else if (this.playbackList) {
            const calls: Array<RdioScannerCall | null> = this.playbackList.results
                .slice(from % this.limit, (to % this.limit) + 1);
            while (calls.length < this.pageSize) {
                calls.push(null);
            }
            this.results.next(calls);
        }
    }

    resetForm(): void {
        this.form.reset({
            date: null,
            group: -1,
            query: '',
            sort: -1,
            system: -1,
            tag: -1,
            talkgroup: -1,
            unit: null,
        });
        this.activePreset = null;
        this.pageIndex = 0;
        this.formChangeHandler();
    }

    searchCalls(): void {
        if (this.livefeedPlayback) {
            return;
        }

        this.offset = Math.floor((this.pageIndex * this.pageSize) / this.limit) * this.limit;

        const options: RdioScannerSearchOptions = {
            limit: this.limit,
            offset: this.offset,
            sort: this.form.get('sort')?.value ?? -1,
        };

        if (typeof this.form.value.date === 'string' && this.form.value.date) {
            options.date = new Date(Date.parse(this.form.value.date));
        }

        if ((this.form.get('group')?.value ?? -1) >= 0) {
            const group = this.getSelectedGroup();
            if (group) options.group = group;
        }

        if ((this.form.get('system')?.value ?? -1) >= 0) {
            const system = this.getSelectedSystem();
            if (system) options.system = system.id;
        }

        if ((this.form.get('tag')?.value ?? -1) >= 0) {
            const tag = this.getSelectedTag();
            if (tag) options.tag = tag;
        }

        if ((this.form.get('talkgroup')?.value ?? -1) >= 0) {
            const talkgroup = this.getSelectedTalkgroup();
            if (talkgroup) options.talkgroup = talkgroup.id;
        }

        // Unit + query are populated client-side for now; server-side
        // support lands in Phase 2 (CallsSearchOptions doesn't yet expose
        // a Unit field, and there's no free-text search at all).
        const unitVal = this.form.get('unit')?.value;
        if (typeof unitVal === 'number' && unitVal > 0) {
            options.unit = unitVal;
        }

        this.resultsPending = true;
        this.form.disable({ emitEvent: false });

        this.rdioScannerService.searchCalls(options);
    }

    // --- Row actions ---

    play(id: number): void {
        this.rdioScannerService.loadAndPlay(id);
    }

    download(id: number): void {
        this.rdioScannerService.loadAndDownload(id);
    }

    rowAction(row: RdioScannerCall): void {
        if (row.id === this.call?.id) {
            this.togglePlayback();
        } else {
            this.play(+row.id);
        }
    }

    rowActionLabel(row: RdioScannerCall): string {
        if (row.id === this.callPending) return 'Loading';
        if (row.id === this.call?.id) return this.paused ? 'Resume' : 'Pause';
        return 'Play';
    }

    stop(): void {
        if (this.livefeedPlayback) {
            this.rdioScannerService.stopPlaybackMode();
        } else {
            this.rdioScannerService.stop();
        }
    }

    // --- Dock actions ---

    togglePlayback(): void {
        // Same shape as the main view's pause(): no args = service decides
        // play/pause based on actual playback state.
        this.rdioScannerService.pause();
    }

    toggleAutoplay(): void {
        // Autoplay is implemented as the livefeed Playback mode — entering
        // it makes the queue auto-advance through search results. Toggling
        // off drops back to Offline mode.
        if (this.livefeedPlayback) {
            this.rdioScannerService.stopPlaybackMode();
        } else if (this.call) {
            // Re-trigger the current call so playbackMode latches on.
            this.rdioScannerService.loadAndPlay(this.call.id);
        }
    }

    downloadCurrent(): void {
        if (this.call) this.download(+this.call.id);
    }

    // --- Time formatting (matches the main view drawer's m:ss.mmm / h:mm:ss.mmm) ---

    formatTime(seconds: number | undefined): string {
        if (!seconds || isNaN(seconds) || seconds < 0) return '0:00.000';
        const totalMs = Math.round(seconds * 1000);
        const ms = totalMs % 1000;
        const totalSec = Math.floor(totalMs / 1000);
        const s = totalSec % 60;
        const totalMin = Math.floor(totalSec / 60);
        const m = totalMin % 60;
        const h = Math.floor(totalMin / 60);
        const pad = (n: number, w: number) => n.toString().padStart(w, '0');
        if (h > 0) return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
        return `${m}:${pad(s, 2)}.${pad(ms, 3)}`;
    }

    // --- Event handling ---

    private eventHandler(event: RdioScannerEvent): void {
        if ('call' in event) {
            this.call = event.call;

            if (this.callPending) {
                const index = this.results.value.findIndex((call) => call?.id === this.callPending);
                if (index === -1) {
                    if (this.form.get('sort')?.value === -1) this.prevPage();
                    else this.nextPage();
                }
                this.callPending = undefined;
            }

            if (!event.call) {
                // Call cleared. Leave the dock duration/peaks in place so
                // the bar can still be scrubbed; the time chip will idle.
            }
        }

        if ('duration' in event && typeof event.duration === 'number') {
            this.dockDuration = event.duration;
            this.dockTime = 0;
            this.updateRibbon();
        }

        if ('peaks' in event && Array.isArray(event.peaks)) {
            this.dockPeaks = event.peaks;
            this.updateRibbon();
        }

        if ('time' in event && typeof event.time === 'number') {
            this.dockTime = event.time;
            this.updateRibbon();
        }

        if ('config' in event) {
            this.config = event.config;
            this.callPending = undefined;
            this.optionsGroup = Object.keys(this.config?.groups || []).sort((a, b) => a.localeCompare(b));
            this.optionsSystem = (this.config?.systems || []).map((system) => system.label);
            this.optionsTag = Object.keys(this.config?.tags || []).sort((a, b) => a.localeCompare(b));
            this.time12h = this.config?.time12hFormat || false;
        }

        if ('livefeedMode' in event) {
            this.livefeedOnline = event.livefeedMode === RdioScannerLivefeedMode.Online;
            this.livefeedPlayback = event.livefeedMode === RdioScannerLivefeedMode.Playback;
        }

        if ('playbackList' in event) {
            this.playbackList = event.playbackList;
            this.refreshResults();
            this.resultsPending = false;
            this.form.enable({ emitEvent: false });

            // Cards render this change-detection tick; re-measure on the
            // next microtask so autoFitPageSize sees the real card height
            // instead of the fallback constant. Cheap if nothing changes.
            setTimeout(() => this.autoFitPageSize(), 0);
        }

        if ('playbackPending' in event) {
            this.callPending = event.playbackPending;
        }

        if ('pause' in event) {
            this.paused = event.pause || false;
        }

        this.ngChangeDetectorRef.detectChanges();
    }

    // --- Ribbon lifecycle ---

    /**
     * Watch the results-scroll element and tune `pageSize` so each page
     * fills exactly the visible area — no internal scrolling within the
     * card list. Card height is measured at runtime so changes to the
     * card SCSS don't drift this calculation. The first-visible row is
     * preserved across resizes so the user doesn't lose their place.
     */
    private observeResultsResize(): void {
        const el = this.scrollableResultsRef?.nativeElement;
        if (!el || typeof ResizeObserver === 'undefined') {
            return;
        }
        this.resultsResizeObserver = new ResizeObserver(() => this.autoFitPageSize());
        this.resultsResizeObserver.observe(el);
    }

    private autoFitPageSize(): void {
        const scroll = this.scrollableResultsRef?.nativeElement;
        if (!scroll) return;

        const containerHeight = scroll.clientHeight;
        // First paint inside a freshly-opened sidenav can fire with
        // height 0 — skip until we actually have a viewport to measure.
        if (containerHeight <= 0) return;

        const firstCard = scroll.querySelector('.result-card') as HTMLElement | null;
        let cardSlot = RdioScannerSearchComponent.DEFAULT_CARD_SLOT_HEIGHT;
        if (firstCard) {
            const rect = firstCard.getBoundingClientRect();
            const cs = window.getComputedStyle(firstCard);
            cardSlot = rect.height + parseFloat(cs.marginBottom || '0');
        }
        if (cardSlot <= 0) return;

        const usable = containerHeight - RdioScannerSearchComponent.RESULTS_SCROLL_PADDING;
        const newPageSize = Math.max(3, Math.floor(usable / cardSlot));

        if (newPageSize === this.pageSize) return;

        // Keep the user's place: whichever row was the first on screen
        // stays the first on screen after we re-page.
        const firstVisibleRow = this.pageIndex * this.pageSize;
        this.pageSize = newPageSize;
        this.pageIndex = Math.floor(firstVisibleRow / newPageSize);
        this.refreshResults();
        this.ngChangeDetectorRef.detectChanges();
    }

    private mountRibbon(): void {
        const canvas = this.dockCanvasRef?.nativeElement;
        if (!canvas || this.ribbon) return;
        this.ribbon = new WaveformRibbon(canvas, {
            peaks: this.dockPeaks,
            duration: this.dockDuration,
            currentTime: this.dockTime,
            bgColor: 'rgba(0, 230, 118, 0.45)',
            fgColor: 'rgb(0, 230, 118)',
            cursorColor: 'rgb(220, 255, 235)',
            cursorWidth: 2,
            showCursor: true,
            onSeek: (t: number) => this.rdioScannerService.seek(t),
        });
    }

    private updateRibbon(): void {
        this.ribbon?.set({
            peaks: this.dockPeaks,
            duration: this.dockDuration,
            currentTime: this.dockTime,
            showCursor: this.dockDuration > 0,
        });
    }

    // --- Selector helpers (unchanged) ---

    private getSelectedGroup(): string | undefined {
        return this.optionsGroup[this.form.get('group')?.value ?? -1];
    }

    private getSelectedSystem(): RdioScannerSystem | undefined {
        return this.config?.systems.find((system) => system.label === this.optionsSystem[this.form.get('system')?.value ?? -1]);
    }

    private getSelectedTag(): string | undefined {
        return this.optionsTag[this.form.get('tag')?.value ?? -1];
    }

    private getSelectedTalkgroup(): RdioScannerTalkgroup | undefined {
        const system = this.getSelectedSystem();
        return system
            ? system.talkgroups.find((talkgroup) => talkgroup.label === this.optionsTalkgroup[this.form.get('talkgroup')?.value ?? -1])
            : undefined;
    }
}
