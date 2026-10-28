/**
 * Loads the media library and the block editor on first use: the page
 * carries their scripts and styles in inert <template>s
 * (src/Modules/BlockEditorAssets.php); they are copied into the document
 * in order, each external script awaited before the next one runs, as
 * WordPress would have printed them. The block editor's template leaves out
 * what the media one has, so it loads the media library first.
 */
const TEMPLATE_ID = 'wc-products-list-block-editor-assets';
const MEDIA_TEMPLATE_ID = 'wc-products-list-media-assets';
const SETTINGS_ID = 'wc-products-list-block-editor-settings';

const loading = new Map< string, Promise< number > >();

/** Whether the page carries the block editor's assets at all (the products list screen does). */
export function canLoadBlockEditor(): boolean {
	return !! document.getElementById( TEMPLATE_ID );
}

function copyScript( source: HTMLScriptElement ): Promise< void > {
	const script = document.createElement( 'script' );

	for ( const attribute of Array.from( source.attributes ) ) {
		script.setAttribute( attribute.name, attribute.value );
	}

	if ( ! source.src ) {
		script.textContent = source.textContent;
		document.body.appendChild( script );

		return Promise.resolve();
	}

	return new Promise( ( resolve, reject ) => {
		script.async = false;
		script.onload = () => resolve();
		script.onerror = () => reject( new Error( `Could not load ${ source.src }` ) );
		document.body.appendChild( script );
	} );
}

function loadTemplate( id: string ): Promise< number > {
	const known = loading.get( id );

	if ( known ) {
		return known.then( () => 0 );
	}

	const template = document.getElementById( id ) as HTMLTemplateElement | null;

	if ( ! template ) {
		return Promise.reject( new Error( 'These assets are not available on this page.' ) );
	}

	const started = performance.now();
	const load = ( async () => {
		// Every script downloads at once; they still run one by one, in order, from the cache.
		for ( const node of Array.from( template.content.querySelectorAll( 'script[src]' ) ) ) {
			const preload = document.createElement( 'link' );

			preload.rel = 'preload';
			preload.as = 'script';
			preload.href = ( node as HTMLScriptElement ).src;
			document.head.appendChild( preload );
		}

		for ( const node of Array.from( template.content.childNodes ) ) {
			if ( node instanceof HTMLScriptElement ) {
				await copyScript( node );
			} else if ( node instanceof HTMLLinkElement || node instanceof HTMLStyleElement ) {
				document.head.appendChild( node.cloneNode( true ) );
			}
		}

		return performance.now() - started;
	} )();

	loading.set( id, load );
	load.catch( () => {
		loading.delete( id );
	} );

	return load;
}

/** Whether the page carries the media library's assets (the products list screen does). */
export function canLoadMedia(): boolean {
	return !! document.getElementById( MEDIA_TEMPLATE_ID ) || typeof ( window as { wp?: { media?: unknown } } ).wp?.media === 'function';
}

/** Loads the media library (`wp.media`); resolves with the milliseconds the load took (0 when it was there before). */
export function loadMedia(): Promise< number > {
	if ( ! document.getElementById( MEDIA_TEMPLATE_ID ) && typeof ( window as { wp?: { media?: unknown } } ).wp?.media === 'function' ) {
		return Promise.resolve( 0 );
	}

	return loadTemplate( MEDIA_TEMPLATE_ID );
}

/** Resolves with the milliseconds the load took (0 when it was loaded before). */
export async function loadBlockEditor(): Promise< number > {
	if ( ! document.getElementById( TEMPLATE_ID ) ) {
		throw new Error( 'The block editor is not available on this page.' );
	}

	const media = document.getElementById( MEDIA_TEMPLATE_ID ) ? await loadMedia() : 0;

	return media + ( await loadTemplate( TEMPLATE_ID ) );
}

/** The block editor settings the server gives (image sizes, upload limits); empty when the page has none. */
export function serverSettings(): Record< string, unknown > {
	try {
		return JSON.parse( document.getElementById( SETTINGS_ID )?.textContent ?? '{}' ) as Record< string, unknown >;
	} catch {
		return {};
	}
}
