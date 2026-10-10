/**
 * What the editor showed when the user started editing a field: the rows
 * as they were rendered at the field's first change. A save's expected
 * values (`_wcpl_expect`, expect.ts) for that field come from these rows,
 * never from values loaded afterwards that the form did not show, so a
 * change someone else made after the user started editing is refused (409)
 * rather than written over.
 *
 * The editor renders from the list's rows at once and merges the fetched
 * rows in when they arrive; a control the user is already typing in keeps
 * their text. Without this snapshot a fresh row arriving after the first
 * keystroke became the expected value although the user never saw it
 * (the price box still read 15, expect said 16, the save overwrote 16).
 *
 * A snapshot is dropped (`rebase()`) only where the editor presented the
 * values stored now: the stale warning's refreshed preview, or an explicit
 * "write over the other change".
 */
import type { ProductField, ProductListItem } from '../types';
import { arrayFieldOf, isArrayOpFieldId } from './bulk-array';
import { isPlainObject, normalizeForCompare, readFieldValue } from './field-value';
import { SCHEDULE_SALE_FIELD_ID } from './payload';
import { leafOf } from './visibility';

/** The row paths (`regular_price`, `i18n.se.name`, `meta_data`) a form field's value is read from and written to. */
export function pathsOfEdit( id: string, byId: ReadonlyMap< string, ProductField > ): string[] {
	if ( id === SCHEDULE_SALE_FIELD_ID || leafOf( id ) === SCHEDULE_SALE_FIELD_ID ) {
		const prefix = id.slice( 0, id.length - SCHEDULE_SALE_FIELD_ID.length );

		return [ `${ prefix }date_on_sale_from`, `${ prefix }date_on_sale_to` ].flatMap( ( dateId ) => pathsOfField( byId.get( dateId ), dateId ) );
	}

	const fieldId = isArrayOpFieldId( id ) ? arrayFieldOf( id ) : id;

	return pathsOfField( byId.get( fieldId ), fieldId );
}

function pathsOfField( field: ProductField | undefined, id: string ): string[] {
	const keys = field?.rest?.fields;

	return keys && keys.length ? [ ...keys ] : [ id.split( '.' )[ 0 ] ?? id ];
}

const ABSENT = Symbol( 'absent' );

function readPath( row: Record< string, unknown >, path: string ): unknown {
	let node: unknown = row;

	for ( const part of path.split( '.' ) ) {
		if ( ! isPlainObject( node ) || ! ( part in node ) ) {
			return ABSENT;
		}

		node = node[ part ];
	}

	return node;
}

function writePath( row: Record< string, unknown >, path: string, value: unknown ): Record< string, unknown > {
	const [ head, ...rest ] = path.split( '.' );
	const key = head ?? path;
	const copy: Record< string, unknown > = { ...row };

	if ( rest.length === 0 ) {
		if ( value === ABSENT ) {
			delete copy[ key ];
		} else {
			copy[ key ] = value;
		}

		return copy;
	}

	const child = isPlainObject( row[ key ] ) ? ( row[ key ] as Record< string, unknown > ) : {};

	copy[ key ] = writePath( child, rest.join( '.' ), value );

	return copy;
}

/** Whether a row carries every path of the field (its value was loaded, not just absent from the list's columns). */
export function rowCarries( row: ProductListItem, paths: string[] ): boolean {
	return paths.every( ( path ) => readPath( row as Record< string, unknown >, path ) !== ABSENT );
}

export class ShownValues {
	/** Field id => (row id => the row as rendered when the field was first changed). */
	private readonly byField = new Map< string, Map< number, ProductListItem > >();

	/** Remember the rows for each field changed for the first time (fields already recorded keep their first rows). */
	record( fieldIds: Iterable< string >, rows: Iterable< ProductListItem > ): void {
		let snapshot: Map< number, ProductListItem > | null = null;

		for ( const id of fieldIds ) {
			if ( this.byField.has( id ) ) {
				continue;
			}

			snapshot ??= new Map( Array.from( rows, ( row ) => [ row.id, row ] as [ number, ProductListItem ] ) );
			this.byField.set( id, snapshot );
		}
	}

	has( fieldId: string ): boolean {
		return this.byField.has( fieldId );
	}

	/** The row a field's edit was started from (undefined: the field was not changed, or the row loaded after). */
	rowOf( fieldId: string, rowId: number ): ProductListItem | undefined {
		return this.byField.get( fieldId )?.get( rowId );
	}

	/** The rows now shown become what these rows' edits are based on (all rows without ids). */
	rebase( rows: Iterable< ProductListItem > ): void {
		for ( const row of rows ) {
			for ( const snapshot of this.byField.values() ) {
				if ( snapshot.has( row.id ) ) {
					snapshot.set( row.id, row );
				}
			}
		}
	}

	/** Forget fields no longer edited (or every field). */
	forget( fieldIds?: Iterable< string > ): void {
		if ( ! fieldIds ) {
			this.byField.clear();

			return;
		}

		for ( const id of fieldIds ) {
			this.byField.delete( id );
		}
	}

	/**
	 * The row an item's expected values are read from: the current row with
	 * each changed field's paths as the form showed them when the edit
	 * started. A row loaded after that (a variation fetched later) is the
	 * current row: the user cannot have seen anything older.
	 *
	 * Fields share paths (the sale price reads the regular price, the stock
	 * status the stock quantity, every meta-backed field `meta_data`), so a
	 * path is settled by the field changed first whose snapshot carries it:
	 * the oldest value the form showed for it, never one a later snapshot
	 * took from a load the user had not seen when they typed. `meta_data` is
	 * settled per meta key the same way; a key no snapshot carries is left
	 * out (nothing the form showed, so nothing is expected), not taken from
	 * the current row. The result does not depend on object identity.
	 */
	baseRow( item: ProductListItem, byId: ReadonlyMap< string, ProductField > ): ProductListItem {
		const settled = new Map< string, unknown >();
		const metaByKey = new Map< string, unknown[] >();
		let metaPath = false;
		let metaCarried = false;
		let any = false;

		// Map order is record order: the field changed first comes first.
		for ( const [ id, snapshot ] of this.byField ) {
			const shown = snapshot.get( item.id ) as Record< string, unknown > | undefined;

			if ( ! shown ) {
				continue;
			}

			any = true;

			for ( const path of pathsOfEdit( id, byId ) ) {
				if ( path === META_PATH ) {
					metaPath = true;

					if ( Array.isArray( shown[ META_PATH ] ) ) {
						metaCarried = true;
						settleMeta( metaByKey, shown[ META_PATH ] as unknown[] );
					}

					continue;
				}

				const value = readPath( shown, path );

				if ( ! settled.has( path ) || ( settled.get( path ) === ABSENT && value !== ABSENT ) ) {
					settled.set( path, value );
				}
			}
		}

		if ( ! any ) {
			return item;
		}

		let row = item as Record< string, unknown >;

		for ( const [ path, value ] of settled ) {
			row = writePath( row, path, value );
		}

		if ( metaPath ) {
			row = writePath( row, META_PATH, metaCarried ? Array.from( metaByKey.values() ).flat() : ABSENT );
		}

		return row as ProductListItem;
	}
}

const META_PATH = 'meta_data';

/** Add the meta keys a snapshot carries that no earlier snapshot did (every entry of the key, as listed). */
function settleMeta( byKey: Map< string, unknown[] >, list: unknown[] ): void {
	const here = new Map< string, unknown[] >();

	for ( const entry of list ) {
		const key = isPlainObject( entry ) ? entry.key : undefined;

		if ( typeof key !== 'string' || byKey.has( key ) ) {
			continue;
		}

		here.set( key, [ ...( here.get( key ) ?? [] ), entry ] );
	}

	for ( const [ key, entries ] of here ) {
		byKey.set( key, entries );
	}
}

/** A field whose value now differs from the one the form showed first. */
export interface ChangedField {
	id: string;
	/** The value now (merged over the rows, as the form reads it). */
	now: unknown;
	/** Whether the user has changed the field (their value stays; the save is refused for the other change). */
	edited: boolean;
}

/**
 * The fields whose value changed after the form first showed it: values
 * the fetch brought in that differ from the list's, or a later reload.
 * `edited` maps the fields the user changed to their value now. `first` holds the value each field showed first; fields not in it yet are
 * added (a field shown for the first time is not "changed").
 */
export function changedSinceShown(
	fields: ProductField[],
	rowsNow: ProductListItem[],
	first: Map< string, string >,
	shown: ShownValues,
	edited: ReadonlyMap< string, unknown >,
	loaded: ( field: ProductField ) => boolean
): ChangedField[] {
	const changed: ChangedField[] = [];
	const rows = rowsNow.filter( ( row ) => ! row._placeholder );

	for ( const field of fields ) {
		if ( ! loaded( field ) || rows.length === 0 ) {
			continue;
		}

		const values = rows.map( ( row ) => readFieldValue( field, row ) );
		const key = normalizeForCompare( values );
		const before = first.get( field.id );

		if ( before === undefined ) {
			first.set( field.id, key );

			continue;
		}

		if ( before === key ) {
			continue;
		}

		// An edited field now holding what the user typed (their own save landed after all): nothing to say.
		if ( edited.has( field.id ) && values.length === 1 && sameText( values[ 0 ], edited.get( field.id ) ) ) {
			continue;
		}

		// An edited field: compare with what it showed when the edit started.
		if ( edited.has( field.id ) && shown.has( field.id ) ) {
			const startRows = rows.map( ( row ) => shown.rowOf( field.id, row.id ) ?? row );

			if ( normalizeForCompare( startRows.map( ( row ) => readFieldValue( field, row ) ) ) === key ) {
				continue;
			}
		}

		changed.push( { id: field.id, now: values.length === 1 ? values[ 0 ] : values, edited: edited.has( field.id ) } );
	}

	return changed;
}

function sameText( a: unknown, b: unknown ): boolean {
	const text = ( value: unknown ) => ( value === null || value === undefined ? '' : typeof value === 'object' ? normalizeForCompare( value ) : String( value ) );

	return text( a ) === text( b );
}
