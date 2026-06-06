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

import { Component, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ConnectedClient, RdioScannerAdminService } from '../admin.service';

@Component({
    selector: 'rdio-scanner-admin-clients',
    styleUrls: ['./clients.component.scss'],
    templateUrl: './clients.component.html',
    standalone: false
})
export class RdioScannerAdminClientsComponent implements OnDestroy {
    clients = new BehaviorSubject<ConnectedClient[]>([]);

    pending = false;

    // Drives the live-ticking duration column; refreshed every second while
    // the panel is open so durations advance between list re-fetches.
    now = Date.now();

    private refreshTimer: ReturnType<typeof setInterval> | undefined;

    private clockTimer: ReturnType<typeof setInterval> | undefined;

    constructor(private adminService: RdioScannerAdminService) { }

    ngOnDestroy(): void {
        this.stop();
    }

    start(): void {
        this.reload();

        this.refreshTimer ??= setInterval(() => this.reload(), 5000);
        this.clockTimer ??= setInterval(() => (this.now = Date.now()), 1000);
    }

    stop(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        if (this.clockTimer) {
            clearInterval(this.clockTimer);
            this.clockTimer = undefined;
        }
    }

    async reload(): Promise<void> {
        this.pending = true;

        const clients = await this.adminService.getClients();

        this.pending = false;

        if (clients) {
            this.clients.next(clients);
        }
    }

    async disconnect(client: ConnectedClient): Promise<void> {
        this.pending = true;

        await this.adminService.disconnectClient(client.id);

        await this.reload();
    }

    duration(connectedAt: string): string {
        let seconds = Math.max(0, Math.floor((this.now - new Date(connectedAt).getTime()) / 1000));

        const hours = Math.floor(seconds / 3600);
        seconds -= hours * 3600;

        const minutes = Math.floor(seconds / 60);
        seconds -= minutes * 60;

        const pad = (n: number) => n.toString().padStart(2, '0');

        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }
}
