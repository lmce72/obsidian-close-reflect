import { App, ButtonComponent, Component, Modal, Setting } from 'obsidian';
import { ButtonListEditor } from './button-list-editor';
import { createMarkdownEditor } from './markdown-editor';
import { renderReflection } from './render';
import type { MarkdownEditorHandle } from './markdown-editor';
import type CloseReflectPlugin from './plugin';
import type { ReflectButton } from './types';

/** How long to wait after the last edit before re-rendering the preview. */
const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The single editing surface for the reflection.
 *
 * Plain `Modal`, unlike the quit overlay: this one is opened from the settings tab, so there
 * is no opaque quit screen to out-layer. Every future editing entry point should open this
 * modal rather than adding a second editing style.
 *
 * Everything is edited on a draft copy, so Cancel really discards — nothing touches
 * `plugin.settings` until Save, and the linked note is only written when its body actually
 * changed.
 */
export class ContentEditModal extends Modal {
	private readonly plugin: CloseReflectPlugin;
	private readonly onSaved: () => void;

	private readonly draft: {
		title: string;
		content: string;
		buttons: ReflectButton[];
	};

	/**
	 * The linked note's body as it was loaded into the editor.
	 *
	 * Null when the note could not be read at all, which also means there is nothing to write
	 * back to. Used to save only when the user actually changed something.
	 */
	private linkedBodyAtLoad: string | null = null;

	private editor: MarkdownEditorHandle | null = null;
	private previewComponent: Component | null = null;
	private previewTimer: number | null = null;
	private previewHostEl: HTMLElement | null = null;

	constructor( app: App, plugin: CloseReflectPlugin, onSaved: () => void ) {
		super( app );
		this.plugin = plugin;
		this.onSaved = onSaved;

		const settings = plugin.settings;
		this.draft = {
			title: settings.title,
			content: settings.content,
			buttons: settings.buttons.map( ( button ) => ( { ...button } ) )
		};
	}

	onOpen(): void {
		this.setTitle( 'Edit the reflection' );
		this.modalEl.addClass( 'close-reflect-edit-modal' );

		const grid = this.contentEl.createDiv( { cls: 'close-reflect-edit-grid' } );
		const left = grid.createDiv( { cls: 'close-reflect-edit-left' } );
		const right = grid.createDiv( { cls: 'close-reflect-edit-right' } );

		this.renderTitleField( left );
		if ( this.plugin.settings.source === 'linked' ) this.renderLinkedRow( left );
		this.renderEditorArea( left );
		this.renderButtonList( left );

		new Setting( right ).setName( 'Preview' ).setHeading();
		this.previewHostEl = right.createDiv( { cls: 'close-reflect-preview' } );

		const footer = this.contentEl.createDiv( { cls: 'modal-button-container' } );
		new ButtonComponent( footer )
			.setButtonText( 'Cancel' )
			.onClick( () => this.close() );
		new ButtonComponent( footer )
			.setButtonText( 'Save' )
			.setCta()
			.onClick( () => { void this.save(); } );

		if ( this.plugin.settings.source === 'linked' ) {
			void this.loadLinkedBody();
		} else {
			this.schedulePreview();
		}
	}

	onClose(): void {
		this.teardownPreview();
		this.editor?.destroy();
		this.editor = null;
		this.contentEl.empty();
	}

	// ── Sections ─────────────────────────────────────────────────────────────

	private renderTitleField( host: HTMLElement ): void {
		new Setting( host )
			.setName( 'Title' )
			.setDesc( 'Shown in the overlay title bar.' )
			.addText( ( text ) => text
				.setValue( this.draft.title )
				.onChange( ( value ) => {
					this.draft.title = value;
					this.schedulePreview();
				} ) );
	}

	/**
	 * Linked mode edits the note itself, so the body below is the note's body and Save writes
	 * it back. The path is still chosen on the settings page.
	 */
	private renderLinkedRow( host: HTMLElement ): void {
		const path = this.plugin.settings.linkedPath.trim();

		new Setting( host )
			.setName( 'Linked note' )
			.setDesc( path === ''
				? 'No note chosen yet — pick one on the settings page under Content. Nothing will be saved back.'
				: path )
			.addButton( ( button ) => button
				.setButtonText( 'Open the note' )
				.setDisabled( path === '' )
				.onClick( () => { void this.app.workspace.openLinkText( path, '', false ); } ) )
			.addButton( ( button ) => button
				.setButtonText( 'Reload from the note' )
				.setDisabled( path === '' )
				.onClick( () => { void this.loadLinkedBody(); } ) );
	}

	private renderEditorArea( host: HTMLElement ): void {
		new Setting( host ).setName( 'Text' ).setHeading();

		const editorHost = host.createDiv( { cls: 'close-reflect-editor-host' } );
		this.editor = createMarkdownEditor( this.app, editorHost, {
			value: this.draft.content,
			file: this.app.workspace.getActiveFile(),
			placeholder: 'Overlay text…',
			onChange: ( value ) => {
				this.draft.content = value;
				this.schedulePreview();
			}
		} );

		if ( this.editor ) return;

		// The embedded editor is unavailable (see markdown-editor.ts). Fall back to the plain
		// textarea the settings page used to hold, so the content stays editable either way.
		console.warn( '[close-reflect] falling back to a textarea for the overlay text' );
		const area = editorHost.createEl( 'textarea', { cls: 'close-reflect-setting-textarea' } );
		area.value = this.draft.content;
		area.addEventListener( 'input', () => {
			this.draft.content = area.value;
			this.schedulePreview();
		} );
	}

	private renderButtonList( host: HTMLElement ): void {
		new Setting( host ).setName( 'Buttons' ).setHeading();

		const listEditor = new ButtonListEditor(
			this.app,
			host,
			this.draft.buttons,
			() => this.schedulePreview()
		);
		listEditor.render();
	}

	// ── Linked note ──────────────────────────────────────────────────────────

	/**
	 * Pull the note's current body into the editor.
	 *
	 * The load is recorded so Save can tell an edited body from an untouched one — "write back
	 * only when it actually changed". A note that cannot be read leaves that record null, and
	 * Save then refuses to write rather than creating one.
	 */
	private async loadLinkedBody(): Promise<void> {
		const body = await this.plugin.readLinkedBody();
		this.linkedBodyAtLoad = body;

		if ( body === null ) {
			console.warn( '[close-reflect] the linked note could not be read; saving will not write anything' );
			return;
		}

		this.draft.content = body;
		// setValue does not fire the editor's onChange, so the draft is updated by hand here.
		this.editor?.setValue( body );
		if ( !this.editor ) {
			const area = this.contentEl.querySelector<HTMLTextAreaElement>( '.close-reflect-setting-textarea' );
			if ( area ) area.value = body;
		}
		this.schedulePreview();
	}

	// ── Preview ──────────────────────────────────────────────────────────────

	private schedulePreview(): void {
		if ( this.previewTimer !== null ) window.clearTimeout( this.previewTimer );
		this.previewTimer = window.setTimeout( () => {
			this.previewTimer = null;
			this.refreshPreview();
		}, PREVIEW_DEBOUNCE_MS );
	}

	/**
	 * Re-render the preview into its own host element, so editing a field never rebuilds —
	 * and therefore never steals focus from — the editor beside it.
	 */
	private refreshPreview(): void {
		const host = this.previewHostEl;
		if ( !host || !host.isConnected ) return;

		host.empty();
		this.previewComponent?.unload();

		const component = new Component();
		component.load();
		this.previewComponent = component;

		try {
			renderReflection(
				this.app,
				host,
				component,
				{
					title: this.draft.title,
					content: this.draft.content,
					buttons: this.draft.buttons
				},
				{
					interactive: false,
					// The buttons stay inert — they would drive the quit — but embeds are
					// navigation, so they stay clickable for checking what a note points at.
					onOpenEmbed: ( linktext ) => {
						void this.app.workspace.openLinkText( linktext, '', false );
					}
				}
			);
		} catch ( error ) {
			console.error( '[close-reflect] preview render failed:', error );
		}
	}

	private teardownPreview(): void {
		if ( this.previewTimer !== null ) {
			window.clearTimeout( this.previewTimer );
			this.previewTimer = null;
		}
		this.previewComponent?.unload();
		this.previewComponent = null;
		this.previewHostEl = null;
	}

	// ── Saving ───────────────────────────────────────────────────────────────

	private async save(): Promise<void> {
		const settings = this.plugin.settings;
		settings.title = this.draft.title;
		settings.buttons = this.draft.buttons.map( ( button ) => ( { ...button } ) );

		if ( settings.source === 'inline' ) {
			settings.content = this.draft.content;
		}

		try {
			await this.plugin.saveSettings();
		} catch ( error ) {
			console.error( '[close-reflect] saving the reflection failed:', error );
		}

		// Only when the body actually changed, and only when the note was readable to begin
		// with — otherwise this would write a stale or empty body over the note.
		if ( settings.source === 'linked' ) {
			await this.saveLinkedBody();
		}

		this.close();
		this.onSaved();
	}

	private async saveLinkedBody(): Promise<void> {
		if ( this.linkedBodyAtLoad === null ) {
			console.warn( '[close-reflect] not writing the linked note: it was never read' );
			return;
		}
		if ( this.draft.content === this.linkedBodyAtLoad ) return;

		try {
			await this.plugin.writeLinkedBody( this.draft.content, this.linkedBodyAtLoad );
			this.linkedBodyAtLoad = this.draft.content;
		} catch ( error ) {
			console.error( '[close-reflect] could not write the linked note:', error );
		}
	}
}
