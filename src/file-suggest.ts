import { AbstractInputSuggest, App, TFile } from 'obsidian';

/**
 * Note-name suggestions for a text input.
 *
 * Used by the "linked note" setting so the note is picked rather than typed; typing the
 * path by hand is how you end up with a silently broken source.
 */
export class NoteSuggest extends AbstractInputSuggest<TFile> {
	private readonly appRef: App;
	private readonly onPick: ( file: TFile ) => void;

	constructor( app: App, inputEl: HTMLInputElement, onPick: ( file: TFile ) => void ) {
		super( app, inputEl );
		this.appRef = app;
		this.onPick = onPick;
	}

	protected getSuggestions( query: string ): TFile[] {
		const needle = query.trim().toLowerCase();
		return this.appRef.vault
			.getMarkdownFiles()
			.filter( ( file ) => needle === '' || file.path.toLowerCase().includes( needle ) )
			.sort( ( a, b ) => a.path.localeCompare( b.path ) )
			.slice( 0, 30 );
	}

	renderSuggestion( file: TFile, el: HTMLElement ): void {
		el.textContent = file.path;
	}

	selectSuggestion( file: TFile ): void {
		this.setValue( file.path );
		this.onPick( file );
		this.close();
	}
}
