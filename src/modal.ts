import { App, Component } from 'obsidian';
import { INTERACTIVE_CONTENT_SELECTOR, renderReflection } from './render';
import type { ReflectButton, ReflectOutcome } from './types';

/**
 * Obsidian's own quit overlay is `.progress-bar-container` — a full-viewport, opaque
 * element pinned at `z-index: 10000` in `app.css`, shown by the `in-progress` body class
 * while the app is quitting. Anything below that number is invisible during a quit.
 *
 * Obsidian's `Modal` cannot be used for this: it lives inside `.modal-container`, whose
 * z-index is `var(--layer-modal)` (50), and raising the modal's own z-index only reorders
 * it *within* that stacking context — it can never clear 10000. So the reflection UI is
 * built here as a plain element appended to `document.body`, where a z-index above 10000
 * does apply. 10001 is already spoken for by the frameless titlebar, hence 10050.
 */
export const OVERLAY_Z_INDEX = 10050;

export interface ReflectOverlayOptions {
	title: string;
	/** Markdown source for the body. */
	content: string;
	/** Buttons to show, in order. Must not be empty. */
	buttons: ReflectButton[];
	/** Called exactly once, when the overlay closes. */
	onClose(outcome: ReflectOutcome): void;
}

/**
 * A self-contained modal overlay for the reflection prompt.
 *
 * Deliberately not Obsidian's `Modal`: see OVERLAY_Z_INDEX. The markup itself comes from
 * renderReflection(), shared with the edit modal's preview.
 */
export class ReflectOverlay {
	private readonly app: App;
	private readonly options: ReflectOverlayOptions;
	private outcome: ReflectOutcome | null = null;
	private closed = false;

	/**
	 * Home for the rendered Markdown: MarkdownRenderer needs a Component to own the tree
	 * (wikilink handlers and the like), and tears it down with the overlay.
	 */
	private readonly renderHost = new Component();

	private rootEl: HTMLElement | null = null;
	private panelEl: HTMLElement | null = null;
	private keyHandler: ( ( event: KeyboardEvent ) => void ) | null = null;

	/**
	 * Cancels the quit when the body's own content is interacted with.
	 *
	 * The reflection body can hold anything the renderer produces — wikilinks, external
	 * links, embeds, Meta Bind controls, task checkboxes. Whatever it is, clicking it means
	 * the user is going somewhere rather than quitting, so the quit is always cancelled and
	 * the overlay steps aside; the click itself is left untouched so the content still does
	 * what it would have done.
	 *
	 * The teardown is deferred a tick because it removes the element the click is on, and
	 * doing that mid-dispatch can stop the click's own handler from ever running.
	 */
	private readonly contentClickHandler = ( event: MouseEvent ): void => {
		const target = event.target as HTMLElement | null;
		if ( !target || typeof target.closest !== 'function' ) return;
		if ( !target.closest( INTERACTIVE_CONTENT_SELECTOR ) ) return;

		window.setTimeout( () => {
			if ( this.closed ) return;
			this.outcome = { kind: 'cancel' };
			this.close();
		}, 0 );
	};

	constructor( app: App, options: ReflectOverlayOptions ) {
		this.app = app;
		this.options = options;
	}

	open(): void {
		const root = document.body.createDiv( { cls: 'close-reflect-overlay' } );
		// Functional constant rather than a theme value, so it is set inline.
		root.style.zIndex = String( OVERLAY_Z_INDEX );
		root.setAttribute( 'role', 'dialog' );
		root.setAttribute( 'aria-modal', 'true' );

		this.renderHost.load();
		const panel = renderReflection(
			this.app,
			root,
			this.renderHost,
			{
				title: this.options.title,
				content: this.options.content,
				buttons: this.options.buttons
			},
			{
				interactive: true,
				onChoose: ( button ) => {
					this.outcome = { kind: 'button', button: button };
					this.close();
				},
				onOpenLink: ( linktext ) => {
					void this.app.workspace.openLinkText( linktext, '', false );
				}
			}
		);

		panel.setAttribute( 'tabindex', '-1' );
		const titleEl = panel.querySelector<HTMLElement>( '.close-reflect-title' );
		if ( titleEl ) {
			titleEl.id = 'close-reflect-title';
			root.setAttribute( 'aria-labelledby', titleEl.id );
		}

		// Dismissing without pressing a button reports 'cancel', which the plugin treats the
		// same as "stay": better to keep the user in the app than to close it for them.
		this.keyHandler = ( event: KeyboardEvent ) => {
			if ( event.key === 'Escape' ) {
				event.preventDefault();
				event.stopPropagation();
				this.outcome = { kind: 'cancel' };
				this.close();
			}
		};
		document.addEventListener( 'keydown', this.keyHandler, true );

		panel.addEventListener( 'click', this.contentClickHandler, true );

		this.rootEl = root;
		this.panelEl = panel;
		panel.focus();
	}

	close(): void {
		if ( this.closed ) return;
		this.closed = true;

		if ( this.keyHandler ) {
			document.removeEventListener( 'keydown', this.keyHandler, true );
			this.keyHandler = null;
		}
		this.panelEl?.removeEventListener( 'click', this.contentClickHandler, true );
		this.renderHost.unload();
		this.rootEl?.remove();
		this.rootEl = null;
		this.panelEl = null;

		this.options.onClose( this.outcome ?? { kind: 'cancel' } );
	}

	/** The overlay root, for diagnostics. Null once closed. */
	get element(): HTMLElement | null {
		return this.rootEl;
	}
}
