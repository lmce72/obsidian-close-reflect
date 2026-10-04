/**
 * The Capacitor App plugin, as far as the Android back button needs it.
 *
 * Obsidian mobile runs on Capacitor and keeps the plugin bridge on `window.Capacitor`. This
 * is declared structurally rather than imported: the plugin has no dependency on Capacitor,
 * and the desktop build must not pull one in.
 */
export interface CapacitorAppPlugin {
	addListener( name: string, handler: ( payload?: unknown ) => void ): CapacitorListenerHandle | undefined;
	minimizeApp?(): Promise<void> | void;
}

/** What Capacitor reports when the app moves between foreground and background. */
export interface CapacitorAppState {
	isActive: boolean;
}

export interface CapacitorListenerHandle {
	remove?(): Promise<void> | void;
}

interface CapacitorGlobal {
	Plugins?: Record<string, unknown>;
	registerPlugin?( name: string ): unknown;
}

/**
 * Reach Obsidian's Capacitor App plugin, or null.
 *
 * Two routes, because Capacitor has changed its shape: `window.Capacitor.Plugins.App` (the
 * form Obsidian users have used in their own scripts) and `registerPlugin('App')` (the
 * Capacitor 3+ one). Null means the caller should leave the back button alone — this is not
 * something to guess at.
 */
export function getCapacitorApp(): CapacitorAppPlugin | null {
	try {
		const capacitor = ( window as unknown as { Capacitor?: CapacitorGlobal } ).Capacitor;
		if ( !capacitor ) return null;

		const fromPlugins = capacitor.Plugins?.App as CapacitorAppPlugin | undefined;
		if ( fromPlugins && typeof fromPlugins.addListener === 'function' ) return fromPlugins;

		if ( typeof capacitor.registerPlugin === 'function' ) {
			const registered = capacitor.registerPlugin( 'App' ) as CapacitorAppPlugin | null;
			if ( registered && typeof registered.addListener === 'function' ) return registered;
		}
	} catch (error) {
		console.error( '[close-reflect] could not reach the Capacitor App plugin:', error );
	}
	return null;
}

/**
 * Subscribe to the hardware back button.
 *
 * Obsidian registers a listener of its own, and Capacitor delivers the event to every
 * listener — there is no priority and no way to stop the others. So this observes alongside
 * Obsidian rather than taking over, which is why it must not call `removeAllListeners()`:
 * that also drops Obsidian's own handlers for back, URI opens, share intents and app state.
 *
 * @returns a handle that removes this listener again, or null when unavailable
 */
export function listenForBackButton(
	app: CapacitorAppPlugin,
	handler: () => void
): CapacitorListenerHandle | null {
	return listen( app, 'backButton', handler );
}

/**
 * Subscribe to the app moving between foreground and background.
 *
 * This is the "going back to the home screen" gesture. Unlike the back button it cannot be
 * cancelled at all — the app is already on its way out — so the prompt it raises is there to
 * be seen on the way back.
 */
export function listenForAppState(
	app: CapacitorAppPlugin,
	handler: ( state: CapacitorAppState ) => void
): CapacitorListenerHandle | null {
	return listen( app, 'appStateChange', handler as ( payload?: unknown ) => void );
}

function listen(
	app: CapacitorAppPlugin,
	event: string,
	handler: ( payload?: unknown ) => void
): CapacitorListenerHandle | null {
	try {
		const handle = app.addListener( event, handler );
		return handle ?? {};
	} catch (error) {
		console.error( `[close-reflect] could not listen for ${event}:`, error );
		return null;
	}
}

/** Undo one of the subscriptions above. */
export function removeListener( handle: CapacitorListenerHandle | null ): void {
	try {
		void handle?.remove?.();
	} catch (error) {
		console.error( '[close-reflect] could not remove a Capacitor listener:', error );
	}
}

/** Send the app to the background — the same thing Obsidian's own second back press does. */
export function minimizeApp( app: CapacitorAppPlugin ): void {
	try {
		void app.minimizeApp?.();
	} catch (error) {
		console.error( '[close-reflect] could not minimize the app:', error );
	}
}
