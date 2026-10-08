/**
 * Human labels for the field keys the change log stores. The server logs
 * each request body leaf the way `Log\Recorder::paths()` names it
 * (`regular_price`, `i18n.de.meta_title`, `meta_data._foo`); the registry
 * knows which field writes which key, so the History screen can show and
 * filter by "Regular price" or "Deutsch: SEO title" instead.
 */
import type { ProductField } from '../types';

/** `Log\Recorder::IGNORED_KEYS`: never a log field. */
const IGNORED_KEYS = [ 'id', 'product_id', 'context', '_fields', '_locale', '_method', '_envelope', 'force', 'parent_id' ];

/** `Log\Recorder::CORE_KEYS` that hold an object: logged as one field, not per leaf. */
const OBJECT_CORE_KEYS = [ 'dimensions', 'cost_of_goods_sold', 'image', 'downloads', 'categories', 'tags', 'brands', 'images', 'attributes', 'default_attributes' ];

function isPlainObject( value: unknown ): value is Record< string, unknown > {
	return typeof value === 'object' && value !== null && ! Array.isArray( value );
}

function leaves( value: Record< string, unknown >, prefix: string ): string[] {
	return Object.entries( value ).flatMap( ( [ key, child ] ) => ( isPlainObject( child ) && Object.keys( child ).length > 0 ? leaves( child, `${ prefix }.${ key }` ) : [ `${ prefix }.${ key }` ] ) );
}

/** The log keys a request body yields, as `Log\Recorder::paths()` computes them. */
export function logPaths( body: Record< string, unknown > ): string[] {
	const paths: string[] = [];

	for ( const [ key, value ] of Object.entries( body ) ) {
		if ( key === '' || IGNORED_KEYS.includes( key ) ) {
			continue;
		}

		if ( key === 'meta_data' ) {
			for ( const meta of Array.isArray( value ) ? value : [] ) {
				if ( isPlainObject( meta ) && ( typeof meta.key === 'string' || typeof meta.key === 'number' ) && String( meta.key ) !== '' ) {
					paths.push( `meta_data.${ meta.key }` );
				}
			}

			continue;
		}

		if ( OBJECT_CORE_KEYS.includes( key ) || ! isPlainObject( value ) ) {
			paths.push( key );

			continue;
		}

		paths.push( ...leaves( value, key ) );
	}

	return Array.from( new Set( paths ) );
}

/** The log keys an edit of `field` writes; its id when the write cannot be probed. */
export function logKeysForField( field: ProductField ): string[] {
	if ( ! field.rest.write ) {
		return [ field.id ];
	}

	try {
		const body = field.rest.write( '', {} as never );
		const keys = isPlainObject( body ) ? logPaths( body ) : [];

		return keys.length > 0 ? keys : [ field.id ];
	} catch {
		return [ field.id ];
	}
}

function labelOf( field: ProductField ): string {
	return typeof field.label === 'string' && field.label !== '' ? field.label : field.id;
}

export interface LogFieldOption {
	value: string;
	label: string;
}

/**
 * One option per log key the editable fields write, labelled with the
 * field's label (`Dimensions (length)` when a field writes several keys),
 * in registry order. Read-only and filter-only fields write nothing and are
 * left out (fields only actions write, like status or featured, stay); extra keys only the server logs fall back to the raw key in
 * `logFieldLabel()`.
 */
export function logFieldOptions( fields: ProductField[] ): LogFieldOption[] {
	const options = new Map< string, string >();

	for ( const field of fields ) {
		if ( field.filterOnly || field.readOnly ) {
			continue;
		}

		const keys = logKeysForField( field );

		for ( const key of keys ) {
			if ( options.has( key ) ) {
				continue;
			}

			const leaf = key.slice( key.lastIndexOf( '.' ) + 1 );
			options.set( key, keys.length > 1 ? `${ labelOf( field ) } (${ leaf })` : labelOf( field ) );
		}
	}

	return Array.from( options, ( [ value, label ] ) => ( { value, label } ) );
}

/** The label of a logged field key; the key itself when no field writes it. */
export function logFieldLabel( key: string | null | undefined, options: LogFieldOption[] ): string {
	if ( ! key ) {
		return '';
	}

	return options.find( ( option ) => option.value === key )?.label ?? key;
}
