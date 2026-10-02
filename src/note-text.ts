/**
 * A note split into its frontmatter block and everything after it.
 */
export interface NoteParts {
	/** The frontmatter block including its fences, or '' when the note has none. */
	frontmatter: string;
	/** Everything after the frontmatter. */
	body: string;
}

/**
 * Split a note into frontmatter and body.
 *
 * Only a block that opens on the very first line counts, so a `---` horizontal rule further
 * down the body is left alone.
 */
export function splitFrontmatter( text: string ): NoteParts {
	// The BOM guard covers a byte-order mark sitting ahead of the opening fence.
	const match = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec( text );
	if ( !match ) return { frontmatter: '', body: text };
	return { frontmatter: match[ 0 ], body: text.slice( match[ 0 ].length ) };
}

/**
 * Drop a note's YAML frontmatter, keeping only the body.
 *
 * Without this the overlay would render the properties as a table, which is noise in a
 * reflection prompt.
 */
export function stripFrontmatter( text: string ): string {
	return splitFrontmatter( text ).body;
}
