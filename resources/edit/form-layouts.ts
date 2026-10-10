/**
 * The inline edit form: a tab strip (General, one tab per extension group
 * such as a language) with one card per section, in the order a store
 * manager works (what it is, what it costs, how much is in stock, how it
 * is shown and organised, the long texts, then the rarely used settings),
 * modelled on WooCommerce's Edit product screen: a main column and a side
 * column when the form is wide, a single column in task order when it is
 * narrow. Derived from the fields themselves so extension fields land in
 * the right place without code. `wcProductsList.quickEdit.tabs` and
 * `.layout` can reshape both.
 */
import { applyFilters } from '@wordpress/hooks';
import { __, sprintf } from '@wordpress/i18n';
import type { Form, FormField } from '../dataviews';
import { getQuickEditTabs } from '../extensions/api';
import { FILTERS } from '../extensions/hooks';
import type { ProductField, ProductListItem, QuickEditTab, Settings } from '../types';
import { isVariation } from './field-value';
import { isEditorHostedAction, LANG_ARG } from './hosted-actions';
import { numericKindOf } from './bulk-numeric';
import { SCHEDULE_SALE_FIELD_ID } from './payload';
import { isSellableField, leafOf } from './visibility';

export const GENERAL_TAB_ID = 'general';

export const GROUP_LABELS: Record< string, string > = {
	general: __( 'Product', 'wp-woocommerce-products-list' ),
	pricing: __( 'Pricing', 'wp-woocommerce-products-list' ),
	price: __( 'Pricing', 'wp-woocommerce-products-list' ),
	inventory: __( 'Inventory', 'wp-woocommerce-products-list' ),
	organization: __( 'Organization', 'wp-woocommerce-products-list' ),
	visibility: __( 'Status and visibility', 'wp-woocommerce-products-list' ),
	shipping: __( 'Shipping', 'wp-woocommerce-products-list' ),
	tax: __( 'Tax', 'wp-woocommerce-products-list' ),
	external: __( 'Buy button', 'wp-woocommerce-products-list' ),
	linked: __( 'Linked products', 'wp-woocommerce-products-list' ),
	content: __( 'Description', 'wp-woocommerce-products-list' ),
	downloads: __( 'Downloads', 'wp-woocommerce-products-list' ),
	advanced: __( 'Advanced', 'wp-woocommerce-products-list' ),
	translation: __( 'Translation', 'wp-woocommerce-products-list' ),
	seo: __( 'SEO', 'wp-woocommerce-products-list' ),
	prices: __( 'Prices', 'wp-woocommerce-products-list' ),
};

/**
 * Field order on a tab (the single-column reading order): what the product
 * is, what it costs, its stock, how it is shown and organised, its texts,
 * then the rarely used settings. Groups not listed (an extension's) follow
 * the texts, in first-seen order.
 */
export const GROUP_ORDER: readonly string[] = [ 'general', 'pricing', 'price', 'external', 'inventory', 'visibility', 'organization', 'content', 'translation', 'prices', 'seo', 'shipping', 'tax', 'advanced', 'linked', 'downloads' ];

export function groupOf( field: ProductField ): string {
	return field.edit ? field.edit.group || 'general' : 'general';
}

/** The tab a field belongs to: its `edit.tab`, else its group when that is an extension group (`i18n:se`), else General. */
export function tabOf( field: ProductField ): string {
	if ( ! field.edit ) {
		return GENERAL_TAB_ID;
	}

	if ( field.edit.tab ) {
		return field.edit.tab;
	}

	const group = groupOf( field );

	return group.includes( ':' ) ? group : GENERAL_TAB_ID;
}

export function groupLabel( group: string, settings: Settings ): string {
	if ( GROUP_LABELS[ group ] ) {
		return GROUP_LABELS[ group ];
	}

	if ( group.startsWith( 'i18n:' ) ) {
		const lang = group.slice( 'i18n:'.length );

		return settings.languages?.labels[ lang ] ?? lang.toUpperCase();
	}

	return group.charAt( 0 ).toUpperCase() + group.slice( 1 ).replace( /[_-]+/g, ' ' );
}

function orderOf( field: ProductField ): number {
	return field.edit && typeof field.edit.order === 'number' ? field.edit.order : 100;
}

/* Groups not in the order (an extension's) go after the texts, before the rarely used settings (groupRank). */

function groupRank( group: string, seen: string[], order: readonly string[] = GROUP_ORDER ): number {
	const index = order.indexOf( group );
	const unknown = order.indexOf( 'seo' ) + 0.5;

	return index === -1 ? unknown + ( seen.indexOf( group ) + 1 ) / 1000 : index;
}

/**
 * The schedule-sale toggle: a virtual boolean beside the sale dates. When
 * the registry does not define one, synthesise it from the date fields so
 * the form can hide the dates until the user asks for a schedule.
 */
export function withScheduleSale( fields: ProductField[] ): ProductField[] {
	if ( fields.some( ( field ) => field.id === SCHEDULE_SALE_FIELD_ID ) ) {
		return fields;
	}

	const from = fields.find( ( field ) => field.id === 'date_on_sale_from' );
	const to = fields.find( ( field ) => field.id === 'date_on_sale_to' );
	const anchor = from ?? to;

	if ( ! anchor || anchor.edit === false ) {
		return fields;
	}

	const toggle: ProductField = {
		id: SCHEDULE_SALE_FIELD_ID,
		label: __( 'Schedule sale', 'wp-woocommerce-products-list' ),
		type: 'boolean',
		productTypes: anchor.productTypes,
		edit: { group: groupOf( anchor ), tab: anchor.edit.tab, bulk: 'default', order: orderOf( anchor ) - 0.5 },
		source: 'core',
		rest: {
			fields: [ 'date_on_sale_from', 'date_on_sale_to' ],
			applies: anchor.rest.applies,
			read: ( item ) => {
				const row = item as { date_on_sale_from?: string | null; date_on_sale_to?: string | null };

				return Boolean( row.date_on_sale_from || row.date_on_sale_to );
			},
		},
	};

	const index = fields.indexOf( anchor );

	return [ ...fields.slice( 0, index ), toggle, ...fields.slice( index ) ];
}

/** Fields of a tab, sorted by group rank then `edit.order`, then registry order. */
export function fieldsOfTab( fields: ProductField[], tab: QuickEditTab ): ProductField[] {
	const explicit = new Set( tab.fields ?? [] );
	const seen: string[] = [];

	fields.forEach( ( field ) => {
		const group = groupOf( field );

		if ( ! seen.includes( group ) ) {
			seen.push( group );
		}
	} );

	return fields
		.map( ( field, index ) => ( { field, index } ) )
		.filter( ( { field } ) => explicit.has( field.id ) || tabOf( field ) === tab.id )
		.sort( ( a, b ) => groupRank( groupOf( a.field ), seen ) - groupRank( groupOf( b.field ), seen ) || orderOf( a.field ) - orderOf( b.field ) || a.index - b.index )
		.map( ( { field } ) => field );
}

/**
 * The `group:lang` tabs the editor-hosted actions (language tools) need for
 * these items: one per language option of an action whose scope covers at
 * least one of the items.
 */
export function toolTabIds( settings: Pick< Settings, 'actions' >, items: ProductListItem[] ): Set< string > {
	const ids = new Set< string >();
	const hasProducts = items.some( ( item ) => ! isVariation( item ) );
	const hasVariations = items.some( ( item ) => isVariation( item ) );

	for ( const def of settings.actions ?? [] ) {
		if ( ! isEditorHostedAction( def ) || ! def.group ) {
			continue;
		}

		const scope = def.scope ?? 'both';

		if ( ( scope === 'product' && ! hasProducts ) || ( scope === 'variation' && ! hasVariations ) ) {
			continue;
		}

		for ( const option of def.args.find( ( arg ) => arg.id === LANG_ARG )?.options ?? [] ) {
			ids.add( `${ def.group }:${ String( option.value ) }` );
		}
	}

	return ids;
}

/**
 * The tabs for a selection: General first, then one per extension group
 * found on the fields (languages), then registered tabs; empty tabs are
 * dropped; `wcProductsList.quickEdit.tabs` runs last.
 */
export function buildTabs( fields: ProductField[], items: ProductListItem[], settings: Settings ): QuickEditTab[] {
	const tabs = new Map< string, QuickEditTab >();

	tabs.set( GENERAL_TAB_ID, { id: GENERAL_TAB_ID, label: __( 'General', 'wp-woocommerce-products-list' ), order: 0 } );

	for ( const field of fields ) {
		const id = tabOf( field );

		if ( ! tabs.has( id ) ) {
			tabs.set( id, { id, label: groupLabel( id, settings ), order: 100 } );
		}
	}

	// A language tab whose fields a bulk edit cannot set (names, SEO texts) still hosts its tools (copy, find & replace, prices).
	const toolTabs = toolTabIds( settings, items );

	for ( const id of toolTabs ) {
		if ( ! tabs.has( id ) ) {
			tabs.set( id, { id, label: groupLabel( id, settings ), order: 100 } );
		}
	}

	for ( const registered of getQuickEditTabs() ) {
		tabs.set( registered.id, { ...tabs.get( registered.id ), ...registered } );
	}

	const list = Array.from( tabs.values() )
		.sort( ( a, b ) => ( a.order ?? 100 ) - ( b.order ?? 100 ) )
		.filter( ( tab ) => tab.id === GENERAL_TAB_ID || toolTabs.has( tab.id ) || fieldsOfTab( fields, tab ).length > 0 );

	const filtered = applyFilters( FILTERS.quickEditTabs, list, items );

	return Array.isArray( filtered ) ? ( filtered as QuickEditTab[] ) : list;
}

/**
 * A form-only control field: the "apply to variations" checkbox shown as
 * the first row of Pricing. It sits in DataForm's field list only, never in
 * the edit fields, the form data or the payload (inline-editor.tsx).
 */
export const APPLY_TO_VARIATIONS_FIELD_ID = 'wcpl_apply_to_variations';

/** Groups that share a card: `price` is Pricing, linked products and downloads are Advanced settings. */
const SECTION_OF_GROUP: Record< string, string > = {
	price: 'pricing',
	linked: 'advanced',
	downloads: 'advanced',
};

/** Fields laid out under another section than their own group's (an extension's GTIN beside the SKU). */
export const LAYOUT_GROUP_OF_FIELD: Record< string, string > = {
	global_unique_id: 'inventory',
};

/**
 * Fields laid out with the product's identity in quick edit: the short description sits under the name, as the
 * language tabs' Translation card has it (fixing a name and its short text is one task); the long description keeps
 * its own card lower down. Bulk edit has no name, so there the short description stays with the description.
 */
export const QUICK_LAYOUT_GROUP_OF_FIELD: Record< string, string > = {
	short_description: 'general',
};

/** Sections of the side column when the form is wide, as WooCommerce's Edit product sidebar. */
export const SIDE_GROUPS: ReadonlySet< string > = new Set( [ 'visibility', 'organization', 'shipping', 'tax', 'advanced', 'linked', 'downloads', 'prices', 'seo' ] );

/** Rarely used sections: a collapsed card, opened by the user or by an edit, a problem or a focus request inside. */
export const COLLAPSED_GROUPS: ReadonlySet< string > = new Set( [ 'shipping', 'tax', 'advanced', 'linked', 'downloads' ] );

/**
 * Section order in a single column (a laptop-wide panel, a drawer): what it is and what it costs, then how it is
 * shown and filed (publish or draft, categories, brands: the WordPress Publish and Categories boxes, used daily),
 * then the stock, the texts, and last the rarely used settings.
 */
export const NARROW_ORDER: readonly string[] = [ 'general', 'pricing', 'price', 'external', 'visibility', 'organization', 'inventory', 'content', 'translation', 'prices', 'seo', 'shipping', 'tax', 'advanced', 'linked', 'downloads' ];

/** A form-only note at the end of a section (`wcpl_note_inventory`: why a stock edit is skipped and what to do instead). */
export const SECTION_NOTE_FIELD_PREFIX = 'wcpl_note_';

export function sectionNoteFieldId( group: string ): string {
	return `${ SECTION_NOTE_FIELD_PREFIX }${ group }`;
}

/** Section order when wide: the main column (the work), then the side column (the settings); prices come before SEO. */
export const SECTION_ORDER: readonly string[] = [ 'general', 'pricing', 'external', 'inventory', 'content', 'translation', 'visibility', 'organization', 'prices', 'seo', 'shipping', 'tax', 'advanced' ];

/** Fields shown side by side (by the last id segment, so a language's prices pair too); they stack when the card is narrow. */
export const FIELD_PAIRS: ReadonlyArray< readonly [ string, string ] > = [
	[ 'regular_price', 'sale_price' ],
	[ 'date_on_sale_from', 'date_on_sale_to' ],
	[ 'sku', 'global_unique_id' ],
	[ 'stock_quantity', 'stock_status' ],
	[ 'backorders', 'low_stock_amount' ],
	[ 'weight', 'dimensions' ],
];

/** A language tab's translated texts; its prices go to Prices and the rest (SEO titles and descriptions) to SEO. */
const TRANSLATION_LEAVES: ReadonlySet< string > = new Set( [ 'name', 'slug', 'short_description', 'description' ] );

/** A collapsed card's header value (quick edit only: in bulk one row's value would mislead). */
const SECTION_SUMMARY: Record< string, string > = {
	shipping: 'shipping_class',
	tax: 'tax_status',
};

/** A multi-line control (descriptions): on a language tab these are the translation. */
function isLongText( field: ProductField ): boolean {
	const edit = field.Edit as { control?: string } | undefined;

	return ( field.type as string ) === 'html' || field.html === true || ( typeof edit === 'object' && edit !== null && edit.control === 'textarea' );
}

function isLanguageTab( tab: QuickEditTab ): boolean {
	return tab.id.startsWith( 'i18n:' );
}

/** The section (card) a field is laid out under on `tab` (in a quick edit unless `bulk`). */
export function layoutGroupOf( field: ProductField, tab?: QuickEditTab, bulk = false ): string {
	if ( tab && isLanguageTab( tab ) ) {
		const leaf = leafOf( field.id );

		if ( isSellableField( field ) || leaf === SCHEDULE_SALE_FIELD_ID ) {
			return 'prices';
		}

		return TRANSLATION_LEAVES.has( leaf ) || isLongText( field ) ? 'translation' : 'seo';
	}

	const group = ( bulk ? undefined : QUICK_LAYOUT_GROUP_OF_FIELD[ field.id ] ) ?? LAYOUT_GROUP_OF_FIELD[ field.id ] ?? groupOf( field );

	return SECTION_OF_GROUP[ group ] ?? group;
}

/** Whether a section sits in the side column when the form is wide. */
export function isSideGroup( group: string ): boolean {
	return SIDE_GROUPS.has( group );
}

/** Whether a section starts collapsed. */
export function isCollapsedGroup( group: string ): boolean {
	return COLLAPSED_GROUPS.has( group );
}

/** The sections of a tab, each with its fields in `edit.order`, in single-column order. */
export function sectionsOfTab( fields: ProductField[], tab: QuickEditTab, leads: Record< string, string[] > = {}, bulk = false, trails: Record< string, string[] > = {} ): Array< { group: string; fields: string[] } > {
	const tabFields = fieldsOfTab( fields, tab );
	const sections = new Map< string, string[] >();

	for ( const [ group, ids ] of Object.entries( leads ) ) {
		if ( ids.length ) {
			sections.set( group, [ ...ids ] );
		}
	}

	const seen: string[] = [];

	tabFields
		.map( ( field, index ) => ( { field, index, group: layoutGroupOf( field, tab, bulk ) } ) )
		.sort( ( a, b ) => orderOf( a.field ) - orderOf( b.field ) || a.index - b.index )
		.forEach( ( { field, group } ) => {
			if ( ! seen.includes( group ) ) {
				seen.push( group );
			}

			sections.set( group, [ ...( sections.get( group ) ?? [] ), field.id ] );
		} );

	// A trailing note only ends a section that is there: it never makes a card of its own.
	for ( const [ group, ids ] of Object.entries( trails ) ) {
		const current = sections.get( group );

		if ( current && ids.length ) {
			sections.set( group, [ ...current, ...ids ] );
		}
	}

	return Array.from( sections.entries() )
		.map( ( [ group, ids ] ) => ( { group, fields: ids } ) )
		.sort( ( a, b ) => groupRank( a.group, seen, NARROW_ORDER ) - groupRank( b.group, seen, NARROW_ORDER ) );
}

/** A section's children: field ids, with the pairs as `row` layouts (aligned at the top so uneven help texts do not shift the inputs). */
function sectionChildren( ids: string[] ): Array< string | FormField > {
	const present = new Set( ids );
	const used = new Set< string >();
	const children: Array< string | FormField > = [];

	for ( const id of ids ) {
		if ( used.has( id ) ) {
			continue;
		}

		const leaf = leafOf( id );
		const prefix = id.slice( 0, id.length - leaf.length );
		const pair = FIELD_PAIRS.find( ( entry ) => entry.includes( leaf ) );
		const partner = pair ? `${ prefix }${ pair[ 0 ] === leaf ? pair[ 1 ] : pair[ 0 ] }` : null;

		if ( pair && partner && present.has( partner ) && ! used.has( partner ) ) {
			const [ first, second ] = pair[ 0 ] === leaf ? [ id, partner ] : [ partner, id ];

			used.add( first );
			used.add( second );
			children.push( { id: `pair:${ first }`, layout: { type: 'row', alignment: 'start' }, children: [ first, second ] } );
			continue;
		}

		used.add( id );
		children.push( id );
	}

	return children;
}

export interface LayoutOptions {
	/** How many columns the form is wide enough for (measured on the form itself): 2 puts the settings in a side column. */
	columns?: 1 | 2;
	/** Fields whose section opens even when it starts collapsed: a pending edit, a problem, a focus request. */
	open?: ReadonlySet< string >;
	/** Fields that open their section's card, by section (the apply-to-variations control first in Pricing); the card is kept even when it has nothing else. */
	leads?: Record< string, string[] >;
	/** Form-only notes that end a section (sectionNoteFieldId), by section; never a card on their own. */
	trails?: Record< string, string[] >;
	/** Fields with a pending edit: a card holding one says so in its title (" •", as the tabs do). */
	pending?: ReadonlySet< string >;
	/** A bulk edit: no value summaries in the collapsed headers (one row's value would mislead). */
	bulk?: boolean;
}

/** A card's title and padding, in rows of a plain field: what a closed card weighs when the columns are balanced. */
const CARD_WEIGHT = 1.5;

/** Roughly how many rows of a plain field a field takes: a text editor several, a term list or a bulk number operation more than one. */
function fieldWeight( field: ProductField | undefined, bulk: boolean ): number {
	if ( ! field ) {
		// The apply-to-variations control: a checkbox and its note.
		return 1.5;
	}

	if ( isLongText( field ) ) {
		return 6;
	}

	return field.type === 'array' || ( bulk && numericKindOf( field ) !== null ) ? 2.5 : 1;
}

/** The card title of a section; on a General tab of a translated shop, the texts say which language they are. */
function sectionLabel( group: string, tab: QuickEditTab, settings: Settings ): string {
	const languages = settings.languages;

	if ( group === 'prices' && isLanguageTab( tab ) ) {
		const currency = languages?.currencies?.[ tab.id.slice( 'i18n:'.length ) ];

		/* translators: %s: currency code, e.g. SEK */
		return currency ? sprintf( __( 'Prices (%s)', 'wp-woocommerce-products-list' ), currency ) : groupLabel( group, settings );
	}

	if ( tab.id === GENERAL_TAB_ID && languages && languages.others.length > 0 && ( group === 'general' || group === 'content' ) ) {
		const source = languages.labels[ languages.default ] ?? languages.default.toUpperCase();

		/* translators: 1: section title (Product, Description), 2: the shop's default language */
		return sprintf( __( '%1$s · %2$s', 'wp-woocommerce-products-list' ), groupLabel( group, settings ), source );
	}

	return groupLabel( group, settings );
}

/**
 * The DataForm layout of a tab for the inline editor: one card per section
 * (the rarely used ones collapsed), with paired fields side by side. When
 * the form is wide, a main column (the product, its prices, stock and
 * texts) and a side column (status, organization and settings), as
 * WooCommerce's Edit product screen; else one column in task order. Both
 * are real containers, so reading and keyboard order are the visual order.
 * `wcProductsList.quickEdit.layout` runs last.
 */
export function buildInlineForm( fields: ProductField[], tab: QuickEditTab, items: ProductListItem[], settings: Settings, options: LayoutOptions = {} ): Form {
	const { columns = 1, open, leads, trails, pending, bulk = false } = options;
	const sections = sectionsOfTab( fields, tab, leads, bulk, trails );
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );

	const cards: Array< { group: string; card: FormField; weight: number } > = sections.map( ( { group, fields: ids } ) => {
		const collapsible = isCollapsedGroup( group );
		const opened = ! collapsible || ids.some( ( id ) => open?.has( id ) );
		const marked = ids.some( ( id ) => pending?.has( id ) );
		const summary = ! bulk && SECTION_SUMMARY[ group ] && ids.includes( SECTION_SUMMARY[ group ]! ) ? [ SECTION_SUMMARY[ group ]! ] : [];

		return {
			group,
			card: {
				id: `group:${ group }`,
				label: `${ sectionLabel( group, tab, settings ) }${ marked ? ' •' : '' }`,
				layout: collapsible ? { type: 'card', isCollapsible: true, isOpened: opened, summary } : { type: 'card', isCollapsible: false },
				children: sectionChildren( ids ),
			} as FormField,
			// A pair sits side by side: it is as tall as its taller field.
			weight:
				CARD_WEIGHT +
				( opened
					? sectionChildren( ids ).reduce( ( sum, child ) => sum + ( typeof child === 'string' ? fieldWeight( byId.get( child ), bulk ) : Math.max( ...( child.children as string[] ).map( ( id ) => fieldWeight( byId.get( id ), bulk ) ) ) ), 0 )
					: 0 ),
		};
	} );

	let formFields: FormField[];

	const rank = ( group: string ) => ( SECTION_ORDER.indexOf( group ) === -1 ? SECTION_ORDER.indexOf( 'translation' ) + 0.5 : SECTION_ORDER.indexOf( group ) );
	const byRank = ( a: { group: string }, b: { group: string } ) => rank( a.group ) - rank( b.group );
	const main = cards.filter( ( entry ) => ! isSideGroup( entry.group ) ).sort( byRank );
	let side = cards.filter( ( entry ) => isSideGroup( entry.group ) ).sort( byRank );

	// The rarely used settings (Shipping, Tax, Advanced) end the shorter column, so neither column runs on alone past
	// an empty one: the side column in a quick edit (the main one ends with the long descriptions), the main column in
	// a bulk edit (no name or descriptions there, and Organization's "how to apply" selects make the side column long).
	const settingsCards = side.filter( ( entry ) => isCollapsedGroup( entry.group ) );
	const weigh = ( list: Array< { weight: number } > ) => list.reduce( ( sum, entry ) => sum + entry.weight, 0 );

	if ( settingsCards.length > 0 && settingsCards.length < side.length ) {
		const core = side.filter( ( entry ) => ! isCollapsedGroup( entry.group ) );

		if ( weigh( main ) < weigh( core ) ) {
			main.push( ...settingsCards );
			side = core;
		}
	}

	if ( columns === 2 && main.length > 0 && side.length > 0 ) {
		formFields = [
			{
				id: 'columns',
				layout: { type: 'row', alignment: 'start', styles: { 'column:main': { flex: '1.7 1 0' }, 'column:side': { flex: '1 1 0' } } },
				children: [
					{ id: 'column:main', layout: { type: 'regular', labelPosition: 'top' }, children: main.map( ( entry ) => entry.card ) },
					{ id: 'column:side', layout: { type: 'regular', labelPosition: 'top' }, children: side.map( ( entry ) => entry.card ) },
				],
			},
		];
	} else {
		formFields = cards.map( ( entry ) => entry.card );
	}

	const form: Form = {
		layout: { type: 'regular', labelPosition: 'top' },
		fields: formFields,
	};

	const filtered = applyFilters( FILTERS.quickEditLayout, form, tab, items );

	return filtered && typeof filtered === 'object' ? ( filtered as Form ) : form;
}

/**
 * The label a field carries inside the form: its `edit.label` (WooCommerce's
 * wording, "Stock status"), else its label without the tab's name on a
 * language tab ("Name", not "Svenska: Name": the tab already says it). Error
 * lists, the change summary and the list columns keep the full label.
 */
export function formLabelOf( field: ProductField, settings: Settings ): string {
	const label = field.label ?? field.id;

	if ( field.edit && field.edit.label ) {
		return field.edit.label;
	}

	const tab = tabOf( field );

	if ( tab === GENERAL_TAB_ID ) {
		return label;
	}

	const tabName = groupLabel( tab, settings );
	const escaped = tabName.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	const stripped = label.replace( new RegExp( `^${ escaped }\\s*[:·–—-]\\s*`, 'i' ), '' ).replace( new RegExp( `\\s*\\(${ escaped }\\)$`, 'i' ), '' ).trim();

	if ( ! stripped || stripped === label ) {
		return label;
	}

	return stripped.charAt( 0 ).toUpperCase() + stripped.slice( 1 );
}
