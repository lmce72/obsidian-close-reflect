import type { App } from 'obsidian';
import type { ButtonActionKind, ReflectButton } from './types';

/** How a failed action is reported. Actions never throw, so callers stay on the quit path. */
export type ActionErrorReporter = ( message: string, detail: unknown ) => void;

/** Whether an action kind points at something the user has to fill in. */
export function actionNeedsTarget( action: ButtonActionKind ): boolean {
	return action === 'openNote' || action === 'runCommand' || action === 'openUrl';
}

/**
 * Run the action behind a pressed button.
 *
 * Called after the quit has already been cancelled, so a failure leaves the app open rather
 * than half-closed. That is why this reports problems instead of throwing: it runs from inside
 * the promise Obsidian is awaiting, and a rejection there would strand the quit.
 */
export function performButtonAction( app: App, button: ReflectButton, report: ActionErrorReporter ): void {
	const target = button.target.trim();
	if ( actionNeedsTarget( button.action ) && target === '' ) {
		report( `button "${button.label}" has no target; nothing to do`, null );
		return;
	}

	try {
		switch ( button.action ) {
			case 'openNote':
				// Empty source path: the target is a vault-relative path, not a link to be
				// resolved relative to some other note.
				void app.workspace.openLinkText( target, '', false );
				return;
			case 'runCommand':
				runCommand( app, target, button, report );
				return;
			case 'openUrl':
				window.open( target, '_blank' );
				return;
			case 'stay':
			case 'leave':
				// Nothing to do: the outcome already decided what happens to the quit.
				return;
		}
	} catch (error) {
		report( `button "${button.label}" failed:`, error );
	}
}

/**
 * Execute an Obsidian command by id.
 *
 * `app.commands` is not part of the public typings, so it is reached structurally and may be
 * absent in a future version — nothing here assumes it exists.
 */
function runCommand( app: App, commandId: string, button: ReflectButton, report: ActionErrorReporter ): void {
	const registry = ( app as unknown as {
		commands?: { executeCommandById?( id: string ): boolean };
	} ).commands;

	if ( !registry || typeof registry.executeCommandById !== 'function' ) {
		report( `cannot run the command for button "${button.label}": the command registry is unavailable`, null );
		return;
	}

	if ( !registry.executeCommandById( commandId ) ) {
		report( `button "${button.label}" points at a command that is not registered:`, commandId );
	}
}
