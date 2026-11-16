import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { installWindowsClose } from '../src/windows-close';

test('native cancellation survives delayed renderer delivery, release and teardown', async () => {
	const ipc = new EventEmitter();
	const win = Object.assign(new EventEmitter(), {
		closing: true,
		webContents: Object.assign(new EventEmitter(), {
			send(channel: string) { queueMicrotask(() => ipc.emit(channel)); }
		})
	});
	Object.defineProperty(globalThis, 'window', { configurable: true, value: {
		electronWindow: win,
		electron: { remote: { require: () => vm }, ipcRenderer: ipc }
	} });
	let prompts = 0;
	const guard = installWindowsClose(() => { prompts++; });
	const close = () => {
		const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
		win.emit('close', event);
		return event;
	};
	try {
		assert.equal(close().defaultPrevented, true);
		assert.equal(prompts, 0);
		assert.equal(win.closing, false);
		await Promise.resolve();
		assert.equal(prompts, 1);
		assert.equal(close().defaultPrevented, true);
		await Promise.resolve();
		assert.equal(prompts, 2);
		guard.release();
		assert.equal(close().defaultPrevented, false);
		guard.rearm();
		assert.equal(close().defaultPrevented, true);
		guard.dispose();
		assert.equal(win.listenerCount('close'), 0);
		assert.equal(win.webContents.listenerCount('did-start-loading'), 0);
		assert.equal(ipc.eventNames().length, 0);
		for (const event of ['did-start-loading', 'render-process-gone']) {
			const next = installWindowsClose(() => { prompts++; });
			win.webContents.emit(event);
			assert.equal(win.listenerCount('close'), 0);
			next.dispose();
		}
	} finally {
		guard.dispose();
		Reflect.deleteProperty(globalThis, 'window');
	}
});
