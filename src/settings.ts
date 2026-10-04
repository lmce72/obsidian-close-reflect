import { App, Platform, PluginSettingTab, Setting } from 'obsidian';
import { ContentEditModal } from './edit-modal';
import { NoteSuggest } from './file-suggest';
import type CloseReflectPlugin from './plugin';
import type { ContentSource, TimeoutAction } from './types';

export class CloseReflectSettingTab extends PluginSettingTab {
	private readonly plugin: CloseReflectPlugin;

	constructor( app: App, plugin: CloseReflectPlugin ) {
		super( app, plugin );
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		// ── Content ────────────────────────────────────────────────────────────
		new Setting( containerEl ).setName( 'Content' ).setHeading();

		new Setting( containerEl )
			.setName( 'Content source' )
			.setDesc( 'Write the text here, or render it from a note in the vault.' )
			.addDropdown( ( dropdown ) => dropdown
				.addOption( 'inline', 'Inline text' )
				.addOption( 'linked', 'Linked note' )
				.setValue( settings.source )
				.onChange( async ( value ) => {
					settings.source = value as ContentSource;
					await save();
					this.display();
				} ) );

		// Always present, whichever source is selected: the title and the buttons live only
		// in this modal, so hiding the entry in linked mode would leave them uneditable.
		new Setting( containerEl )
			.setName( 'Title, text and buttons' )
			.setDesc( settings.source === 'linked'
				? 'Title and buttons, with a preview of the linked note.'
				: 'The overlay title, its text, and its action buttons.' )
			.addButton( ( button ) => button
				.setButtonText( 'Edit…' )
				.setCta()
				.onClick( () => {
					try {
						new ContentEditModal( this.app, this.plugin, () => this.display() ).open();
					} catch ( error ) {
						console.error( '[close-reflect] could not open the edit modal:', error );
					}
				} ) );

		if ( settings.source === 'linked' ) {
			new Setting( containerEl )
				.setName( 'Linked note' )
				.setDesc( 'The note whose contents the overlay shows. Start typing to search.' )
				.addText( ( text ) => {
					text.setValue( settings.linkedPath )
						.onChange( async ( value ) => { settings.linkedPath = value.trim(); await save(); } );
					new NoteSuggest( this.app, text.inputEl, async ( file ) => {
						settings.linkedPath = file.path;
						await save();
						await this.plugin.refreshLinkedCache();
						this.display();
					} );
				} );

			const remembered = settings.linkedCachedAt
				? `Remembered copy saved ${settings.linkedCachedAt}, ${settings.linkedCache.length} characters.`
				: 'Nothing remembered yet.';
			new Setting( containerEl )
				.setName( 'Remembered copy' )
				.setDesc( `Shown when the note cannot be read (moved, deleted, or the vault is shutting down). ${remembered}` )
				.addButton( ( button ) => button
					.setButtonText( 'Refresh now' )
					.onClick( async () => {
						await this.plugin.refreshLinkedCache();
						this.display();
					} ) );
		}

		// ── Behaviour ──────────────────────────────────────────────────────────
		new Setting( containerEl ).setName( 'Behaviour' ).setHeading();

		new Setting( containerEl )
			.setName( 'Interceptions before release' )
			.setDesc( 'How many quits to interrupt. Once spent, later quits close without asking.' )
			.addText( ( text ) => {
				text.inputEl.type = 'number';
				text.setValue( String( settings.intercepts ) )
					.onChange( async ( value ) => {
						const parsed = Number.parseInt( value, 10 );
						settings.intercepts = Number.isFinite( parsed ) && parsed > 0 ? parsed : 0;
						await save();
					} );
			} );

		new Setting( containerEl )
			.setName( 'Interception budget now' )
			.setDesc( `Quits interrupted so far this session: ${this.plugin.getInterceptCount()}.` )
			.addButton( ( button ) => button
				.setButtonText( 'Reset' )
				.onClick( () => { this.plugin.resetInterceptCount(); this.display(); } ) );

		new Setting( containerEl )
			.setName( 'Release timeout' )
			.setDesc( 'Milliseconds to wait for an answer before the timeout action below is taken.' )
			.addText( ( text ) => {
				text.inputEl.type = 'number';
				text.setValue( String( settings.timeoutMs ) )
					.onChange( async ( value ) => {
						const parsed = Number.parseInt( value, 10 );
						settings.timeoutMs = Number.isFinite( parsed ) && parsed > 0 ? parsed : 30000;
						await save();
					} );
			} );

		new Setting( containerEl )
			.setName( 'When the timeout expires' )
			.setDesc( 'What an unanswered prompt does. Cancelling keeps the app open; letting it close is the safety net that stops a broken overlay from trapping the app.' )
			.addDropdown( ( dropdown ) => dropdown
				.addOption( 'stay', 'Cancel the quit and stay open' )
				.addOption( 'leave', 'Let the app close' )
				.setValue( settings.timeoutAction )
				.onChange( async ( value ) => {
					settings.timeoutAction = value as TimeoutAction;
					await save();
				} ) );

		// ── Mobile ─────────────────────────────────────────────────────────────
		// Only on mobile: these describe gestures that platform has and the desktop does not.
		if ( Platform.isMobileApp ) {
			new Setting( containerEl ).setName( 'Mobile' ).setHeading();

			new Setting( containerEl )
				.setName( 'Ask on the back button')
				.setDesc( 'The prompt appears when the back button would leave the app. A press with somewhere to go back to is navigation and is left alone.' )
				.addToggle( ( toggle ) => toggle
					.setValue( settings.mobileBackButton )
					.onChange( async ( value ) => { settings.mobileBackButton = value; await save(); } ) );

			new Setting( containerEl )
				.setName( 'Ask on going back to the home screen' )
				.setDesc( 'The prompt appears when the app is sent to the background, and is waiting when you come back. That gesture cannot be cancelled, and switching apps briefly counts, so this is off by default.' )
				.addToggle( ( toggle ) => toggle
					.setValue( settings.mobileGoingHome )
					.onChange( async ( value ) => { settings.mobileGoingHome = value; await save(); } ) );
		}

		// ── Diagnostics ────────────────────────────────────────────────────────
		new Setting( containerEl ).setName( 'Diagnostics' ).setHeading();

		new Setting( containerEl )
			.setName( 'Write diagnostics to a file' )
			.setDesc( 'Appends one entry per quit attempt: which layers covered the overlay, and whether frames were still being produced.' )
			.addToggle( ( toggle ) => toggle
				.setValue( settings.writeDiagnostics )
				.onChange( async ( value ) => { settings.writeDiagnostics = value; await save(); } ) );

		new Setting( containerEl )
			.setName( 'Diagnostics file' )
			.setDesc( 'Vault-relative path. The last 20 entries are kept.' )
			.addText( ( text ) => text
				.setValue( settings.diagPath )
				.onChange( async ( value ) => { settings.diagPath = value.trim(); await save(); } ) );

		new Setting( containerEl )
			.setName( 'Developer log' )
			.setDesc( 'Echo the same diagnostics to the console, and write a crash-safe step-by-step trace to close-reflect-trace.log in the system temp folder. Errors are always logged regardless of this setting.' )
			.addToggle( ( toggle ) => toggle
				.setValue( settings.logToConsole )
				.onChange( async ( value ) => { settings.logToConsole = value; await save(); } ) );
	}
}
