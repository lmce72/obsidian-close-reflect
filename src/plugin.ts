import { normalizePath, Platform, Plugin, TFile } from 'obsidian';
import { getCapacitorApp, listenForAppState, listenForBackButton, minimizeApp, removeListener } from './mobile-back';
import type { CapacitorAppPlugin, CapacitorAppState, CapacitorListenerHandle } from './mobile-back';
import { ReflectOverlay } from './modal';
import { splitFrontmatter, stripFrontmatter } from './note-text';
import { CloseReflectSettingTab } from './settings';
import { MAX_REMEMBERED_CHARS, migrateSettings } from './types';
import { performButtonAction } from './actions';
import type { CloseReflectSettings, QuitTasks, ReflectButton, ReflectOutcome } from './types';

/** How many diagnostic entries to keep. Heartbeats make this fill up quickly. */
const DIAG_LIMIT = 60;
/** Interval between heartbeat entries while the prompt is holding the quit open. */
const HEARTBEAT_MS = 2000;

/*
 * ── TEMPORARY TRACE (remove before shipping) ───────────────────────────────
 *
 * The vault diagnostics are written asynchronously, and they stop landing the moment the
 * app starts shutting down — which is exactly the window that has to be observed. This
 * appends synchronously to a file outside the vault instead, so the last line before the
 * process dies survives. Remove this block, `trace()`, and its call sites when the
 * shutdown sequence is understood.
 */
const TRACE_ENABLED = true;
/**
 * Whether the trace is actually written, driven by the plugin's developer-log switch.
 * Kept module-level so the ~25 call sites do not each have to consult the settings.
 */
let traceEnabled = false;
function syncTraceSwitch(enabled: boolean): void {
	traceEnabled = enabled;
}
/*
 * Node's `fs` and `os` are resolved defensively: on mobile there is no Node at all, and the
 * shim Obsidian loads plugins with throws for anything it does not know. An uncaught throw
 * here would take the whole plugin down at load, so a missing trace sink simply means the
 * trace is off.
 */
function loadNodeModule( id: string ): any {
	for ( const requireFn of [
		( window as unknown as { require?: ( id: string ) => unknown } ).require,
		typeof require === 'function' ? require as ( id: string ) => unknown : null
	] ) {
		if ( typeof requireFn !== 'function' ) continue;
		try {
			const loaded = requireFn( id );
			if ( loaded ) return loaded;
		} catch (error) {
			// Try the next one; only a total failure matters, and that is not an error here.
		}
	}
	return null;
}

const traceFs = loadNodeModule( 'fs' ) as { appendFileSync( path: string, data: string ): void } | null;
const traceOs = loadNodeModule( 'os' ) as { tmpdir(): string } | null;
const tracePath = traceFs && traceOs ? `${traceOs.tmpdir()}/close-reflect-trace.log` : null;

/** Append one line synchronously, so it survives a process that is about to die. */
function trace( message: string, extra?: Record<string, unknown> ): void {
	if (!TRACE_ENABLED || !traceEnabled || !traceFs || !tracePath) return;
	try {
		const stamp = `${Date.now()} +${Math.round(performance.now())}ms`;
		traceFs.appendFileSync(tracePath, `${stamp} ${message}${extra ? ' ' + JSON.stringify(extra) : ''}\n`);
	} catch (error) {
		console.error('[close-reflect] trace write failed:', error);
	}
}

interface DiagnosticEntry {
	[ key: string ]: unknown;
}

/** A short, log-safe description of an outcome — ids and actions, never whole button objects. */
function describeOutcome(outcome: ReflectOutcome): Record<string, unknown> {
	if (outcome.kind === 'button') {
		return { kind: outcome.kind, id: outcome.button.id, action: outcome.button.action };
	}
	return { kind: outcome.kind };
}

/*
 * The window handle Obsidian's bootstrap leaves on the renderer.
 *
 * `window.electron.remote` is `@electron/remote`, and `window.electronWindow` is
 * `remote.getCurrentWindow()` — the main process's BrowserWindow, seen through the remote
 * proxy. Declared structurally so the plugin does not depend on any package being present.
 */
interface RemoteElectron {
	remote?: { getCurrentWindow?: () => RemoteWindow | null } | null;
}

interface RemoteWindow {
	on( name: string, listener: ( event: RemoteCloseEvent ) => void ): unknown;
	removeListener( name: string, listener: ( event: RemoteCloseEvent ) => void ): unknown;
}

/** The main-process `close` event, as far as the renderer can use it. */
interface RemoteCloseEvent {
	preventDefault?: () => void;
}

/**
 * How the interception works, and why there are three flags.
 *
 * Obsidian hands every `quit` listener a Tasks object. Handing a promise to
 * `Tasks.addPromise()` makes Obsidian cancel the quit and wait; once the promise settles
 * it calls `window.close()` again. So intercepting a quit is "defer it, then let the
 * re-triggered quit through".
 *
 * Deferring is not holding, though. Obsidian paints its own opaque saving screen
 * (`.progress-bar-container`, z-index 10000) as soon as the quit starts — that happens
 * before even `beforeunload`, so it cannot be prevented, only out-layered (the overlay
 * sits at 10050). What we *can* control is the close itself, and to hold a quit reliably
 * every close path has to be blocked for as long as the prompt is up:
 *
 *   holding  — set for the whole time the prompt is open. Both `window.close` and
 *              `beforeunload` are blocked, so a repeated close attempt or a stray unload
 *              cannot slip past the prompt.
 *   veto     — set only by "stay". Obsidian fires one `window.close()` right after the
 *              promise settles; that one call is swallowed, then the flag clears.
 *   leaving  — set only by "leave". The quit Obsidian re-issues is passed through
 *              untouched, so the app saves and closes normally.
 *
 * A timeout, a render failure, or a missing API never sets any of them: every failure
 * path fails open, because a broken prompt must not make the app unclosable.
 */
export default class CloseReflectPlugin extends Plugin {
	/**
	 * `declare` narrows the base class's `settings?: unknown` to a concrete type without
	 * emitting a field, which is what the base class documents subclasses should do.
	 */
	declare settings: CloseReflectSettings;

	private interceptCount = 0;
	/** The prompt is open; every close path is blocked. */
	private holding = false;
	/** "Stay" was chosen; swallow the single window.close() Obsidian fires next. */
	private veto = false;
	private vetoTimer: number | null = null;
	/** "Leave" was chosen; let the quit Obsidian re-issues proceed. */
	private leaving = false;
	private leavingTimer: number | null = null;

	private originalWindowClose: ( () => void ) | null = null;
	private closePatched = false;
	private liveModal: ReflectOverlay | null = null;

	/**
	 * Obsidian's own `beforeunload` hook, captured while it is still installed.
	 *
	 * That hook is the only thing that fires the workspace `quit` event, and it erases
	 * itself on its first run — see `rearmQuitHook()`.
	 */
	private obsidianQuitHook: ( ( event: BeforeUnloadEvent ) => unknown ) | null = null;
	/** Set while the plugin is unloading, so late callbacks stay off a dead instance. */
	private unloaded = false;

	private heartbeatTimer: number | null = null;
	private heartbeatTick = 0;
	/** TEMPORARY: fast liveness ticker, so the trace shows when the renderer stopped. */
	private traceTimer: number | null = null;

	/** Obsidian mobile's Capacitor App plugin, once it has been reached. */
	private capacitorApp: CapacitorAppPlugin | null = null;
	/** The back-button subscription, so it can be removed when its toggle goes off. */
	private mobileBackHandle: CapacitorListenerHandle | null = null;
	/** The app-state subscription, likewise. */
	private mobileStateHandle: CapacitorListenerHandle | null = null;

	/** The main window's `close` listener, once it has been installed. */
	private mainWindowGuard: { win: RemoteWindow; handler: ( event: RemoteCloseEvent ) => void } | null = null;
	/**
	 * The most recent main-window `close` event, kept so it can be marked *after* dispatch.
	 *
	 * The `close` event fires before the renderer's `beforeunload`, so at the moment the
	 * listener runs the plugin has not yet decided to hold anything. The event object stays
	 * usable, and Obsidian reads `defaultPrevented` off it three seconds later — so the mark
	 * is made once the decision is in, not during dispatch.
	 */
	private pendingCloseEvent: RemoteCloseEvent | null = null;

	async onload(): Promise<void> {
		trace('onload:begin', { tracePath: tracePath, mobile: Platform.isMobileApp, desktop: Platform.isDesktopApp });
		this.unloaded = false;
		await this.loadSettings();
		this.addSettingTab(new CloseReflectSettingTab(this.app, this));

		// Keep the remembered copy of the linked note fresh, without blocking startup.
		void this.refreshLinkedCache();

		// Claim the flag the DataviewJS build checks, so it does not bind on a later render.
		( window as unknown as { __closeReflectBound?: boolean } ).__closeReflectBound = true;
		// Then stand the already-bound copy down. It has to happen before our own patch is
		// installed: its unbind() restores the window.close it captured, which would undo
		// ours if ours went on first.
		this.standDownLegacyBuild();

		// Grab Obsidian's own beforeunload hook before it can erase itself; it is what fires
		// the `quit` event, and putting it back is what lets a second close be intercepted.
		this.captureObsidianQuitHook();

		this.registerEvent(this.app.workspace.on('quit', (tasks: QuitTasks) => this.handleQuit(tasks)));
		this.registerDomEvent(window, 'beforeunload', (event: BeforeUnloadEvent) => this.handleBeforeUnload(event));
		this.installWindowClosePatch();
		this.installMainWindowGuard();
		this.syncMobileHandlers();

		// Plugins can load before the layout finalize step that installs the hook, so look
		// again once the workspace is up.
		this.app.workspace.onLayoutReady(() => {
			if (!this.unloaded) this.captureObsidianQuitHook();
		});

		this.addCommand({
			// Obsidian namespaces command ids with the plugin id, so neither is repeated here.
			id: 'preview-reflection-modal',
			name: 'Preview the reflection modal',
			callback: () => { this.preview(); }
		});

		this.log('loaded');
		trace('onload:end', { closePatched: this.closePatched, hookCaptured: !!this.obsidianQuitHook });
	}

	onunload(): void {
		trace('onunload');
		this.unloaded = true;
		this.pendingCloseEvent = null;
		removeListener( this.mobileBackHandle );
		removeListener( this.mobileStateHandle );
		this.mobileBackHandle = null;
		this.mobileStateHandle = null;
		this.stopHeartbeat();
		this.holding = false;
		this.clearVeto('unload');
		this.leaving = false;
		if (this.leavingTimer !== null) {
			window.clearTimeout(this.leavingTimer);
			this.leavingTimer = null;
		}
		if (this.closePatched && this.originalWindowClose) {
			window.close = this.originalWindowClose;
			this.closePatched = false;
		}
		if (this.mainWindowGuard) {
			try {
				this.mainWindowGuard.win.removeListener('close', this.mainWindowGuard.handler);
			} catch (error) {
				this.error('failed to remove the main window close guard:', error);
			}
			this.mainWindowGuard = null;
		}
		if (this.liveModal) {
			try { this.liveModal.close(); } catch (error) { this.error('failed to close the overlay on unload:', error); }
			this.liveModal = null;
		}
	}

	/**
	 * Detach the DataviewJS build of this feature if it is already listening.
	 *
	 * It shares the diagnostics file, so two live copies fight over the read-modify-write
	 * and produce two stacked overlays.
	 */
	private standDownLegacyBuild(): void {
		try {
			const legacy = ( window as unknown as {
				__closeReflect?: { unbind?: () => void };
			} ).__closeReflect;
			if ( legacy && typeof legacy.unbind === 'function' ) {
				legacy.unbind();
				this.log('stood the DataviewJS build down');
			}
		} catch (error) {
			this.error('failed to stand the DataviewJS build down:', error);
		}
	}

	/**
	 * Remember Obsidian's own `beforeunload` hook.
	 *
	 * That hook is what triggers the workspace `quit` event, and it opens by setting
	 * `window.onbeforeunload = null` so the `window.close()` it re-issues afterwards cannot
	 * loop back into itself. The side effect is a session gets exactly one `quit` event:
	 * after the first close attempt — even one this plugin cancelled — no later close
	 * reaches the plugin at all. Keeping the function lets it be put back.
	 */
	private captureObsidianQuitHook(): void {
		try {
			const hook = window.onbeforeunload;
			if ( typeof hook === 'function' ) {
				this.obsidianQuitHook = hook as ( event: BeforeUnloadEvent ) => unknown;
				this.log('captured Obsidian\'s quit hook');
			}
			trace('captureQuitHook', { captured: !!this.obsidianQuitHook, type: typeof hook });
		} catch (error) {
			this.error('failed to capture Obsidian\'s quit hook:', error);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = migrateSettings(await this.loadData());
		syncTraceSwitch(this.settings.logToConsole);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// The developer-log switch also gates the trace, and must apply without a reload.
		syncTraceSwitch(this.settings.logToConsole);
		// Likewise the mobile gesture toggles.
		this.syncMobileHandlers();
	}

	/** Quits interrupted so far this session. */
	getInterceptCount(): number {
		return this.interceptCount;
	}

	resetInterceptCount(): void {
		this.interceptCount = 0;
		this.log('intercept counter reset');
	}

	/** Show the overlay without quitting. Display only — it never holds anything. */
	preview(): void {
		void this.showModal().then((outcome) => { this.log('preview outcome:', describeOutcome(outcome)); });
	}

	/**
	 * Body for the overlay: the linked note's contents, or the remembered copy when the
	 * note cannot be read. Never writes, so it is safe to call during a quit.
	 */
	async resolveContent(): Promise<string> {
		const settings = this.settings;
		if (settings.source !== 'linked') return settings.content;

		const path = settings.linkedPath.trim();
		if (path === '') return settings.content;

		try {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
			if (file instanceof TFile && file.extension === 'md') {
				return await this.readNoteBody(file);
			}
			this.warn('linked note not found; using the remembered copy');
		} catch (error) {
			this.error('reading the linked note failed; using the remembered copy:', error);
		}
		return settings.linkedCache !== '' ? settings.linkedCache : settings.content;
	}

	/**
	 * Read a note's body with its frontmatter removed — the shape both resolveContent()
	 * and the remembered copy want.
	 */
	private async readNoteBody( file: TFile ): Promise<string> {
		return stripFrontmatter( await this.app.vault.cachedRead( file ) );
	}

	/**
	 * The linked note's current body, or null when it cannot be read.
	 *
	 * Distinct from resolveContent(), which falls back to the remembered copy: that fallback
	 * is right for showing, but writing it back into the note would be wrong.
	 */
	async readLinkedBody(): Promise<string | null> {
		const path = this.settings.linkedPath.trim();
		if ( path === '' ) return null;
		try {
			const file = this.app.vault.getAbstractFileByPath( normalizePath( path ) );
			if ( !( file instanceof TFile ) || file.extension !== 'md' ) return null;
			return await this.readNoteBody( file );
		} catch (error) {
			this.error( 'reading the linked note for editing failed:', error );
			return null;
		}
	}

	/**
	 * Write an edited body back into the linked note.
	 *
	 * `vault.process()` so a concurrent write cannot be lost, and the frontmatter is taken
	 * from disk at that moment and kept verbatim: the edit modal shows the body only, so
	 * rebuilding the file from the draft would silently drop the properties.
	 *
	 * @param body the new body, frontmatter excluded
	 * @param expectedBody the body that was loaded into the editor, used to spot a note that
	 *   changed underneath — the write still happens, but it is reported
	 */
	async writeLinkedBody( body: string, expectedBody: string ): Promise<void> {
		const path = this.settings.linkedPath.trim();
		if ( path === '' ) throw new Error( 'no linked note is configured' );

		const file = this.app.vault.getAbstractFileByPath( normalizePath( path ) );
		if ( !( file instanceof TFile ) || file.extension !== 'md' ) {
			throw new Error( `the linked note is not a Markdown file: ${path}` );
		}

		await this.app.vault.process( file, ( data ) => {
			const parts = splitFrontmatter( data );
			if ( parts.body !== expectedBody ) {
				this.warn( 'the linked note changed underneath the editor; saving over it anyway' );
			}
			return parts.frontmatter + body;
		} );

		// The remembered copy is what the overlay falls back to, so keep it in step.
		await this.refreshLinkedCache();
		this.log( 'linked note body written back:', path );
	}

	/**
	 * Read the linked note and remember its contents, so a later quit still has something
	 * to show if the note is gone.
	 *
	 * Called when the path changes, once on load, and from the settings button — never
	 * during a quit, so the vault is never written to while the app is shutting down.
	 */
	async refreshLinkedCache(): Promise<void> {
		const settings = this.settings;
		if (settings.source !== 'linked') return;

		const path = settings.linkedPath.trim();
		if (path === '') {
			if (settings.linkedCache !== '' || settings.linkedCachedAt !== '') {
				settings.linkedCache = '';
				settings.linkedCachedAt = '';
				await this.saveSettings();
			}
			return;
		}

		try {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile) || file.extension !== 'md') {
				this.warn('cannot remember a copy: no markdown note at', path);
				return;
			}
			const text = await this.readNoteBody(file);
			settings.linkedCache = text.length > MAX_REMEMBERED_CHARS
				? text.slice(0, MAX_REMEMBERED_CHARS)
				: text;
			settings.linkedCachedAt = new Date().toISOString();
			await this.saveSettings();
			this.log('remembered copy refreshed:', path, settings.linkedCache.length, 'chars');
		} catch (error) {
			this.error('refreshing the remembered copy failed:', error);
		}
	}

	// ── Quit handling ──────────────────────────────────────────────────────────

	private handleQuit(tasks: QuitTasks): void {
		trace('handleQuit:enter', { leaving: this.leaving, holding: this.holding, count: this.interceptCount });
		try {
			if (this.leaving) {
				this.log('leave was chosen; not intercepting this quit');
				trace('handleQuit:skip-leaving');
				return;
			}
			if (this.holding) {
				this.log('already prompting; not intercepting again');
				trace('handleQuit:skip-holding');
				return;
			}
			if (this.interceptCount >= this.settings.intercepts) {
				this.log('interception budget spent; allowing the quit');
				trace('handleQuit:skip-budget');
				return;
			}
			this.interceptCount += 1;
			this.log(`interception #${this.interceptCount}`);

			if (!tasks || typeof tasks.addPromise !== 'function') {
				this.warn('Tasks.addPromise unavailable; cannot defer the quit');
				trace('handleQuit:skip-no-addPromise');
				return;
			}

			this.holding = true;
			this.startHeartbeat();
			// The prompt is going up, so the close it is holding must survive past Obsidian's
			// three-second force-close.
			this.markCloseEvent('holding');

			// The diagnostic write leads the sequence, so Obsidian waits for it to land
			// before the app can close.
			const sequence = this.writeDiagnostic('quit-intercepted')
				.then(() => { trace('seq:diag-written'); return this.showModal(); })
				.then((outcome) => this.applyOutcome(outcome));

			tasks.addPromise(sequence);
			trace('handleQuit:promise-added');
		} catch (error) {
			this.holding = false;
			this.stopHeartbeat();
			trace('handleQuit:threw', { error: String(error) });
			this.error('quit hook threw; allowing this quit:', error);
		}
	}

	/**
	 * Act on how the prompt was dismissed.
	 *
	 * Every path except "let the app close" cancels the quit: it arms the single-use veto that
	 * swallows the `window.close()` Obsidian fires right after the promise settles, and takes
	 * down the "Saving..." screen that close would otherwise have dismissed. A button whose
	 * action is something other than cancelling then runs its own action — the app is staying
	 * open for it.
	 *
	 * Nothing here may throw: this runs inside the promise Obsidian is awaiting, so a
	 * rejection would leave the quit held with no way to answer it.
	 */
	private applyOutcome(outcome: ReflectOutcome): Promise<void> {
		trace('seq:settled', { outcome: describeOutcome(outcome) });
		this.stopHeartbeat();
		this.holding = false;

		try {
			if (this.letsTheAppGo(outcome)) {
				this.log('exit allowed through:', describeOutcome(outcome));
				this.allowTheExit();
				return this.writeDiagnostic('quit-settled', { outcome: describeOutcome(outcome) });
			}

			this.cancelTheExit();

			if (outcome.kind === 'button' && outcome.button.action !== 'stay') {
				// Fire and forget: performButtonAction never throws, and the quit is already
				// cancelled, so a failed action leaves the app open rather than mid-quit.
				performButtonAction(
					this.app,
					outcome.button,
					(message, error) => this.error(message, error)
				);
			}
		} catch (error) {
			// Never rethrow — the quit is being held by the promise this runs in.
			this.error('handling the prompt outcome threw:', error);
		}

		return this.writeDiagnostic('quit-settled', { outcome: describeOutcome(outcome) });
	}

	/**
	 * Let the app go.
	 *
	 * On desktop that means letting Obsidian finish the quit it started. On mobile there is no
	 * quit to finish — the back button is not a quit, and nothing is being held — so the app is
	 * sent to the background, which is exactly what Obsidian's own second back press does.
	 */
	private allowTheExit(): void {
		if ( Platform.isMobileApp ) {
			if ( this.capacitorApp ) minimizeApp( this.capacitorApp );
			return;
		}
		this.allowTheQuit();
	}

	/**
	 * Keep the app.
	 *
	 * On desktop the quit has to be actively cancelled, which is what the veto and the saving
	 * screen are for. On mobile nothing is held, so the prompt closing is the whole of it.
	 */
	private cancelTheExit(): void {
		if ( Platform.isMobileApp ) return;
		this.raiseVeto();
		this.dismissSavingOverlay();
	}

	/**
	 * Whether this outcome lets the app close.
	 *
	 * Only a button whose action is "let the app close" does. An unanswered prompt follows the
	 * timeout action; a dismissed overlay and every other button cancel the quit.
	 */
	private letsTheAppGo(outcome: ReflectOutcome): boolean {
		// Nothing was shown, so there is nothing to answer — always release.
		if (outcome.kind === 'error') return true;
		if (outcome.kind === 'timeout') return this.settings.timeoutAction === 'leave';
		if (outcome.kind === 'button') return outcome.button.action === 'leave';
		return false;
	}

	/**
	 * The buttons to render — never empty.
	 *
	 * migrateSettings() already guarantees at least one, but the settings UI lets every row be
	 * deleted before saving, so this is the second line of defence: an overlay with no buttons
	 * could not be answered, and the quit would hang until the timeout released it.
	 */
	private getEffectiveButtons(): ReflectButton[] {
		if (this.settings.buttons.length > 0) return this.settings.buttons;
		this.warn('no buttons configured; falling back to a single "cancel the quit" button');
		return [ { id: 'fallback-stay', label: 'Cancel the quit', action: 'stay', target: '' } ];
	}

	private showModal(): Promise<ReflectOutcome> {
		trace('showModal:enter');
		return new Promise<ReflectOutcome>((resolve) => {
			let settled = false;
			let timedOut = false;
			let timer: number | null = null;

			const finish = (outcome: ReflectOutcome) => {
				if (settled) return;
				trace('showModal:finish', { outcome: describeOutcome(outcome), timedOut: timedOut });
				settled = true;
				if (timer !== null) window.clearTimeout(timer);
				this.liveModal = null;
				resolve(outcome);
			};

			// Expiry resolves as 'timeout' and applyOutcome() applies the configured timeout
			// action — the timeout's own close() must not be read as a user answer.
			timer = window.setTimeout(() => {
				timedOut = true;
				this.warn('prompt timed out; applying the timeout action');
				if (this.liveModal) {
					try { this.liveModal.close(); } catch (error) { this.error('failed to close the timed-out prompt:', error); }
				}
				finish({ kind: 'timeout' });
			}, this.settings.timeoutMs);

			// The body may have to be read from a note, so opening is asynchronous. The quit
			// is already being held by the caller, so this only delays the prompt.
			void this.resolveContent()
				.then((content) => {
					trace('showModal:content-resolved', { settled: settled, chars: content.length });
					if (settled) return;
					const overlay = new ReflectOverlay(this.app, {
						title: this.settings.title,
						content: content,
						buttons: this.getEffectiveButtons(),
						onClose: (outcome) => {
							if (timedOut) return;
							finish(outcome);
						}
					});
					this.liveModal = overlay;
					overlay.open();
					trace('showModal:overlay-opened', {
						inBody: !!overlay.element && document.body.contains(overlay.element)
					});

					// One frame later, record whether the overlay actually became visible.
					window.setTimeout(() => {
						void this.measureRaf().then((rafAlive) => {
							return this.writeDiagnostic('modal-shown', { rafAlive: rafAlive });
						});
					}, 250);
				})
				.catch((error) => {
					// Fail open regardless of the timeout action: there is nothing on screen to
					// answer, so holding the quit would leave the user stuck.
					this.error('failed to open the overlay; releasing the quit:', error);
					finish({ kind: 'error' });
				});
		});
	}

	// ── Holding the quit open ──────────────────────────────────────────────────

	private raiseVeto(): void {
		this.veto = true;
		// "stay" has to outlive the three-second guard as well: Obsidian's follow-up close
		// goes to window.close(), but a stray beforeunload path could still be pending.
		this.markCloseEvent('veto');
		if (this.vetoTimer !== null) window.clearTimeout(this.vetoTimer);
		// The flag is consumed by whichever close path fires next; if none does, it expires
		// rather than leaking into an unrelated quit later on.
		this.vetoTimer = window.setTimeout(() => {
			this.vetoTimer = null;
			if (this.veto) {
				this.veto = false;
				this.warn('veto flag expired unused');
				// No follow-up close ever came, so the app is still here with a spent hook.
				this.rearmQuitHook('veto-expired');
			}
		}, 5000);
		this.log('veto raised; the follow-up close will be swallowed');
	}

	/**
	 * Put Obsidian's quit hook back after a quit the plugin cancelled.
	 *
	 * Obsidian installs the hook once per session and the hook clears itself on its first
	 * run, so without this the prompt would appear on the first close of a session and never
	 * again — later closes would not even reach the `quit` listener. Restoring the hook also
	 * restores Obsidian's own quit work (saving the layout and the config) that runs from
	 * inside it.
	 *
	 * Only ever fills an empty slot: if Obsidian has installed a fresh hook since, that one
	 * is current and must not be clobbered. And it must run *after* the re-issued
	 * `window.close()` has been handled — re-arming while that call is still in flight would
	 * hand it the hook and re-open the prompt.
	 */
	private rearmQuitHook(source: string): void {
		trace('rearmQuitHook', { source: source, captured: !!this.obsidianQuitHook, slotNull: window.onbeforeunload === null });
		if (!this.obsidianQuitHook) return;
		if (window.onbeforeunload !== null) return;
		try {
			window.onbeforeunload = this.obsidianQuitHook as typeof window.onbeforeunload;
			this.log('Obsidian quit hook re-armed:', source);
			void this.writeDiagnostic('quit-hook-rearmed', { source: source });
		} catch (error) {
			this.error('failed to re-arm Obsidian\'s quit hook:', error);
		}
	}

	private clearVeto(reason: string): void {
		this.veto = false;
		if (this.vetoTimer !== null) {
			window.clearTimeout(this.vetoTimer);
			this.vetoTimer = null;
		}
		this.log('veto cleared:', reason);
	}

	/**
	 * Let the quit Obsidian re-issues after "leave" through, and re-arm if it never lands.
	 *
	 * A stuck `leaving` would silently disable every later interception, so it self-clears
	 * on a timer: if the app is still here after a few seconds, the quit did not happen and
	 * the next one should be intercepted again.
	 */
	private allowTheQuit(): void {
		this.leaving = true;
		if (this.leavingTimer !== null) window.clearTimeout(this.leavingTimer);
		this.leavingTimer = window.setTimeout(() => {
			this.leavingTimer = null;
			if (this.leaving) {
				this.leaving = false;
				this.warn('leave did not close the app; re-arming interception');
			}
		}, 8000);
	}

	private installWindowClosePatch(): void {
		if (this.closePatched) return;
		try {
			const original = window.close;
			this.originalWindowClose = original;
			window.close = () => {
				trace('window.close:called', { holding: this.holding, veto: this.veto, caller: this.callerStack().slice(0, 120) });
				if (this.holding) {
					this.log('window.close() swallowed while prompting');
					void this.writeDiagnostic('window-close-swallowed', { whileHolding: true, caller: this.callerStack() });
					return;
				}
				if (this.veto) {
					this.clearVeto('consumed-by-window.close');
					// This is the re-issued close "stay" was waiting for, and it has now been
					// swallowed — safe to re-arm Obsidian's hook for the next close.
					this.rearmQuitHook('consumed-by-window.close');
					this.log('window.close() swallowed after "stay"');
					void this.writeDiagnostic('window-close-swallowed', { whileHolding: false, caller: this.callerStack() });
					return;
				}
				this.log('window.close() forwarded');
				original.call(window);
			};
			this.closePatched = true;
			this.log('window.close patched');
		} catch (error) {
			// Not fatal: beforeunload is still in place as a backstop.
			this.error('failed to patch window.close:', error);
		}
	}

	/**
	 * Stand Obsidian's three-second force-close down while the prompt is open.
	 *
	 * Obsidian's main process arms this on every window close:
	 *
	 *     g.on("close", v => { g.closing = true, ...,
	 *       setTimeout(() => { !v.defaultPrevented && !g.isDestroyed() && g.destroy() }, 3000) });
	 *
	 * `close.defaultPrevented` is only ever written by a listener on that event calling
	 * `preventDefault()`. The renderer's `beforeunload` cancellation travels a different
	 * channel (`will-prevent-unload`) and never marks it — so a quit held open from the
	 * renderer is force-destroyed after three seconds no matter what the prompt is doing.
	 * The timer reads the flag three seconds later, so it does not matter that Obsidian's own
	 * listener was registered first and runs before this one.
	 *
	 * Obsidian's bootstrap puts the window within reach: it requires `@electron/remote`,
	 * assigns it to `window.electron.remote`, and stores `getCurrentWindow()` on
	 * `window.electronWindow`. Joining that same `close` event and marking it is what makes
	 * the timer stand down.
	 *
	 * The event is only marked while the prompt is open (`holding`) or while a "stay" is
	 * being finalised (`veto`); when the quit is allowed through it is left untouched, so the
	 * app closes normally. Every failure path returns quietly — without the remote module the
	 * plugin behaves exactly as before, three-second ceiling included.
	 */
	private installMainWindowGuard(): void {
		// The guard exists to stop Obsidian's main process force-closing the window. There is
		// no such process on mobile, and no `@electron/remote` either.
		if ( !Platform.isDesktopApp ) return;
		try {
			const host = window as unknown as { electron?: RemoteElectron; electronWindow?: RemoteWindow };
			const remote = host.electron?.remote;
			const win = host.electronWindow ?? remote?.getCurrentWindow?.() ?? null;
			trace('mainWindowGuard:probe', { hasElectron: !!host.electron, hasRemote: !!remote, hasWindow: !!win });
			if (!win || typeof win.on !== 'function') {
				this.warn('main window handle unavailable; the three-second close guard stays in force');
				return;
			}

			const handler = (event: RemoteCloseEvent): void => {
				// Kept, not marked. This runs *during* the close dispatch, and calling
				// preventDefault() now would cancel the close outright — the renderer would
				// never get its `beforeunload`, the `quit` event would never fire and the
				// prompt would never appear. markCloseEvent() runs once holding is decided.
				this.pendingCloseEvent = event;
				trace('mainWindowGuard:close-seen', { holding: this.holding, veto: this.veto });
			};

			win.on('close', handler);
			this.mainWindowGuard = { win: win, handler: handler };
			this.log('main window close guard installed');
		} catch (error) {
			this.error('failed to install the main window close guard:', error);
		}
	}

	/**
	 * Take down the "Saving..." screen Obsidian raises for the quit we are holding.
	 *
	 * Obsidian's quit hook does two things in a row: it shows its progress screen, then
	 * awaits the quit tasks and calls `window.close()` to finish the quit. Holding the quit
	 * means swallowing that `window.close()`, so the screen it raised is never taken down —
	 * it spins forever and the app is unusable behind it, which is indistinguishable from
	 * having closed.
	 *
	 * The screen belongs to a private singleton inside Obsidian
	 * (`pA.instance.show().setMessage("Saving...")`); every reference to it lives in
	 * Obsidian's own bundle and none of them is exposed on `app` or `window`, so the plugin
	 * cannot reach the instance to call `hide()`. What `hide()` does is small and stable,
	 * though — `containerEl.remove()` plus `body.removeClass("in-progress")` — and this
	 * repeats exactly that. The singleton keeps its own reference to the element, so a later
	 * `show()` prepends it again; nothing is destroyed that Obsidian cannot rebuild.
	 *
	 * `in-progress` is not cosmetic: it drives titlebar rules such as
	 * `.body.is-frameless.in-progress .titlebar { z-index: 10001 }`, so leaving it behind
	 * would leave the window in a half-quit state.
	 */
	private dismissSavingOverlay(): void {
		try {
			const doc = window.document;
			const container = doc.querySelector('.progress-bar-container');
			if (container) container.remove();
			doc.body.removeClass('in-progress');
			trace('savingOverlay:dismissed', { found: !!container });
			this.log('saving screen dismissed', container ? '' : '(none was up)');
		} catch (error) {
			this.error('failed to dismiss the saving screen:', error);
		}
	}

	/**
	 * Mark the in-flight close event as prevented, once the decision to hold is in.
	 *
	 * This is the half that stops Obsidian's three-second force-close: `defaultPrevented` is
	 * read by its timer three seconds after the close, not at dispatch time, so marking the
	 * event a few milliseconds late is early enough. It must not happen during dispatch —
	 * that would cancel the close before `beforeunload` ran. See installMainWindowGuard().
	 */
	private markCloseEvent(reason: string): void {
		const event = this.pendingCloseEvent;
		if (!event) return;
		try {
			event.preventDefault?.();
			trace('mainWindowGuard:close-marked', { reason: reason, holding: this.holding, veto: this.veto });
		} catch (error) {
			this.error('failed to mark the window close event:', error);
		}
	}

	// ── Mobile ─────────────────────────────────────────────────────────────────

	/**
	 * Subscribe to whichever leaving gestures the user has turned on.
	 *
	 * Re-run whenever settings are saved, so a toggle takes effect without a reload. Each
	 * subscription is installed once, and removed when its toggle goes off.
	 */
	private syncMobileHandlers(): void {
		if ( !Platform.isMobileApp ) return;

		if ( ( this.settings.mobileBackButton || this.settings.mobileGoingHome ) && !this.capacitorApp ) {
			this.capacitorApp = getCapacitorApp();
			if ( !this.capacitorApp ) {
				this.warn( 'the Capacitor App plugin is unreachable; the leaving gestures are left alone' );
				return;
			}
		}

		if ( this.settings.mobileBackButton && !this.mobileBackHandle && this.capacitorApp ) {
			this.mobileBackHandle = listenForBackButton( this.capacitorApp, () => this.handleMobileBack() );
		} else if ( !this.settings.mobileBackButton && this.mobileBackHandle ) {
			removeListener( this.mobileBackHandle );
			this.mobileBackHandle = null;
		}

		if ( this.settings.mobileGoingHome && !this.mobileStateHandle && this.capacitorApp ) {
			this.mobileStateHandle = listenForAppState( this.capacitorApp, ( state ) => this.handleMobileAppState( state ) );
		} else if ( !this.settings.mobileGoingHome && this.mobileStateHandle ) {
			removeListener( this.mobileStateHandle );
			this.mobileStateHandle = null;
		}
	}

	/**
	 * A back press.
	 *
	 * Capacitor delivers the event to every listener and offers no way to stop the others, so
	 * this runs alongside Obsidian's own handler rather than replacing it — it can answer the
	 * presses that matter and let the rest through. The ones that matter are the presses
	 * Obsidian would use to leave; a press with somewhere to go back to is navigation.
	 */
	private handleMobileBack(): void {
		if ( !this.isAboutToLeave() ) return;
		this.showMobilePrompt( 'back button' );
	}

	/**
	 * The app is heading to the home screen.
	 *
	 * Nothing can be cancelled here — the app is already leaving — so the prompt it raises is
	 * one to be found on the way back in.
	 */
	private handleMobileAppState( state: CapacitorAppState ): void {
		if ( state && state.isActive === false ) this.showMobilePrompt( 'home screen' );
	}

	private showMobilePrompt( trigger: string ): void {
		if ( this.holding ) return;
		if ( this.interceptCount >= this.settings.intercepts ) {
			this.log( `interception budget spent; ignoring the ${trigger}` );
			return;
		}

		this.interceptCount += 1;
		this.holding = true;
		this.log( `intercepting the ${trigger} (#${this.interceptCount})` );

		// Nothing is being held on mobile, so every failure path can simply let go.
		void this.showModal()
			.then( ( outcome ) => this.applyOutcome( outcome ) )
			.catch( ( error ) => {
				this.holding = false;
				this.error( 'showing the prompt failed:', error );
			} );
	}

	/**
	 * Whether Obsidian's own back handling is about to leave the app rather than navigate.
	 *
	 * Mirroring that condition is what keeps the prompt off the back gesture's normal job:
	 * Obsidian only reaches "press back again to exit" once both sidebars are collapsed and
	 * the active leaf has nothing left to go back to.
	 */
	private isAboutToLeave(): boolean {
		try {
			const workspace = this.app.workspace as unknown as {
				leftSplit?: { collapsed?: boolean };
				rightSplit?: { collapsed?: boolean };
				activeLeaf?: { history?: { backHistory?: unknown[] } };
			};

			const sidesClosed = ( workspace.leftSplit?.collapsed ?? true )
				&& ( workspace.rightSplit?.collapsed ?? true );
			if ( !sidesClosed ) return false;

			return ( workspace.activeLeaf?.history?.backHistory?.length ?? 0 ) === 0;
		} catch (error) {
			this.error( 'could not read the workspace state; not intercepting this back press:', error );
			return false;
		}
	}

	private handleBeforeUnload(event: BeforeUnloadEvent): void {
		const holding = this.holding;
		const veto = this.veto;
		// The legacy property is what Electron reads to decide the close, and Obsidian's own
		// hook writes "Saving..." into it — so capturing it here also shows whether that hook
		// ran before this listener.
		const legacy = event as unknown as { returnValue: unknown };
		const returnValueBefore = String(legacy.returnValue);
		// Recorded either way, so the log shows which of beforeunload and the quit event
		// fires first, and whether anything cancelled the unload.
		void this.writeDiagnostic('beforeunload', { holding: holding, veto: veto, returnValueBefore: returnValueBefore });
		if (!holding && !veto) {
			trace('beforeunload:pass-through', { returnValueBefore: returnValueBefore });
			return;
		}

		if (!holding) {
			this.clearVeto('consumed-by-beforeunload');
			// The unload is about to be cancelled, so no further close is in flight.
			this.rearmQuitHook('consumed-by-beforeunload');
		}
		trace('beforeunload:acting', { holding: holding, veto: veto, returnValueBefore: returnValueBefore });
		event.preventDefault();
		// Electron cancels the close when `beforeunload` asks it to, and a non-empty
		// `returnValue` is the documented, explicit form. Obsidian's own hook sets one and
		// runs first, so leave that in place and only fill an empty slot — writing `false`
		// here would clobber the very value the cancellation rides on.
		if ( typeof legacy.returnValue !== 'string' || legacy.returnValue === '' ) {
			legacy.returnValue = 'Reflecting...';
		}
		trace('beforeunload:done', { returnValueAfter: String(legacy.returnValue), defaultPrevented: event.defaultPrevented });
		this.log('unload cancelled', holding ? 'while prompting' : 'after "stay"');
	}

	/** Where a swallowed window.close() came from, so the log names the caller. */
	private callerStack(): string {
		try {
			throw new Error('trace');
		} catch (error) {
			const lines = String((error as Error).stack || '').split('\n');
			return lines.slice(2, 8).map((line) => line.trim()).join(' | ');
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTick = 0;
		// TEMPORARY: a fast liveness tick, so the trace shows the exact moment the renderer
		// stopped running rather than the 2 s granularity of the vault heartbeat.
		this.traceTimer = window.setInterval(() => { trace('alive'); }, 250);
		// The heartbeat is what shows how long the prompt actually held the quit open — the
		// difference between "we released it" and "something else closed the app".
		this.heartbeatTimer = window.setInterval(() => {
			this.heartbeatTick += 1;
			void this.writeDiagnostic('heartbeat', { tick: this.heartbeatTick });
		}, HEARTBEAT_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			window.clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.traceTimer !== null) {
			window.clearInterval(this.traceTimer);
			this.traceTimer = null;
		}
	}

	// ── Diagnostics ────────────────────────────────────────────────────────────

	private measureRaf(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let fired = false;
			try {
				window.requestAnimationFrame(() => { fired = true; });
			} catch (error) {
				this.error('requestAnimationFrame unavailable:', error);
				return resolve(false);
			}
			window.setTimeout(() => resolve(fired), 300);
		});
	}

	private snapshot(phase: string, extra?: Record<string, unknown>): DiagnosticEntry {
		const entry: DiagnosticEntry = {
			at: new Date().toISOString(),
			phase: phase,
			interceptCount: this.interceptCount,
			holding: this.holding,
			veto: this.veto,
			leaving: this.leaving,
			heartbeatTick: this.heartbeatTick,
			closePatched: this.closePatched,
			appVersion: ( this.app as unknown as { appVersion?: string } ).appVersion ?? null,
			visibility: document.visibilityState,
			hidden: document.hidden,
			hasFocus: document.hasFocus(),
			overlayOpen: this.liveModal !== null,
			ourZ: null,
			ourRect: null,
			topmost: null,
			weAreTopmost: null,
			covering: []
		};

		try {
			const ours = document.querySelector<HTMLElement>('.close-reflect-overlay');
			if (ours) {
				const rect = ours.getBoundingClientRect();
				entry.ourZ = window.getComputedStyle(ours).zIndex;
				entry.ourRect = [ Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height) ];
				const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + 20);
				entry.topmost = top ? String(( top as HTMLElement ).className || top.tagName) : null;
				entry.weAreTopmost = !!( top && ( ours === top || ours.contains(top) ) );
			}

			// Anything larger than the overlay and layered above it is the likely reason it
			// cannot be seen — this is what names the culprit in the log.
			const mine = Number.parseInt(String(entry.ourZ ?? '0'), 10) || 0;
			const covering: DiagnosticEntry[] = [];
			document.querySelectorAll<HTMLElement>('body > div, .modal-container, .modal, .notice-container').forEach((el) => {
				const style = window.getComputedStyle(el);
				if (style.position !== 'fixed' && style.position !== 'absolute') return;
				const z = Number.parseInt(style.zIndex || '0', 10) || 0;
				if (z <= mine) return;
				const rect = el.getBoundingClientRect();
				if (rect.width < 100 || rect.height < 60) return;
				covering.push({
					z: z,
					cls: String(el.className).slice(0, 70),
					text: ( el.textContent || '' ).replace(/\s+/g, ' ').trim().slice(0, 60)
				});
			});
			entry.covering = covering.slice(0, 10);
		} catch (error) {
			entry.diagError = String(error);
		}

		if (extra) {
			for (const key of Object.keys(extra)) entry[ key ] = extra[ key ];
		}
		return entry;
	}

	private diagChain: Promise<void> = Promise.resolve();

	/**
	 * Append one diagnostic entry.
	 *
	 * Serialised through a promise chain: several of these fire within milliseconds of each
	 * other during a quit, and the read-modify-write in appendDiagnostic() would otherwise
	 * let the runs clobber each other's entries.
	 */
	private writeDiagnostic(phase: string, extra?: Record<string, unknown>): Promise<void> {
		const entry = this.snapshot(phase, extra);
		if (this.settings.logToConsole) this.log('diagnostic', JSON.stringify(entry));
		if (!this.settings.writeDiagnostics) return Promise.resolve();

		const run = this.diagChain.then(() => this.appendDiagnostic(entry));
		this.diagChain = run.catch(() => undefined);
		return run;
	}

	private async appendDiagnostic(entry: DiagnosticEntry): Promise<void> {
		try {
			const path = this.settings.diagPath;
			const raw = await this.app.vault.adapter.read(path).catch(() => '');
			let entries: DiagnosticEntry[] = [];
			try {
				const parsed: unknown = JSON.parse(raw);
				if (Array.isArray(parsed)) entries = parsed as DiagnosticEntry[];
			} catch (error) {
				// A corrupt log is not worth failing over; start it again.
				this.log('diagnostics file was unreadable; starting a new log:', error);
			}
			entries.push(entry);
			if (entries.length > DIAG_LIMIT) entries = entries.slice(entries.length - DIAG_LIMIT);
			const payload = JSON.stringify(entries, null, 1);

			// Vault.process() for an existing file so a concurrent write cannot clobber it.
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.app.vault.process(existing, () => payload);
			} else {
				await this.app.vault.adapter.write(path, payload);
			}
		} catch (error) {
			this.error('diagnostic write failed:', error);
		}
	}

	// ── Logging ────────────────────────────────────────────────────────────────

	private log(...args: unknown[]): void {
		if (this.settings?.logToConsole) console.log('[close-reflect]', ...args);
	}

	private warn(...args: unknown[]): void {
		if (this.settings?.logToConsole) console.warn('[close-reflect]', ...args);
	}

	/** Errors bypass the switch and are never swallowed. */
	private error(...args: unknown[]): void {
		console.error('[close-reflect]', ...args);
	}
}
