/**
 * Loads the block editor on first use: the page carries its scripts and
 * styles in an inert <template> (src/Modules/BlockEditorAssets.php); they
 * are copied into the document in order, each external script awaited
 * before the next one runs, as WordPress would have printed them.
 */
const TEMPLATE_ID = 'wc-products-list-block-editor-assets';
const SETTINGS_ID = 'wc-products-list-block-editor-settings';

let loading: Promise< number > | null = null;

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

/** Resolves with the milliseconds the load took (0 when it was loaded before). */
export function loadBlockEditor(): Promise< number > {
	if ( loading ) {
		return loading.then( () => 0 );
	}

	const template = document.getElementById( TEMPLATE_ID ) as HTMLTemplateElement | null;

	if ( ! template ) {
		return Promise.reject( new Error( 'The block editor is not available on this page.' ) );
	}

	const started = performance.now();

	loading = ( async () => {
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

	loading.catch( () => {
		loading = null;
	} );

	return loading;
}

/** The block editor settings the server gives (image sizes, upload limits); empty when the page has none. */
export function serverSettings(): Record< string, unknown > {
	try {
		return JSON.parse( document.getElementById( SETTINGS_ID )?.textContent ?? '{}' ) as Record< string, unknown >;
	} catch {
		return {};
	}
}
