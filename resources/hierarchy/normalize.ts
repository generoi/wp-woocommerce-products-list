/**
 * Turn wc/v3 rows into list rows: the `_kind/_level/_parentId/_hasChildren/
 * _childCount` meta the hierarchy reads, plus the few shape differences
 * between a product and a variation that the fields should not have to know
 * about (a variation has one `image`, products have `images`; a variation's
 * `name` is "Parent – Blue, 42", the list shows "Blue, 42").
 *
 * Both functions are pure and idempotent: the API client normalises every
 * row it returns, and useHierarchy normalises variations again with the
 * parent row at hand to copy its taxonomies.
 */
import { decodeEntities } from '@wordpress/html-entities';
import type { ListItemMeta, ProductListItem, ProductRow, RawAttribute, RawProduct, RawVariation, VariationRow } from '../types/product';

const META_KEYS: ReadonlyArray< keyof ListItemMeta > = [ '_kind', '_level', '_parentId', '_parentName', '_hasChildren', '_childCount', '_placeholder', '_placeholderMessage' ];

/** The parent taxonomies a variation shows read-only. */
const INHERITED_KEYS = [ 'categories', 'tags', 'brands' ] as const;

export function normalizeProduct( raw: RawProduct ): ProductRow {
	const count = childCountOf( raw );
	const type = raw.type ?? 'simple';

	return {
		...raw,
		type,
		_kind: 'product',
		_level: 0,
		_parentId: null,
		// A variable parent whose count the request did not include is still
		// expandable (as upstream treats undefined child state); its count
		// shows once the children load.
		_hasChildren: type === 'variable' && count !== 0,
		_childCount: count === undefined ? 0 : count,
	};
}

/**
 * @param raw    The wc/v3 variation (or an already normalised row).
 * @param parent The parent's id, or the parent row to copy taxonomies from.
 */
export function normalizeVariation( raw: RawVariation & { _parentName?: string }, parent: number | ProductRow ): VariationRow {
	const parentRow = typeof parent === 'number' ? undefined : parent;
	const parentId = typeof parent === 'number' ? parent : parent.id;
	const inherited: Partial< Pick< RawProduct, ( typeof INHERITED_KEYS )[ number ] > > = {};

	if ( parentRow ) {
		for ( const key of INHERITED_KEYS ) {
			if ( parentRow[ key ] !== undefined ) {
				inherited[ key ] = parentRow[ key ];
			}
		}
	}

	// A fresh wc/v3 row has `image`; a normalised row has both, and a patch
	// that sets an `image` must win over the stale `images` list. A null
	// `image` is not a removal: write responses are serialised in the edit
	// context, where a variation without an image of its own gets null
	// (reads fall back to the parent's), so what the row already shows stays.
	const images = raw.image ? [ raw.image ] : Array.isArray( raw.images ) ? raw.images : [];

	return {
		...inherited,
		...raw,
		type: 'variation',
		name: variationName( raw, parentRow?.name ),
		parent_id: parentId,
		status: raw.status === 'private' ? 'private' : raw.status === undefined ? undefined : 'publish',
		images,
		_kind: 'variation',
		_level: 1,
		_parentId: parentId,
		// For assistive tech: the row's name is just "Blue, 42".
		_parentName: parentRow?.name ? decodeEntities( parentRow.name ) : raw._parentName,
		_hasChildren: false,
		_childCount: 0,
	} as VariationRow;
}

/**
 * The short name of a variation: its attribute options ("Blue, 42"). When
 * the request left the attributes out, strip the parent's name from the
 * wc/v3 name ("Parent - Blue, 42"); as a last resort "#id".
 */
export function variationName( raw: RawVariation, parentName?: string ): string {
	const fromAttributes = attributeOptions( raw.attributes );

	if ( fromAttributes ) {
		return fromAttributes;
	}

	if ( raw.name ) {
		const name = decodeEntities( raw.name );
		const prefix = parentName ? `${ decodeEntities( parentName ) } - ` : null;

		if ( prefix && name.startsWith( prefix ) && name.length > prefix.length ) {
			return name.slice( prefix.length );
		}

		const dash = name.indexOf( ' - ' );

		return dash > 0 && dash < name.length - 3 ? name.slice( dash + 3 ) : name;
	}

	return `#${ raw.id }`;
}

function attributeOptions( attributes?: RawAttribute[] ): string {
	if ( ! attributes?.length ) {
		return '';
	}

	return attributes
		.map( ( attribute ) => ( attribute.option ?? '' ).trim() )
		.filter( Boolean )
		.map( decodeEntities )
		.join( ', ' );
}

function childCountOf( raw: RawProduct ): number | undefined {
	const count = raw.wc_products_list?.variation_count;

	if ( typeof count === 'number' ) {
		return count;
	}

	if ( Array.isArray( raw.variations ) ) {
		return raw.variations.length;
	}

	return undefined;
}

/** True when the row already carries the list meta (normalised before). */
export function isNormalized( raw: object ): raw is ProductListItem {
	return '_kind' in raw && '_level' in raw;
}

/** Strip the list meta before sending a row back to wc/v3. */
export function stripMeta< T extends object >( item: T ): Omit< T, keyof ListItemMeta > {
	const copy = { ...item } as Record< string, unknown >;

	for ( const key of META_KEYS ) {
		delete copy[ key ];
	}

	return copy as Omit< T, keyof ListItemMeta >;
}
