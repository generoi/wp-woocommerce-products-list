/**
 * The server's dry run of a text transform ("Edit translated text"): when
 * the translation integration publishes `settings.languages.routes.preview`,
 * the language tool asks it what the run would write, with every template
 * token resolved ({name}, {brand}, {category}, {sku}) and the language each
 * {name} comes from, instead of guessing from the values the editor loaded.
 * Nothing is written. The client preview stays as the fallback (no route,
 * a failed request) and while the first answer is on its way.
 */
import apiFetch from '@wordpress/api-fetch';
import { useEffect, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { DeclarativeAction, Settings } from '../types';

/** The operations the server previews. */
export const SERVER_PREVIEW_OPERATIONS = [ 'template', 'set', 'prefix', 'suffix', 'replace' ];
/** The most ids one preview request takes (the route's limit). */
export const SERVER_PREVIEW_MAX_IDS = 100;
/** Typing pause before the preview is asked for. */
export const SERVER_PREVIEW_DEBOUNCE = 350;
/** Lines listed under the summary. */
const LINES_SHOWN = 5;

export interface ServerPreviewField {
	old: string;
	new: string | null;
	status: 'change' | 'unchanged' | 'skipped' | 'error';
	reason?: string;
	message?: string;
}

export interface ServerPreviewItem {
	id: number;
	parent_id?: number;
	name?: string;
	name_source?: { lang: string; label: string; own: boolean; value: string };
	fields?: Record< string, ServerPreviewField >;
	error?: string;
	message?: string;
}

export interface ServerPreviewResponse {
	items: ServerPreviewItem[];
	summary: { items: number; change: number; unchanged: number; skipped: number; error: number; name_sources?: Record< string, number > };
	message: string | null;
}

export interface ServerPreviewState {
	/** The latest answer for the current settings; null while none. */
	result: ( ServerPreviewResponse & { notPreviewed: number } ) | null;
	loading: boolean;
	failed: boolean;
}

/** The route to ask, or null when this tool and these settings are not previewed by the server. */
export function serverPreviewPath( def: DeclarativeAction, data: Record< string, unknown >, settings: Pick< Settings, 'languages' > | undefined ): string | null {
	const path = settings?.languages?.routes?.preview;

	if ( ! path || ! def.args.some( ( arg ) => arg.id === 'text' ) || ! def.args.some( ( arg ) => arg.id === 'operation' ) ) {
		return null;
	}

	return SERVER_PREVIEW_OPERATIONS.includes( String( data.operation ?? '' ) ) ? path : null;
}

export function fetchServerPreview( path: string, ids: number[], args: Record< string, unknown >, signal?: AbortSignal ): Promise< ServerPreviewResponse > {
	return apiFetch< ServerPreviewResponse >( { path, method: 'POST', data: { ids: ids.slice( 0, SERVER_PREVIEW_MAX_IDS ), args }, signal } );
}

const IDLE: ServerPreviewState = { result: null, loading: false, failed: false };

/**
 * Asks the server for the preview of `args` on `ids` (the first
 * SERVER_PREVIEW_MAX_IDS), debounced; a newer setting aborts the request
 * before it. `path` null switches it off.
 */
export function useServerPreview( path: string | null, ids: number[], args: Record< string, unknown > | null, fetcher: typeof fetchServerPreview = fetchServerPreview ): ServerPreviewState {
	const [ state, setState ] = useState< ServerPreviewState >( IDLE );
	const key = path && args && ids.length ? JSON.stringify( [ path, ids.slice( 0, SERVER_PREVIEW_MAX_IDS ), args ] ) : '';

	useEffect( () => {
		if ( ! key || ! path || ! args ) {
			setState( IDLE );

			return;
		}

		const controller = new AbortController();

		setState( ( previous ) => ( { ...previous, loading: true, failed: false } ) );

		const timer = setTimeout( () => {
			fetcher( path, ids, args, controller.signal )
				.then( ( response ) => {
					if ( ! controller.signal.aborted ) {
						setState( { result: { ...response, notPreviewed: Math.max( 0, ids.length - SERVER_PREVIEW_MAX_IDS ) }, loading: false, failed: false } );
					}
				} )
				.catch( () => {
					if ( ! controller.signal.aborted ) {
						setState( { result: null, loading: false, failed: true } );
					}
				} );
		}, SERVER_PREVIEW_DEBOUNCE );

		return () => {
			clearTimeout( timer );
			controller.abort();
		};
		// `key` stands for path, ids and args.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ key ] );

	return state;
}

function plain( value: string | null ): string {
	const text = value ?? '';

	return text.includes( '<' ) || text.includes( '&' )
		? text
				.replace( /<[^>]*>/g, ' ' )
				.replace( /&nbsp;/g, ' ' )
				.replace( /&amp;/g, '&' )
				.replace( /&lt;/g, '<' )
				.replace( /&gt;/g, '>' )
				.replace( /&quot;/g, '"' )
				.replace( /&#0?39;/g, "'" )
				.replace( /\s+/g, ' ' )
				.trim()
		: text;
}

export interface ServerPreviewLine {
	key: string;
	name: string;
	field: string;
	status: ServerPreviewField[ 'status' ] | 'gone';
	before: string;
	after: string;
	note?: string;
}

/** The lines worth showing: changes first, then skips and errors; unchanged values are only counted. */
export function serverPreviewLines( response: ServerPreviewResponse, fieldLabel: ( field: string ) => string, lang: string ): ServerPreviewLine[] {
	const lines: ServerPreviewLine[] = [];
	const rank = { change: 0, error: 1, skipped: 2, gone: 3, unchanged: 4 };

	for ( const item of response.items ) {
		const name = item.name || `#${ item.id }`;

		if ( item.error ) {
			lines.push( { key: `${ item.id }`, name, field: '', status: 'gone', before: '', after: '', note: item.message } );

			continue;
		}

		const source = item.name_source && ! item.name_source.own ? item.name_source : null;

		for ( const [ field, entry ] of Object.entries( item.fields ?? {} ) ) {
			if ( entry.status === 'unchanged' ) {
				continue;
			}

			let note: string | undefined;

			if ( entry.status === 'skipped' ) {
				note =
					entry.reason === 'no_own_name'
						? sprintf(
								/* translators: %s: language code or name */
								__( 'skipped: no %s name of its own', 'wp-woocommerce-products-list' ),
								lang
						  )
						: __( 'skipped', 'wp-woocommerce-products-list' );
			} else if ( entry.status === 'error' ) {
				note = entry.message || __( 'error', 'wp-woocommerce-products-list' );
			} else if ( source ) {
				note = sprintf(
					/* translators: %s: language name */
					__( '{name} from %s', 'wp-woocommerce-products-list' ),
					source.label
				);
			}

			lines.push( {
				key: `${ item.id }:${ field }`,
				name,
				field: fieldLabel( field ),
				status: entry.status,
				before: plain( entry.old ) || __( '(not translated)', 'wp-woocommerce-products-list' ),
				after: plain( entry.new ),
				...( note ? { note } : {} ),
			} );
		}
	}

	return lines.sort( ( a, b ) => rank[ a.status ] - rank[ b.status ] );
}

export function ServerPreview( { state, fieldLabel, langLabel }: { state: ServerPreviewState & { result: NonNullable< ServerPreviewState[ 'result' ] > }; fieldLabel( field: string ): string; langLabel: string } ) {
	const { result } = state;
	const lines = serverPreviewLines( result, fieldLabel, langLabel );
	const { change, skipped, error } = result.summary;

	return (
		<div className="wc-pl-language-tools__preview is-server" aria-live="polite" aria-busy={ state.loading }>
			{ result.message ? <p className="wc-pl-language-tools__warning">{ result.message }</p> : null }
			<p className="wc-pl-language-tools__description">
				{ change === 0
					? __( 'Preview: this changes no values.', 'wp-woocommerce-products-list' )
					: sprintf(
							/* translators: %d: number of values that change */
							_n( 'Preview: %d value changes.', 'Preview: %d values change.', change, 'wp-woocommerce-products-list' ),
							change
					  ) }
				{ skipped > 0
					? ` ${ sprintf(
							/* translators: %d: number of values left as they are */
							_n( '%d skipped.', '%d skipped.', skipped, 'wp-woocommerce-products-list' ),
							skipped
					  ) }`
					: '' }
				{ error > 0
					? ` ${ sprintf(
							/* translators: %d: number of values that would fail */
							_n( '%d would fail.', '%d would fail.', error, 'wp-woocommerce-products-list' ),
							error
					  ) }`
					: '' }
				{ result.notPreviewed > 0
					? ` ${ sprintf(
							/* translators: 1: number previewed, 2: number not previewed */
							__( '(First %1$d items previewed; %2$d more are not.)', 'wp-woocommerce-products-list' ),
							SERVER_PREVIEW_MAX_IDS,
							result.notPreviewed
					  ) }`
					: '' }
			</p>
			{ lines.length ? (
				<ul>
					{ lines.slice( 0, LINES_SHOWN ).map( ( line ) => (
						<li key={ line.key } className={ `is-${ line.status }` }>
							<span className="wc-pl-language-tools__preview-name">{ line.name }</span>
							{ line.field ? ` (${ line.field })` : '' }{ ' ' }
							{ line.status === 'change' ? (
								<>
									<del>{ line.before }</del> → <ins>{ line.after }</ins>
								</>
							) : null }
							{ line.note ? <span className="wc-pl-language-tools__preview-note"> ({ line.note })</span> : null }
						</li>
					) ) }
				</ul>
			) : null }
		</div>
	);
}
