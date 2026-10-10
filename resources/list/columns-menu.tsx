/**
 * "Columns": the toolbar's column picker. DataViews' own Properties list is
 * one flat alphabetical list of every field (eighty entries with six
 * languages, "Dansk: Description" before "Price"), so this one has a search
 * box and sections (Product, Pricing, Stock, Shipping, Content, then one per
 * language), and a column is found in two or three keystrokes. Toggling a
 * column changes `view.fields` only; the list refetches when the new column
 * needs wc/v3 keys the page was not loaded with (the query key carries
 * `_fields`), and not otherwise.
 */
import { useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import type { View } from '../dataviews';
import type { ProductField, Settings } from '../types';
import { Button, Dropdown } from '../ui';

export interface ColumnGroup {
	id: string;
	label: string;
	fields: ProductField[];
}

const SECTION_OF_EDIT_GROUP: Record< string, string > = {
	general: 'product',
	organization: 'product',
	visibility: 'product',
	advanced: 'product',
	pricing: 'pricing',
	tax: 'pricing',
	inventory: 'stock',
	shipping: 'shipping',
	content: 'content',
};

/** Read-only core fields (no `edit.group`), and fields whose edit card is not their column section (SKU and Virtual are product properties in the list, Inventory and Shipping in the edit form). */
const SECTION_OF_FIELD: Record< string, string > = {
	sku: 'product',
	virtual: 'product',
	price: 'pricing',
	on_sale: 'pricing',
	cost_of_goods_sold: 'pricing',
	date_created: 'product',
	date_modified: 'product',
	type: 'product',
	id: 'product',
	permalink: 'product',
	catalog_visibility: 'product',
	featured: 'product',
};

const SECTION_ORDER = [ 'product', 'pricing', 'stock', 'shipping', 'content' ];

function sectionLabels(): Record< string, string > {
	return {
		product: __( 'Product', 'wp-woocommerce-products-list' ),
		pricing: __( 'Pricing', 'wp-woocommerce-products-list' ),
		stock: __( 'Stock', 'wp-woocommerce-products-list' ),
		shipping: __( 'Shipping', 'wp-woocommerce-products-list' ),
		content: __( 'Content', 'wp-woocommerce-products-list' ),
		other: __( 'Other', 'wp-woocommerce-products-list' ),
	};
}

/** A field the picker offers: a real column that may be hidden, not the title, media or a filter. */
export function isColumnField( field: ProductField, view: View ): boolean {
	return (
		! field.filterOnly &&
		field.enableHiding !== false &&
		field.type !== 'media' &&
		field.id !== view.titleField &&
		field.id !== view.mediaField &&
		field.id !== view.descriptionField
	);
}

function sectionOf( field: ProductField, settings: Settings ): { id: string; label: string } {
	const group = field.columnGroup ?? ( field.edit !== false ? field.edit.group : undefined );

	if ( group?.startsWith( 'i18n:' ) ) {
		const lang = group.slice( 'i18n:'.length );

		return { id: group, label: settings.languages?.labels?.[ lang ] ?? lang };
	}

	const labels = sectionLabels();
	// A core field is a product property whatever its edit group; an extension field without a group sits under its source.
	const id = SECTION_OF_FIELD[ field.id ] ?? ( group ? SECTION_OF_EDIT_GROUP[ group ] : undefined ) ?? ( field.source && field.source !== 'core' ? field.source : field.source === 'core' ? 'product' : 'other' );

	return { id, label: labels[ id ] ?? id };
}

/** The picker's sections, in field order inside each; core sections first, then the languages in the settings' order, then the rest. */
export function groupColumns( fields: ProductField[], view: View, settings: Settings ): ColumnGroup[] {
	const groups = new Map< string, ColumnGroup >();

	for ( const field of fields ) {
		if ( ! isColumnField( field, view ) ) {
			continue;
		}

		const section = sectionOf( field, settings );
		const group = groups.get( section.id ) ?? { ...section, fields: [] };

		group.fields.push( field );
		groups.set( section.id, group );
	}

	const order = [ ...SECTION_ORDER, ...( settings.languages?.others ?? [] ).map( ( lang ) => `i18n:${ lang }` ) ];
	const rank = ( id: string ) => {
		const index = order.indexOf( id );

		return index === -1 ? order.length : index;
	};

	return Array.from( groups.values() ).sort( ( a, b ) => rank( a.id ) - rank( b.id ) );
}

/** The sections with only the fields whose label contains `query` (case-insensitive); empty sections dropped. */
export function searchColumns( groups: ColumnGroup[], query: string ): ColumnGroup[] {
	const needle = query.trim().toLowerCase();

	if ( ! needle ) {
		return groups;
	}

	return groups
		.map( ( group ) => ( { ...group, fields: group.fields.filter( ( field ) => `${ group.label } ${ field.label }`.toLowerCase().includes( needle ) ) } ) )
		.filter( ( group ) => group.fields.length > 0 );
}

/** The view with the column shown or hidden; a shown column goes last. */
export function toggleColumn( view: View, fieldId: string ): View {
	const current = view.fields ?? [];

	return { ...view, fields: current.includes( fieldId ) ? current.filter( ( id ) => id !== fieldId ) : [ ...current, fieldId ] } as View;
}

export interface ColumnsMenuProps {
	fields: ProductField[];
	view: View;
	onChangeView: ( view: View ) => void;
	settings: Settings;
}

export function ColumnsPanel( { fields, view, onChangeView, settings }: ColumnsMenuProps ) {
	const [ search, setSearch ] = useState( '' );
	const groups = useMemo( () => groupColumns( fields, view, settings ), [ fields, view, settings ] );
	const shown = useMemo( () => searchColumns( groups, search ), [ groups, search ] );
	const visible = new Set( view.fields ?? [] );

	return (
		<div className="wc-products-list__columns-panel">
			<input
				type="search"
				className="wc-products-list__columns-search"
				placeholder={ __( 'Find a column…', 'wp-woocommerce-products-list' ) }
				aria-label={ __( 'Find a column', 'wp-woocommerce-products-list' ) }
				value={ search }
				onChange={ ( event ) => setSearch( event.target.value ) }
				autoFocus
			/>
			{ shown.map( ( group ) => (
				<fieldset key={ group.id } className="wc-products-list__columns-group">
					<legend className="wc-products-list__columns-group-label">{ group.label }</legend>
					{ group.fields.map( ( field ) => (
						<label key={ field.id } className="wc-products-list__columns-option">
							<input type="checkbox" checked={ visible.has( field.id ) } onChange={ () => onChangeView( toggleColumn( view, field.id ) ) } />
							<span>{ field.label }</span>
						</label>
					) ) }
				</fieldset>
			) ) }
			{ shown.length === 0 && <p className="wc-products-list__columns-empty">{ __( 'No column matches.', 'wp-woocommerce-products-list' ) }</p> }
		</div>
	);
}

export function ColumnsMenu( props: ColumnsMenuProps ) {
	const count = props.view.fields?.length ?? 0;

	return (
		<Dropdown
			className="wc-products-list__columns"
			contentClassName="wc-products-list__columns-popover"
			popoverProps={ { placement: 'bottom-start' } }
			renderToggle={ ( { isOpen, onToggle } ) => (
				<Button size="compact" variant="tertiary" onClick={ onToggle } aria-expanded={ isOpen } aria-haspopup="dialog">
					{ __( 'Columns', 'wp-woocommerce-products-list' ) }
					{ count > 0 && <span className="wc-products-list__columns-count">{ count }</span> }
				</Button>
			) }
			renderContent={ () => <ColumnsPanel { ...props } /> }
		/>
	);
}
