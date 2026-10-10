/**
 * Human text for the wc/v3 error codes a save can come back with. The raw
 * message ("Invalid ID.") stays in the log; the modal shows what it means.
 */
import { __, sprintf } from '@wordpress/i18n';

const MESSAGES: Record< string, () => string > = {
	woocommerce_rest_product_invalid_id: () => __( 'This product no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_variation_invalid_id: () => __( 'This variation no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_product_variation_invalid_id: () => __( 'This variation no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_invalid_id: () => __( 'This item no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_cannot_edit: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	woocommerce_rest_cannot_batch: () => __( 'You are not allowed to bulk edit (edit_others_products is required).', 'wp-woocommerce-products-list' ),
	rest_forbidden: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	rest_cannot_edit: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	product_invalid_sku: () => __( 'This SKU is already used by another product.', 'wp-woocommerce-products-list' ),
	woocommerce_rest_product_invalid_sku: () => __( 'This SKU is already used by another product.', 'wp-woocommerce-products-list' ),
	rest_invalid_param: () => __( 'A value was rejected by WooCommerce.', 'wp-woocommerce-products-list' ),
	missing_result: () => __( 'WooCommerce returned no result for this item.', 'wp-woocommerce-products-list' ),
	// The server's concurrency checks (docs/contracts.md §3.6).
	wc_products_list_conflict: () => __( 'Changed by someone else since it was loaded, so it was not saved. The list now shows the stored values: check them and apply the change again.', 'wp-woocommerce-products-list' ),
	wc_products_list_locked: () => __( 'Another save of this item was running, so it was not saved. Try again in a moment.', 'wp-woocommerce-products-list' ),
	wc_products_list_trashed: () => __( 'This item is in the Trash, so it was not saved.', 'wp-woocommerce-products-list' ),
	wc_products_list_deleted: () => __( 'Deleted meanwhile (another tab or user); nothing was saved for this item.', 'wp-woocommerce-products-list' ),
	// The server's message names the user (Concurrency::editingError) and is shown instead; this is the fallback.
	wc_products_list_editing: () => __( 'This product is open in the product editor; nothing was done to this item.', 'wp-woocommerce-products-list' ),
};

/** Per-item refusals of the server's concurrency checks: the server logs them as skipped rows itself (not posted to /log/skipped again). */
const SERVER_LOGGED_CODES: ReadonlySet< string > = new Set( [ 'wc_products_list_conflict', 'wc_products_list_locked', 'wc_products_list_trashed', 'wc_products_list_deleted', 'wc_products_list_editing' ] );

export function isServerLoggedCode( code: string | undefined ): boolean {
	return code !== undefined && SERVER_LOGGED_CODES.has( code );
}

/**
 * Whether the server logged an `error` row itself for an item error of a
 * batch answer (Recorder::errorsFromResponse): every item error except a
 * permission refusal (Recorder::isRefusal) and except the errors the client
 * makes for the rows of a request that failed as a whole
 * (`wcpl_request_failed`, REQUEST_FAILED_KEY in api/client.ts). A row
 * wc/v3 no longer finds is logged by the server too, as `deleted` (left
 * out, Recorder::GONE_CODES). Such a row is not posted to /log/skipped
 * again: History would show it twice.
 */
export function isServerLoggedItemError( code: string | undefined, data: unknown ): boolean {
	const record = typeof data === 'object' && data !== null ? ( data as Record< string, unknown > ) : {};

	// The concurrency refusals are told apart by their code (isServerLoggedCode).
	if ( record.wcpl_request_failed === true || isServerLoggedCode( code ) ) {
		return false;
	}

	if ( code !== undefined && /^(rest_forbidden|rest_cannot_|rest_not_logged_in|woocommerce_rest_cannot_|woocommerce_rest_authentication_)/.test( code ) ) {
		return false;
	}

	const status = Number( record.status ?? 0 );

	return status !== 401 && status !== 403;
}

/** Whether a row was refused because it changed meanwhile (reload it, then apply again). */
export function isConflictCode( code: string | undefined ): boolean {
	return code === 'wc_products_list_conflict';
}

/** The data of a `wc_products_list_conflict` (docs/contracts.md §3.6): the fields, their values now and the values the write was based on. */
export interface ConflictData {
	fields: string[];
	current: Record< string, unknown >;
	expected: Record< string, unknown >;
}

function asRecord( value: unknown ): Record< string, unknown > {
	return typeof value === 'object' && value !== null && ! Array.isArray( value ) ? ( value as Record< string, unknown > ) : {};
}

/** The conflict data of an error's `data`, or null when it carries none. */
export function conflictDataOf( data: unknown ): ConflictData | null {
	const record = asRecord( data );
	const current = asRecord( record.current );
	const fields = Array.isArray( record.fields ) ? record.fields.filter( ( field ): field is string => typeof field === 'string' ) : Object.keys( current );

	return fields.length ? { fields, current, expected: asRecord( record.expected ) } : null;
}

/** A stored scalar in the shop's format ("21,00 €" for a price), as the editor's other notes show it. */
export type ConflictValueFormat = ( path: string, value: string ) => string;

function shownValue( value: unknown, path = '', format?: ConflictValueFormat ): string {
	// A variation's tax class `parent` is WooCommerce's stored value for "use the parent's".
	if ( path === 'tax_class' && value === 'parent' ) {
		return __( 'Same as parent', 'wp-woocommerce-products-list' );
	}

	if ( value === null || value === undefined || value === '' ) {
		return '—';
	}

	if ( typeof value === 'object' ) {
		return JSON.stringify( value );
	}

	return format ? format( path, String( value ) ) : String( value );
}

/**
 * The other change, field by field: "Regular price 30 (was 12 when loaded)".
 * `label` maps a field path to its label.
 */
export function describeConflictValues( conflict: ConflictData, label: ( path: string ) => string = ( path ) => path, format?: ConflictValueFormat ): string {
	return conflict.fields
		.map( ( path ) =>
			path in conflict.expected
				? sprintf(
						/* translators: 1: field label, 2: the value stored now, 3: the value when the editor loaded it */
						__( '%1$s %2$s (was %3$s when loaded)', 'wp-woocommerce-products-list' ),
						label( path ),
						shownValue( conflict.current[ path ], path, format ),
						shownValue( conflict.expected[ path ], path, format )
				  )
				: sprintf(
						/* translators: 1: field label, 2: the value stored now */
						__( '%1$s %2$s', 'wp-woocommerce-products-list' ),
						label( path ),
						shownValue( conflict.current[ path ], path, format )
				  )
		)
		.join( '; ' );
}

/**
 * The editor's line for a row refused with `wc_products_list_conflict`: what
 * the other change stored, and that the form still holds the user's values,
 * which only an explicit overwrite writes (never a plain retry).
 */
export function editorConflictMessage( data: unknown, label: ( path: string ) => string, bulk: boolean, format?: ConflictValueFormat ): string {
	const conflict = conflictDataOf( data );
	const stored = conflict
		? sprintf(
				/* translators: %s: the fields with the values stored now, e.g. "Regular price 30 (was 12 when loaded)" */
				__( 'Someone else changed it since it was loaded: %s. Nothing was saved for it.', 'wp-woocommerce-products-list' ),
				describeConflictValues( conflict, label, format )
		  )
		: __( 'Someone else changed it since it was loaded. Nothing was saved for it.', 'wp-woocommerce-products-list' );

	return `${ stored } ${
		bulk
			? __( 'Your edits are kept: confirm below to apply them to the values stored now, or cancel to keep the other change.', 'wp-woocommerce-products-list' )
			: __( 'The form still shows your values: confirm below to write them over the other change, or cancel to keep it.', 'wp-woocommerce-products-list' )
	}`;
}

const SKU_CODES: ReadonlySet< string > = new Set( [ 'product_invalid_sku', 'woocommerce_rest_product_invalid_sku' ] );

const FIELD_OF_CODE: Record< string, string > = {
	product_invalid_sku: 'sku',
	woocommerce_rest_product_invalid_sku: 'sku',
	product_invalid_global_unique_id: 'global_unique_id',
};

/** The form field a row error is about (a taken SKU is the SKU field's), for flagging its control; undefined when it is about the row. */
export function fieldOfErrorCode( code: string | undefined ): string | undefined {
	return code ? FIELD_OF_CODE[ code ] : undefined;
}

/** The message to show for a failed row: a known code's text, else the server's message (with the code's detail kept when it adds something). */
export function humanizeError( code: string | undefined, message: string ): string {
	const known = code ? MESSAGES[ code ] : undefined;

	if ( ! known ) {
		return message || __( 'The item could not be saved.', 'wp-woocommerce-products-list' );
	}

	const text = known();

	// The plugin names the product that owns a taken SKU ("… is already used by "Name" (#206).", Saves::skuOwnerMessage): that says more.
	if ( code && SKU_CODES.has( code ) && message && /#\d+/.test( message ) ) {
		return message;
	}

	// A post lock: the server names who has it open in the product editor.
	if ( code === 'wc_products_list_editing' && message ) {
		return message;
	}

	if ( code === 'rest_invalid_param' && message ) {
		return `${ text } ${ message }`;
	}

	return text;
}

const GONE_CODES: ReadonlySet< string > = new Set( [
	'woocommerce_rest_product_invalid_id',
	'woocommerce_rest_variation_invalid_id',
	// wc/v3's variations controller (woocommerce_rest_{post_type}_invalid_id) and the plugin's variations batch route.
	'woocommerce_rest_product_variation_invalid_id',
	'woocommerce_rest_invalid_id',
	'rest_post_invalid_id',
	// The server's deleted check (docs/contracts.md §3.6): deleted after the save loaded it.
	'wc_products_list_deleted',
] );

/** Whether an error code means the row no longer exists (nothing to retry; the row leaves the list). */
export function isGoneCode( code: string | undefined ): boolean {
	return code !== undefined && GONE_CODES.has( code );
}

/** A row a save of this tab still holds, so a write from elsewhere in the tab (an extension's batchUpdate) was not sent. */
export function lockedMessage(): string {
	return __( 'This item is still being saved in this tab, so it was not sent. Try again when that save is done.', 'wp-woocommerce-products-list' );
}

/** The message of a row action's per-id result: a lock held by a save of the row reads like the save's own. */
export function actionResultMessage( code: string | undefined, message: string | undefined ): string {
	if ( code === 'wc_products_list_locked' ) {
		return __( 'Another save of this item was still running, so the action was not applied to it. Try again in a moment.', 'wp-woocommerce-products-list' );
	}

	return message || __( 'The action failed.', 'wp-woocommerce-products-list' );
}
