import { App, Component, MarkdownRenderer } from 'obsidian';
import type { ReflectButton } from './types';

export interface ReflectionContent {
	title: string;
	/** Markdown source for the body. */
	content: string;
	/** Buttons to place in the action row, in order. */
	buttons: ReflectButton[];
}

export interface ReflectionRenderOptions {
	/**
	 * Wire the buttons up when true. When false they render inert, which is what the
	 * preview inside the edit modal wants.
	 */
	interactive: boolean;
	onChoose?(button: ReflectButton): void;
	/**
	 * Called with a linktext when something in the body that points somewhere is clicked: a
	 * wikilink, or the body of an embed.
	 *
	 * Omit to leave both of them inert — which is what a caller that only wants to show
	 * something should do.
	 */
	onOpenLink?(linktext: string): void;
}

/**
 * What counts as interactive content in the rendered body.
 *
 * Structural on purpose, not a list of plugin class names: a wikilink is an `a` with
 * `.internal-link`, an external link is an `a`, a Meta Bind control is a real `button`, a
 * task checkbox is an `input`. Anything that renders its own control lands in here without
 * this plugin having to know about it.
 */
export const INTERACTIVE_CONTENT_SELECTOR = [
	'a',
	'button',
	'input',
	'select',
	'textarea',
	'[data-href]',
	'[contenteditable="true"]',
	'[role="button"]',
	'.internal-link',
	'.external-link',
	'.internal-embed',
	'.markdown-embed'
].join( ', ' );

/**
 * Wire the body's own navigation.
 *
 * Two cases, both of which fail if left to Obsidian:
 *
 * - **Wikilinks.** Obsidian's global click handling expects the link to sit inside a view it
 *   can take a source path from. This body is rendered into a bare container, so there is no
 *   such context, and whether the click navigates is not dependable.
 * - **Embeds.** Obsidian renders one as `<span class="internal-embed" src="<linktext>">`
 *   with the note's content inside it, and never handles navigation for the body at all.
 *
 * So both are opened here, through the same callback. A click that lands on something already
 * interactive *inside* an embed is left alone — those belong to the embedded content, not to
 * the embed — and a click with a modifier is left to Obsidian, which is what gives
 * Ctrl/Cmd-click its open-in-a-new-pane behaviour. Making the whole embed clickable does mean
 * a click after selecting text inside it also navigates.
 */
function installLinkNavigation( host: HTMLElement, open: ( linktext: string ) => void ): void {
	host.addEventListener( 'click', ( event ) => {
		const target = event.target as HTMLElement | null;
		if ( !target || typeof target.closest !== 'function' ) return;

		// Modified clicks stay with Obsidian.
		if ( event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ) return;

		const link = target.closest( 'a.internal-link, a[data-href], .internal-link[data-href]' );
		if ( link ) {
			const linktext = link.getAttribute( 'data-href' );
			if ( !linktext ) return;
			event.preventDefault();
			event.stopPropagation();
			open( linktext );
			return;
		}

		const embed = target.closest( '.internal-embed' );
		if ( !embed ) return;

		const ownHandler = 'a, img, button, input, textarea, select, [data-href], ' +
			'.internal-link, .external-link, .markdown-embed-link';
		if ( target.closest( ownHandler ) ) return;

		const linktext = embed.getAttribute( 'src' );
		if ( !linktext ) return;

		event.preventDefault();
		event.stopPropagation();
		open( linktext );
	}, true );
}

/**
 * Build the reflection panel — title, Markdown body, two buttons — inside `host`.
 *
 * Shared by the real overlay and the settings preview so the two can never drift apart.
 * The body goes through MarkdownRenderer, so wikilinks, bold, lists, callouts and inline
 * code all render as they would in a note.
 *
 * @returns the panel element
 */
export function renderReflection(
	app: App,
	host: HTMLElement,
	component: Component,
	data: ReflectionContent,
	options: ReflectionRenderOptions
): HTMLElement {
	const panel = host.createDiv( { cls: 'close-reflect-panel' } );

	panel.createDiv( { cls: 'close-reflect-title', text: data.title } );

	const body = panel.createDiv( { cls: 'close-reflect-body' } );
	MarkdownRenderer
		.render( app, data.content, body, '', component )
		.catch( ( error: unknown ) => {
			console.error( '[close-reflect] markdown render failed:', error );
		} );

	// Wired before the render resolves, since the handler delegates from the body.
	if ( options.onOpenLink ) installLinkNavigation( body, options.onOpenLink );

	// The accented button is the intended answer, so it is the one that keeps the user in
	// the app: the first button that cancels the quit, or the first button when the row has
	// no such button. Letting the app close is always an explicit click on its own button.
	const row = panel.createDiv( { cls: 'modal-button-container' } );
	const accentIndex = data.buttons.findIndex( ( button ) => button.action === 'stay' );

	for ( let i = 0; i < data.buttons.length; i++ ) {
		const button = data.buttons[ i ];
		const el = row.createEl( 'button', {
			text: button.label,
			cls: i === ( accentIndex >= 0 ? accentIndex : 0 ) ? 'mod-cta' : ''
		} );
		if ( options.interactive ) {
			el.addEventListener( 'click', () => options.onChoose?.( button ) );
		} else {
			el.disabled = true;
		}
	}

	return panel;
}
