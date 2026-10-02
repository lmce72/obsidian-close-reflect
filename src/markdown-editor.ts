/*
 * A real Obsidian Markdown editor that can be mounted into any container.
 *
 * -----------------------------------------------------------------------------
 * PORTED CODE — MIT LICENSE, ATTRIBUTION REQUIRED
 *   EmbeddableMarkdownEditor by Fevol
 *     https://gist.github.com/Fevol/caa478ce303e69eabede7b12b2323838
 *   Prototype-extraction technique originally from mgmeyers/obsidian-kanban.
 *   Copyright 2024 Matthew Meyers, Fevol — MIT License.
 *
 *   Only the MIT-blessed editor-construction code was carried over. obsidian-kanban
 *   itself is GPLv3 — do not lift anything else from it.
 * -----------------------------------------------------------------------------
 *
 * How it works: ask `app.embedRegistry` for a throwaway markdown embed, force it to build
 * its editor, then walk two levels up the prototype chain to reach Obsidian's internal
 * editor base class and subclass it.
 *
 * Everything here depends on Obsidian internals (embedRegistry, the editor base class, the
 * owner object), so every entry point fails soft: createMarkdownEditor() returns null and
 * the caller falls back to a plain textarea. The plugin must keep working without this.
 *
 * CodeMirror is deliberately NOT bundled. Obsidian registers `@codemirror/state` and
 * `@codemirror/view` in the module table it exposes to plugins, so `require` here resolves
 * to Obsidian's own copies — which is what makes the `editorInfoField` and
 * `editorLivePreviewField` lookups below work. A second bundled copy would break their
 * instanceof checks with the well-known "multiple instances of @codemirror/state" error.
 */

import type { App, TFile } from 'obsidian';

/** Everything the caller can rely on. The internals stay untyped on purpose. */
export interface MarkdownEditorOptions {
	value?: string;
	/** File that wikilink and tag completions resolve against. */
	file?: TFile | null;
	placeholder?: string;
	/** Called for real edits only — a programmatic setValue() does not fire it. */
	onChange?( value: string ): void;
}

export interface MarkdownEditorHandle {
	getValue(): string;
	setValue( value: string ): void;
	focus(): void;
	destroy(): void;
}

/** The plugin's own module loader. Obsidian exposes `require` to plugins on desktop. */
const requireFn = ( window as unknown as { require?: ( id: string ) => unknown } ).require
	?? ( typeof require === 'function' ? require as ( id: string ) => unknown : null );

function loadModule( id: string ): any {
	if (!requireFn) return null;
	try {
		return requireFn( id );
	} catch (error) {
		console.error( `[close-reflect] cannot load ${id}:`, error );
		return null;
	}
}

const obsidian = loadModule( 'obsidian' );
const CmState = loadModule( '@codemirror/state' );
const CmView = loadModule( '@codemirror/view' );

/**
 * Whether the embedded editor can be built at all.
 *
 * False when the module table has no CodeMirror entry — a future Obsidian could drop them,
 * and the caller must fall back to a textarea rather than crash.
 */
export function isMarkdownEditorAvailable(): boolean {
	return !!( obsidian && CmState && CmState.EditorSelection && CmView && CmView.EditorView );
}

if (!isMarkdownEditorAvailable()) {
	console.warn( '[close-reflect] the embedded Markdown editor is unavailable; the edit modal will use a textarea' );
}

// ── Resolving Obsidian's internal editor base class ──────────────────────────

let baseClassCache: any = null;

/**
 * Build a throwaway markdown embed, force it to initialise its editor, and read the base
 * class off the prototype chain: instance → concrete editMode prototype → base prototype.
 */
function resolveEditorPrototype( app: App ): any {
	if (baseClassCache) return baseClassCache;

	const registry = ( app as unknown as { embedRegistry?: any } ).embedRegistry;
	if (!registry || !registry.embedByExtension) {
		throw new Error( 'app.embedRegistry is unavailable (an Obsidian internal that may have changed)' );
	}

	// The embed needs a TFile for context; prefer a real one.
	let file: TFile | null = null;
	try { file = app.workspace.getActiveFile(); } catch (error) { file = null; }
	if (!file || file.extension !== 'md') {
		try { file = app.vault.getMarkdownFiles()[0] ?? null; } catch (error) { file = null; }
	}
	if (!file) {
		// Nothing to borrow — a TFile that is never written to disk.
		file = new obsidian.TFile( app.vault, '__close_reflect_probe__.md' );
	}

	const host = document.createElement( 'div' );
	let embed: any = null;
	try {
		embed = registry.embedByExtension.md( { app: app, containerEl: host }, file, '' );
		embed.editable = true;
		embed.showEditor();

		const editMode = embed.editMode;
		if (!editMode) throw new Error( 'the probe editor never initialised its editMode' );

		const Base = Object.getPrototypeOf( Object.getPrototypeOf( editMode ) ).constructor;
		if (typeof Base !== 'function') throw new Error( 'the prototype walk did not reach a constructor' );

		baseClassCache = Base;
		return Base;
	} finally {
		// The upstream gist only calls unload(), which does not tear down the CodeMirror
		// instance and extensions the probe just built — one leaked editor per construction.
		// The editMode has to be destroyed first.
		try { if (embed && embed.editMode) embed.editMode.destroy(); }
		catch (error) { console.warn( '[close-reflect] could not destroy the probe editMode:', error ); }
		try { if (embed) embed.unload(); }
		catch (error) { console.warn( '[close-reflect] could not unload the probe embed:', error ); }
		try { host.remove(); } catch (error) { /* already gone */ }
	}
}

// ── setActiveLeaf patch (module-level, reference counted) ────────────────────
/*
 * Keeping the embedded editor focused. Without this, opening or activating a leaf steals
 * focus mid-typing and kills the completion popover. Upstream patches once per instance and
 * never uninstalls; with several editors that stacks patches and leaks uninstallers, so this
 * is a ref-counted singleton.
 */
let patchRefCount = 0;
let originalSetActiveLeaf: any = null;
let patchedSetActiveLeaf: any = null;
const liveEditors: any[] = [];

function anyEmbeddedEditorFocused(): boolean {
	for (const editor of liveEditors) {
		try {
			if (editor.editor?.cm?.hasFocus) return true;
			if (editor.activeCM?.hasFocus) return true;
		} catch (error) {
			// One bad instance must not break the check for the others.
		}
	}
	return false;
}

function installActiveLeafPatch( app: App ): void {
	patchRefCount++;
	if (patchRefCount > 1) return;
	try {
		const workspace = app.workspace as any;
		originalSetActiveLeaf = workspace.setActiveLeaf;
		patchedSetActiveLeaf = function ( this: unknown, ...args: unknown[] ) {
			if (anyEmbeddedEditorFocused()) return;
			return originalSetActiveLeaf.apply( this, args );
		};
		workspace.setActiveLeaf = patchedSetActiveLeaf;
	} catch (error) {
		console.error( '[close-reflect] could not install the setActiveLeaf patch:', error );
	}
}

function uninstallActiveLeafPatch( app: App ): void {
	patchRefCount = Math.max( 0, patchRefCount - 1 );
	if (patchRefCount > 0) return;
	try {
		const workspace = app.workspace as any;
		// Only restore our own patch, so a patch installed after ours is not clobbered.
		if (originalSetActiveLeaf && workspace.setActiveLeaf === patchedSetActiveLeaf) {
			workspace.setActiveLeaf = originalSetActiveLeaf;
		}
	} catch (error) {
		console.error( '[close-reflect] could not restore the setActiveLeaf patch:', error );
	}
	originalSetActiveLeaf = null;
	patchedSetActiveLeaf = null;
}

// ── Editor adapter ───────────────────────────────────────────────────────────
/*
 * Shapes the raw CodeMirror view as Obsidian's `Editor`, so completions and commands can
 * read the cursor and insert text through it.
 */
class EditorAdapter {
	view: any;

	constructor( view: any ) {
		this.view = view;
	}

	getDoc() { return this; }
	getValue() { return this.view.state.doc.toString(); }

	setValue( value: string ) {
		const doc = this.view.state.doc;
		this.view.dispatch( { changes: { from: 0, to: doc.length, insert: value } } );
	}

	getLine( line: number ) { return this.view.state.doc.line( line + 1 ).text; }
	lineCount() { return this.view.state.doc.lines; }
	lastLine() { return this.lineCount() - 1; }
	getSelection() {
		const selection = this.view.state.selection.main;
		return this.view.state.doc.sliceString( selection.from, selection.to );
	}
	somethingSelected() { return !this.view.state.selection.main.empty; }

	getRange( from: any, to: any ) {
		return this.view.state.doc.sliceString( this.posToOffset( from ), this.posToOffset( to ) );
	}

	replaceSelection( text: string ) {
		const transaction = this.view.state.changeByRange( ( range: any ) => ( {
			changes: { from: range.from, to: range.to, insert: text },
			range: CmState.EditorSelection.cursor( range.from + text.length )
		} ) );
		this.view.dispatch( transaction );
	}

	replaceRange( text: string, from: any, to: any ) {
		this.view.dispatch( {
			changes: { from: this.posToOffset( from ), to: this.posToOffset( to ?? from ), insert: text }
		} );
	}

	getCursor( which?: string ) {
		const selection = this.view.state.selection.main;
		switch (which) {
			case 'from': return this.offsetToPos( selection.from );
			case 'to': return this.offsetToPos( selection.to );
			case 'anchor': return this.offsetToPos( selection.anchor );
			default: return this.offsetToPos( selection.head );
		}
	}

	listSelections() {
		const self = this;
		return this.view.state.selection.ranges.map( ( range: any ) => ( {
			anchor: self.offsetToPos( range.anchor ),
			head: self.offsetToPos( range.head )
		} ) );
	}

	setCursor( line: any, ch?: number ) {
		if (typeof line === 'number') {
			this.setSelection( { line: line, ch: ch ?? 0 } );
			return;
		}
		this.setSelection( line );
	}

	setSelection( from: any, to?: any ) {
		this.view.dispatch( {
			selection: CmState.EditorSelection.range( this.posToOffset( from ), this.posToOffset( to ?? from ) )
		} );
	}

	setSelections( ranges: any[], main?: number ) {
		if (ranges.length === 0) return;
		const self = this;
		this.view.dispatch( {
			selection: CmState.EditorSelection.create( ranges.map( ( range ) => CmState.EditorSelection.range(
				self.posToOffset( range.anchor ),
				self.posToOffset( range.head ?? range.anchor )
			) ), main || 0 )
		} );
	}

	focus() { this.view.focus(); }
	blur() { this.view.contentDOM.blur(); }
	hasFocus() { return this.view.hasFocus; }

	transaction( transactionData: any ) {
		if (transactionData.replaceSelection !== undefined) {
			this.replaceSelection( transactionData.replaceSelection );
			return;
		}
		const self = this;
		const changes = transactionData.changes == null ? undefined : transactionData.changes.map( ( change: any ) => ( {
			from: self.posToOffset( change.from ),
			to: self.posToOffset( change.to ?? change.from ),
			insert: change.text
		} ) );
		const selections = transactionData.selections != null
			? transactionData.selections
			: ( transactionData.selection ? [ transactionData.selection ] : undefined );

		const spec: any = {};
		if (changes) spec.changes = changes;
		if (selections && selections.length > 0) {
			spec.selection = CmState.EditorSelection.create( selections.map( ( selection: any ) => CmState.EditorSelection.range(
				self.posToOffset( selection.from ),
				self.posToOffset( selection.to ?? selection.from )
			) ) );
		}
		this.view.dispatch( spec );
	}

	// Lines are 0-indexed here, matching the legacy Obsidian Editor convention.
	posToOffset( position: any ) {
		const doc = this.view.state.doc;
		const lineNumber = Math.max( 1, Math.min( position.line + 1, doc.lines ) );
		const line = doc.line( lineNumber );
		return Math.max( line.from, Math.min( line.from + position.ch, line.to ) );
	}

	offsetToPos( offset: number ) {
		const doc = this.view.state.doc;
		const clamped = Math.max( 0, Math.min( offset, doc.length ) );
		const line = doc.lineAt( clamped );
		return { line: line.number - 1, ch: clamped - line.from };
	}
}

// ── The editor class ─────────────────────────────────────────────────────────

const EDITOR_DEFAULTS = {
	value: '',
	file: undefined as TFile | null | undefined,
	placeholder: '',
	onChange: ( _value: string ) => { /* replaced by the caller's option */ }
};

let editorClass: any = null;

function makeEditorClass( BaseClass: any ): any {
	return class EmbeddableMarkdownEditor extends BaseClass {
		/*
		 * `declare` matters here: with the ES2022 target, TypeScript's class fields are
		 * defined on the instance, so a plain `owner: any;` would emit `owner;` and overwrite
		 * the value the base class constructor just set — leaving `this.owner` undefined and
		 * failing on the very first assignment below. `declare` emits nothing.
		 */
		declare app: App;
		declare options: any;
		declare scope: any;
		declare activeEditorOwner: any;
		declare editor: any;
		declare editorEl: any;
		declare containerEl: any;
		declare owner: any;

		private destroyedFlag = false;
		private onFocusIn: () => void;
		private onBlurHandler: () => void;

		constructor( app: App, containerEl: HTMLElement, options: MarkdownEditorOptions ) {
			// `getMode` picks the "source" family, and live preview lives in that family:
			// measured on Obsidian 1.13.7 it renders live preview by default, with no extra
			// Compartment wiring. Do not add the recipes circulating online.
			super( app, containerEl, {
				app: app,
				onMarkdownScroll: () => { /* the host scrolls, not the editor */ },
				getMode: () => 'source'
			} );

			// The base class is expected to have created these. If it did not, Obsidian's
			// internals have changed shape and the caller must fall back — bail out before
			// touching anything, so the failure surfaces here rather than three lines later.
			if ( !this.owner || !this.editor || !this.editor.cm ) {
				throw new Error( 'the editor base class did not provide owner/editor (Obsidian internals changed)' );
			}

			this.app = app;
			this.options = Object.assign( {}, EDITOR_DEFAULTS, options );

			// A child scope so global hotkeys do not steal keys while the editor has focus.
			this.scope = new obsidian.Scope( app.scope );
			this.scope.register( [ 'Mod' ], 'Enter', () => true );
			this.scope.register( [ 'Mod', 'Shift' ], 'Enter', () => true );

			// Commands and completions expect a view-shaped owner.
			this.owner.editMode = this;
			this.owner.editor = this.editor;

			// The owner object *is* the editorInfoField value. Without a file on it the
			// wikilink and tag suggesters have no resolution base and never open. Do not
			// re-initialise that field — it throws "Field is already present"; mutate the
			// owner instead.
			this.owner.file = this.getActiveEditorFile();
			this.owner.app = app;

			this.activeEditorOwner = {
				editMode: this,
				editor: new EditorAdapter( this.editor.cm ),
				file: this.getActiveEditorFile(),
				getMode: () => 'source'
			};

			// From Obsidian 1.5.8 on the value must be set explicitly or the editor is blank.
			this.set( this.options.value || '' );

			liveEditors.push( this );
			installActiveLeafPatch( app );

			this.onFocusIn = () => {
				try {
					this.app.keymap.pushScope( this.scope );
					// This is what the suggester reads; without it `[[` and `#` show nothing.
					this.activeEditorOwner.file = this.getActiveEditorFile();
					this.app.workspace.activeEditor = this.activeEditorOwner;
				} catch (error) {
					console.error( '[close-reflect] editor focus handler failed:', error );
				}
			};
			this.onBlurHandler = () => {
				try { this.app.keymap.popScope( this.scope ); }
				catch (error) { console.error( '[close-reflect] editor blur handler failed:', error ); }
			};
			this.editor.cm.contentDOM.addEventListener( 'focusin', this.onFocusIn );
			this.editor.cm.contentDOM.addEventListener( 'blur', this.onBlurHandler );
		}

		get value() { return this.editor.cm.state.doc.toString(); }
		setValue( value: string ) { this.set( value ); }

		getActiveEditorFile(): TFile | null {
			if (this.options.file !== undefined) return this.options.file ?? null;
			try { return this.app.workspace.getActiveFile(); } catch (error) { return null; }
		}

		/** Point completions at a different note. */
		setFile( file: TFile | null ) {
			this.options.file = file;
			if (this.activeEditorOwner) this.activeEditorOwner.file = file;
			if (this.owner) this.owner.file = file;
		}

		buildLocalExtensions(): any[] {
			const extensions = super.buildLocalExtensions();
			// Reparent tooltips to the body: inside the modal they would be clipped by overflow.
			try {
				extensions.push( CmView.tooltips( { parent: document.body } ) );
			} catch (error) {
				console.warn( '[close-reflect] could not inject the tooltips extension:', error );
			}
			if (this.options.placeholder) extensions.push( CmView.placeholder( this.options.placeholder ) );
			return extensions;
		}

		onUpdate( update: any, changed: any ) {
			super.onUpdate( update, changed );
			if (changed) {
				try { this.options.onChange( this.value ); }
				catch (error) { console.error( '[close-reflect] editor onChange threw:', error ); }
			}
		}

		destroy() {
			try {
				if (this.destroyedFlag) return;
				this.destroyedFlag = true;

				try { this.editor.cm.contentDOM.removeEventListener( 'focusin', this.onFocusIn ); } catch (error) { /* gone */ }
				try { this.editor.cm.contentDOM.removeEventListener( 'blur', this.onBlurHandler ); } catch (error) { /* gone */ }

				const index = liveEditors.indexOf( this );
				if (index >= 0) liveEditors.splice( index, 1 );
				uninstallActiveLeafPatch( this.app );

				try { this.app.keymap.popScope( this.scope ); } catch (error) { /* not pushed */ }
				try {
					// Only clear our own owner, never one somebody else installed.
					if (this.app.workspace.activeEditor === this.activeEditorOwner) {
						this.app.workspace.activeEditor = null;
					}
				} catch (error) { /* nothing to clear */ }

				try { if (this._loaded) this.unload(); }
				catch (error) { console.warn( '[close-reflect] could not unload the editor:', error ); }
				try { this.containerEl.empty(); } catch (error) { /* already empty */ }
				if (typeof super.destroy === 'function') super.destroy();
			} catch (error) {
				console.error( '[close-reflect] could not destroy the editor:', error );
			}
		}

		onunload() { this.destroy(); }
	};
}

/**
 * Build an embedded Obsidian editor inside `containerEl`.
 *
 * Returns null — after logging why — whenever Obsidian's internals are not shaped the way
 * this expects. Callers must handle null by falling back to a plain textarea; the plugin
 * must never depend on this succeeding.
 */
export function createMarkdownEditor(
	app: App,
	containerEl: HTMLElement,
	options: MarkdownEditorOptions = {}
): MarkdownEditorHandle | null {
	if (!isMarkdownEditorAvailable()) return null;

	try {
		if (!editorClass) editorClass = makeEditorClass( resolveEditorPrototype( app ) );
		const editor = new editorClass( app, containerEl, options );
		return {
			getValue: () => editor.value,
			setValue: ( value: string ) => editor.setValue( value ),
			focus: () => { try { editor.editor.cm.focus(); } catch (error) { /* not mounted yet */ } },
			destroy: () => editor.destroy()
		};
	} catch (error) {
		console.error( '[close-reflect] could not create the embedded editor; falling back to a textarea:', error );
		return null;
	}
}
