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

import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { MatSidenav } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { timer } from 'rxjs';
import { RdioScannerEvent, RdioScannerLivefeedMode } from './rdio-scanner';
import { RdioScannerService } from './rdio-scanner.service';
import { RdioScannerNativeComponent } from './native/native.component';
import { RdioScannerSearchComponent } from './search/search.component';

@Component({
    selector: 'rdio-scanner',
    styleUrls: ['./rdio-scanner.component.scss'],
    templateUrl: './rdio-scanner.component.html',
    standalone: false
})
export class RdioScannerComponent implements OnDestroy, OnInit {
    private eventSubscription;

    private livefeedMode: RdioScannerLivefeedMode = RdioScannerLivefeedMode.Offline;

    @ViewChild('searchPanel') private searchPanel: MatSidenav | undefined;

    @ViewChild('selectPanel') private selectPanel: MatSidenav | undefined;

    @ViewChild('searchComponent') private searchComponent: RdioScannerSearchComponent | undefined;

    /** Holds a `?call=<id>` deep-link target between page load and the
     *  first post-auth `config` event. Restricted instances will not
     *  emit `config` until the user submits a valid PIN, so this is
     *  naturally gated behind the same auth wall as everything else —
     *  no separate authorization check needed here. */
    private pendingDeepLinkCallId: number | undefined;

    constructor(
        private matSnackBar: MatSnackBar,
        private ngElementRef: ElementRef,
        private rdioScannerService: RdioScannerService,
    ) {
        // Parse the deep-link id eagerly (constructor is the earliest
        // point at which window is reliable). Holding it in memory until
        // `config` arrives means any websocket re-handshake or PIN retry
        // re-triggers the same code path automatically.
        try {
            const url = new URL(window.location.href);
            const raw = url.searchParams.get('call');
            if (raw && /^\d+$/.test(raw)) {
                this.pendingDeepLinkCallId = parseInt(raw, 10);
            }
        } catch {
            // URL parsing failed — nothing to consume.
        }

        this.eventSubscription = this.rdioScannerService.event.subscribe((event: RdioScannerEvent) => this.eventHandler(event));
    }

    @HostListener('window:beforeunload', ['$event'])
    exitNotification(event: BeforeUnloadEvent): void {
        if (this.livefeedMode !== RdioScannerLivefeedMode.Offline) {
            event.preventDefault();

            event.returnValue = 'Live Feed is ON, do you really want to leave?';
        }
    }

    ngOnDestroy(): void {
        this.eventSubscription.unsubscribe();
    }

    ngOnInit(): void {
        /*
         * BEGIN OF RED TAPE:
         * 
         * By modifying, deleting or disabling the following lines, you harm
         * the open source project and its author.  Rdio Scanner represents a lot of
         * investment in time, support, testing and hardware.
         * 
         * Be respectful, sponsor the project, use native apps when possible.
         * 
         */
        timer(10000).subscribe(() => {
            const ua: string = navigator.userAgent;

            if (ua.includes('Android') || ua.includes('iPad') || ua.includes('iPhone')) {
                this.matSnackBar.openFromComponent(RdioScannerNativeComponent);
            }
        });
        /**
         * END OF RED TAPE.
         */
    }

    scrollTop(e: HTMLElement): void {
        setTimeout(() => e.scrollTo(0, 0));
    }

    start(): void {
        this.rdioScannerService.startLivefeed();
    }

    stop(): void {
        this.rdioScannerService.stopLivefeed();

        this.searchPanel?.close();
        this.selectPanel?.close();
    }

    toggleFullscreen(): void {
        if (document.fullscreenElement) {
            const el: {
                exitFullscreen?: () => void;
                mozCancelFullScreen?: () => void;
                msExitFullscreen?: () => void;
                webkitExitFullscreen?: () => void;
            } = document;

            if (el.exitFullscreen) {
                el.exitFullscreen();

            } else if (el.mozCancelFullScreen) {
                el.mozCancelFullScreen();

            } else if (el.msExitFullscreen) {
                el.msExitFullscreen();

            } else if (el.webkitExitFullscreen) {
                el.webkitExitFullscreen();
            }

        } else {
            const el = this.ngElementRef.nativeElement;

            if (el.requestFullscreen) {
                el.requestFullscreen();

            } else if (el.mozRequestFullScreen) {
                el.mozRequestFullScreen();

            } else if (el.msRequestFullscreen) {
                el.msRequestFullscreen();

            } else if (el.webkitRequestFullscreen) {
                el.webkitRequestFullscreen();
            }
        }
    }

    private eventHandler(event: RdioScannerEvent): void {
        if (event.livefeedMode) {
            this.livefeedMode = event.livefeedMode;
        }

        // The server only emits Config after successful PIN auth on
        // restricted instances (and immediately on unrestricted ones),
        // so consuming the deep-link here transparently enforces the
        // access-code gate.
        if ('config' in event && this.pendingDeepLinkCallId !== undefined) {
            const id = this.pendingDeepLinkCallId;
            this.pendingDeepLinkCallId = undefined;
            this.consumeDeepLink(id);
        }
    }

    private consumeDeepLink(callId: number): void {
        // Open the search panel so the user can see the loaded call in
        // context. Even if the call isn't on page 1 of the result list,
        // the dock player at the bottom reflects it immediately.
        this.searchPanel?.open();
        this.searchComponent?.searchCalls();
        this.rdioScannerService.loadAndPlay(callId);

        // Strip ?call=… so a refresh doesn't re-trigger and the URL
        // settles to the canonical app path. Keeps existing hash.
        if (window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState({}, '', window.location.pathname + window.location.hash);
        }
    }
}
