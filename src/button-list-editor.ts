import { App, ButtonComponent, DropdownComponent, ExtraButtonComponent, TextComponent } from 'obsidian';
import { NoteSuggest } from './file-suggest';
import { BUTTON_ACTION_KINDS, BUTTON_ACTION_LABELS, createButtonId } from './types';
import type { ButtonActionKind, ReflectButton } from './types';

/**
 * Edits the overlay's button list in place.
 *
 * render() rebuilds only the list element it owns, never the surrounding modal: the modal's
 * left column holds a CodeMirror editor, and rebuilding the whole thing would take its focus
 * and content with it. That is also why changing a button's action rebuilds the list rather
 * than the modal.
 */
export class ButtonListEditor {
	private readonly app: App;
	private readonly buttons: ReflectButton[];
	private readonly onChange: () => void;
	private readonly listEl: HTMLElement;

	constructor( app: App, hostEl: HTMLElement, buttons: ReflectButton[], onChange: () => void ) {
		this.app = app;
		this.buttons = buttons;
		this.onChange = onChange;
		this.listEl = hostEl.createDiv( { cls: 'close-reflect-button-list' } );
	}

	render(): void {
		this.listEl.empty();

		for ( let index = 0; index < this.buttons.length; index++ ) {
			this.renderRow( index );
		}

		new ButtonComponent( this.listEl )
			.setButtonText( 'Add button' )
			.onClick( () => {
				this.buttons.push( { id: createButtonId(), label: 'New button', action: 'stay', target: '' } );
				this.render();
				this.onChange();
			} );
	}

	private renderRow( index: number ): void {
		const button = this.buttons[ index ];
		const row = this.listEl.createDiv( { cls: 'close-reflect-button-row' } );

		new TextComponent( row )
			.setPlaceholder( 'Label' )
			.setValue( button.label )
			.onChange( ( value ) => {
				button.label = value;
				this.onChange();
			} );

		const actionOptions: Record<string, string> = {};
		for ( const kind of BUTTON_ACTION_KINDS ) actionOptions[ kind ] = BUTTON_ACTION_LABELS[ kind ];

		new DropdownComponent( row )
			.addOptions( actionOptions )
			.setValue( button.action )
			.onChange( ( value ) => {
				button.action = value as ButtonActionKind;
				// The old target belonged to the old action; keeping it would silently point a
				// URL action at a note path.
				button.target = '';
				this.render();
				this.onChange();
			} );

		this.renderTarget( row, button );

		new ExtraButtonComponent( row )
			.setIcon( 'trash' )
			.setTooltip( 'Remove this button' )
			.onClick( () => {
				this.buttons.splice( index, 1 );
				this.render();
				this.onChange();
			} );
	}

	/** The third cell of a row: whatever input the chosen action needs, if any. */
	private renderTarget( row: HTMLElement, button: ReflectButton ): void {
		const cell = row.createDiv( { cls: 'close-reflect-button-target' } );

		switch ( button.action ) {
			case 'openNote':
				this.renderNoteTarget( cell, button );
				return;
			case 'runCommand':
				this.renderCommandTarget( cell, button );
				return;
			case 'openUrl':
				new TextComponent( cell )
					.setPlaceholder( 'https://example.com' )
					.setValue( button.target )
					.onChange( ( value ) => {
						button.target = value.trim();
						this.onChange();
					} );
				return;
			case 'stay':
			case 'leave':
				cell.createSpan( { cls: 'setting-item-description', text: 'No target needed.' } );
				return;
		}
	}

	/** A vault path, with the same note suggester the settings page uses. */
	private renderNoteTarget( cell: HTMLElement, button: ReflectButton ): void {
		const text = new TextComponent( cell )
			.setPlaceholder( 'Note path' )
			.setValue( button.target );

		text.onChange( ( value ) => {
			button.target = value.trim();
			this.onChange();
		} );

		new NoteSuggest( this.app, text.inputEl, ( file ) => {
			button.target = file.path;
			text.setValue( file.path );
			this.onChange();
		} );
	}

	/** A registered command, or a raw id field when the registry is not reachable. */
	private renderCommandTarget( cell: HTMLElement, button: ReflectButton ): void {
		const commands = this.listCommands();

		if ( !commands ) {
			console.warn( '[close-reflect] the command registry is unavailable; falling back to a raw command id' );
			new TextComponent( cell )
				.setPlaceholder( 'Command id' )
				.setValue( button.target )
				.onChange( ( value ) => {
					button.target = value.trim();
					this.onChange();
				} );
			return;
		}

		new DropdownComponent( cell )
			.addOptions( commands )
			.setValue( button.target )
			.onChange( ( value ) => {
				button.target = value;
				this.onChange();
			} );
	}

	/** Command id → display name, sorted by name. Null when the registry is not reachable. */
	private listCommands(): Record<string, string> | null {
		const registry = ( this.app as unknown as {
			commands?: { commands?: Record<string, { name?: string }> };
		} ).commands;
		const commands = registry?.commands;
		if ( !commands ) return null;

		const options: Record<string, string> = {};
		for ( const id of Object.keys( commands ).sort( ( a, b ) =>
			( commands[ a ]?.name ?? a ).localeCompare( commands[ b ]?.name ?? b )
		) ) {
			options[ id ] = commands[ id ]?.name ?? id;
		}

		return Object.keys( options ).length > 0 ? options : null;
	}
}
