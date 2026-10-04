/**
 * Shared types and defaults.
 */

/**
 * The object Obsidian hands to a `quit` listener. Handing it a promise defers the quit
 * until that promise settles, and Obsidian then calls `window.close()` again.
 *
 * Declared structurally rather than imported so the plugin does not depend on the
 * `Tasks` export being present in every API version.
 */
export interface QuitTasks {
	addPromise?(promise: Promise<unknown>): void;
	add?(callback: () => unknown): void;
}

/** What a reflection button does when it is pressed. */
export type ButtonActionKind =
	/** Cancel the quit and leave the app open. */
	| 'stay'
	/** Let the quit proceed — the only kind that closes the app. */
	| 'leave'
	/** Open a note in the vault, given its path in `target`. */
	| 'openNote'
	/** Run an Obsidian command, given its id in `target`. */
	| 'runCommand'
	/** Open an external URL, given in `target`. */
	| 'openUrl';

/** Every action kind, in the order they appear in the action dropdown. */
export const BUTTON_ACTION_KINDS: ButtonActionKind[] = [ 'stay', 'leave', 'openNote', 'runCommand', 'openUrl' ];

/**
 * Dropdown labels for the action kinds. Sentence case, per Obsidian's UI conventions.
 */
export const BUTTON_ACTION_LABELS: Record<ButtonActionKind, string> = {
	stay: 'Cancel the quit',
	leave: 'Let the app close',
	openNote: 'Open a note',
	runCommand: 'Run a command',
	openUrl: 'Open a URL'
};

/** One button on the reflection overlay. */
export interface ReflectButton {
	/** Stable across label and action edits, so diagnostics can name a button. */
	id: string;
	/** Text on the button. */
	label: string;
	action: ButtonActionKind;
	/**
	 * What the action points at: a vault-relative note path, an Obsidian command id, or a
	 * URL. Empty for `stay` and `leave`, which need no target.
	 */
	target: string;
}

/** How the overlay was dismissed. */
export type ReflectOutcome =
	/** A button was pressed. */
	| { kind: 'button'; button: ReflectButton }
	/** Dismissed without choosing (Escape, or the overlay was torn down). */
	| { kind: 'cancel' }
	/** Nobody answered before the release timeout expired. */
	| { kind: 'timeout' }
	/**
	 * The prompt could not be shown at all.
	 *
	 * Distinct from `timeout`: there is nothing on screen to answer, so the quit is always
	 * released rather than following the timeout action — otherwise a rendering failure
	 * combined with "cancel the quit" would leave an unanswerable prompt holding the app.
	 */
	| { kind: 'error' };

/** Where the overlay body comes from. */
export type ContentSource =
	/** Typed into the settings. */
	| 'inline'
	/** Rendered from a note in the vault. */
	| 'linked';

/** What an unanswered prompt does once the release timeout expires. */
export type TimeoutAction =
	/** Cancel the quit and leave the app open — the prompt still gets its chance later. */
	| 'stay'
	/** Let the quit through, so a broken or unreadable overlay can never trap the app. */
	| 'leave';

/**
 * Upper bound on the remembered copy of a linked note.
 *
 * The copy lives in the plugin's `data.json`, so an unbounded note would bloat it. Notes
 * longer than this are truncated in the remembered copy only; the live read is never
 * truncated.
 */
export const MAX_REMEMBERED_CHARS = 50000;

export interface CloseReflectSettings {
	/** Where the body comes from. */
	source: ContentSource;
	/** Body used when `source` is `'inline'`. Markdown. */
	content: string;
	/** Vault path of the note used when `source` is `'linked'`. */
	linkedPath: string;
	/**
	 * Remembered copy of the linked note's body.
	 *
	 * Kept so the overlay still has something to show when the note cannot be read — it
	 * was moved, deleted, or the vault is busy shutting down.
	 */
	linkedCache: string;
	/** When the remembered copy was last refreshed (ISO string); empty when never. */
	linkedCachedAt: string;
	/** Overlay title bar text. */
	title: string;
	/**
	 * The overlay's buttons, in display order.
	 *
	 * Never empty in practice: migrateSettings() and the plugin's getEffectiveButtons() both
	 * guarantee at least one, so the overlay always has a way out.
	 */
	buttons: ReflectButton[];
	/** How many quits to intercept before letting them through unasked. */
	intercepts: number;
	/** How long to wait for an answer before the timeout action is taken. */
	timeoutMs: number;
	/** What happens when that wait expires with no answer. */
	timeoutAction: TimeoutAction;
	/** Append per-quit diagnostics to a file inside the vault. */
	writeDiagnostics: boolean;
	/** Where those diagnostics go. */
	diagPath: string;
	/** Echo the same diagnostics to the developer console. */
	logToConsole: boolean;
	/**
	 * Mobile only: answer the hardware back button when Obsidian is about to leave the app.
	 *
	 * Only when it would actually leave — a back press with a note to go back to, or a sidebar
	 * to collapse, is navigation and is left alone.
	 */
	mobileBackButton: boolean;
	/**
	 * Mobile only: answer the "go back to the home screen" gesture.
	 *
	 * That gesture cannot be cancelled, so the prompt raised here is one to be found on the
	 * way back into the app. Off by default: switching apps briefly is not leaving.
	 */
	mobileGoingHome: boolean;
}

export const DEFAULT_SETTINGS: CloseReflectSettings = {
	source: 'inline',
	content: [
		'今天有没有看一下长期看板的进度？',
		'',
		'有没有落下待办清单的事情？',
		'',
		'有没有忘记今天打卡，记录做了什么？',
		'',
		'*检查并记录这些，更有利于后续的方向掌控！*',
		'',
		'→ [[10-看板]]'
	].join('\n'),
	linkedPath: '',
	linkedCache: '',
	linkedCachedAt: '',
	title: '退出前，先看一眼',
	buttons: [
		{ id: 'leave', label: '都做了', action: 'leave', target: '' },
		{ id: 'stay', label: '有没做的，先做', action: 'stay', target: '' }
	],
	intercepts: 2,
	timeoutMs: 30000,
	timeoutAction: 'stay',
	writeDiagnostics: true,
	diagPath: 'Components/History/closeReflectDiag.json',
	logToConsole: false,
	mobileBackButton: true,
	mobileGoingHome: false
};

/*
 * The labels the two-button version shipped with.
 *
 * Only fallbacks: a saved data.json cannot distinguish a label the user edited from one they
 * left alone, so migration copies whatever is stored and falls back to these when it is empty.
 */
const LEGACY_DEFAULT_LABEL_STAY = '有没做的，先做';
const LEGACY_DEFAULT_LABEL_LEAVE = '都做了';

let buttonIdCounter = 0;

/** A fresh button id. `crypto.randomUUID` is available in the Electron renderer. */
export function createButtonId(): string {
	try {
		if ( typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ) {
			return crypto.randomUUID();
		}
	} catch (error) {
		console.error('[close-reflect] randomUUID unavailable; falling back to a counter:', error);
	}
	buttonIdCounter += 1;
	return `btn-${Date.now().toString(36)}-${buttonIdCounter}`;
}

/** Coerce one stored entry into a button, or null when it is beyond repair. */
function normalizeButton(raw: unknown): ReflectButton | null {
	if (!raw || typeof raw !== 'object') return null;
	const stored = raw as Record<string, unknown>;
	const action = BUTTON_ACTION_KINDS.includes( stored.action as ButtonActionKind )
		? stored.action as ButtonActionKind
		: 'stay';
	return {
		id: typeof stored.id === 'string' && stored.id !== '' ? stored.id : createButtonId(),
		label: typeof stored.label === 'string' ? stored.label : '',
		action: action,
		target: typeof stored.target === 'string' ? stored.target : ''
	};
}

function legacyLabel(value: unknown, fallback: string): string {
	return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * Merge a stored settings object onto the defaults.
 *
 * The overlay used to carry exactly two buttons, stored as `labelStay` / `labelLeave`. Those
 * are carried forward into the button list verbatim, so an existing user keeps their labels.
 * Anything unusable — a missing list, a list of junk, a stored `buttons` that is not an array
 * — falls back to the two buttons the old shape described, which also guarantees the overlay
 * is never left with no way out.
 */
export function migrateSettings(raw: unknown): CloseReflectSettings {
	const stored = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
	const merged = Object.assign( {}, DEFAULT_SETTINGS, stored ) as CloseReflectSettings;

	const storedButtons = stored.buttons;
	const buttons = Array.isArray( storedButtons )
		? storedButtons.map( normalizeButton ).filter( (button): button is ReflectButton => button !== null )
		: [];

	if (buttons.length === 0) {
		buttons.push(
			{ id: 'leave', label: legacyLabel( stored.labelLeave, LEGACY_DEFAULT_LABEL_LEAVE ), action: 'leave', target: '' },
			{ id: 'stay', label: legacyLabel( stored.labelStay, LEGACY_DEFAULT_LABEL_STAY ), action: 'stay', target: '' }
		);
	}
	merged.buttons = buttons;

	merged.title = typeof merged.title === 'string' ? merged.title : DEFAULT_SETTINGS.title;
	merged.content = typeof merged.content === 'string' ? merged.content : DEFAULT_SETTINGS.content;

	// The old keys no longer exist in the interface; drop them so data.json stops carrying them.
	delete ( merged as unknown as Record<string, unknown> ).labelStay;
	delete ( merged as unknown as Record<string, unknown> ).labelLeave;

	return merged;
}
