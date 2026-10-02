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
