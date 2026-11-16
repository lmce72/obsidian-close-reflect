/** A synchronous main-process guard; remote renderer callbacks arrive too late. */
interface Guard { release(): void; rearm(): void; dispose(): void; }
interface RemoteHost {
	electron: {
		remote: { require(id: string): { runInThisContext(source: string): (win: unknown, channel: string) => Guard } };
		ipcRenderer: { on(channel: string, listener: () => void): void; removeListener(channel: string, listener: () => void): void };
	};
	electronWindow: unknown;
}

export function installWindowsClose(onClose: () => void): Guard {
	const host = window as unknown as RemoteHost;
	const channel = `close-reflect:${crypto.randomUUID()}`;
	// Execute only this fixed source in the main process, never user content.
	const create = host.electron.remote.require('vm').runInThisContext(`
		(win, channel) => {
			let released = false;
			const handler = event => {
				if (released) return;
				event.preventDefault();
				// Obsidian sets this before our listener; a cancelled close is no longer closing.
				win.closing = false;
				win.webContents.send(channel);
			};
			const dispose = () => {
				win.removeListener('close', handler);
				win.webContents.removeListener('did-start-loading', dispose);
				win.webContents.removeListener('render-process-gone', dispose);
			};
			win.on('close', handler);
			win.webContents.on('did-start-loading', dispose);
			win.webContents.on('render-process-gone', dispose);
			return {
				release() { released = true; },
				rearm() { released = false; },
				dispose
			};
		}
	`);
	host.electron.ipcRenderer.on(channel, onClose);
	let guard: Guard;
	try { guard = create(host.electronWindow, channel); }
	catch (error) {
		host.electron.ipcRenderer.removeListener(channel, onClose);
		throw error;
	}
	return {
		release: () => guard.release(),
		rearm: () => guard.rearm(),
		dispose: () => {
			host.electron.ipcRenderer.removeListener(channel, onClose);
			guard.dispose();
		}
	};
}
