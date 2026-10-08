/**
 * Extension demo for wp-woocommerce-products-list.
 *
 * A drop-in script: no build step, no PHP beyond enqueueing it. It adds
 *
 *   1. a read-only "Total sales" column,
 *   2. a "Price range" filter that sends min_price / max_price to wc/v3,
 *   3. a "Notes" quick-edit tab with an editable "Internal note" field stored
 *      in product meta (wc/v3 meta_data, so it is saved and logged like any
 *      other field, on products and variations, in bulk too),
 *   4. a "Clear sale price" bulk action that saves through the app's batch
 *      path (variations first, one log batch) and shows a notice,
 *   5. a query param on the Published tab, through addQueryParams.
 *
 * Install as a must-use plugin:
 *
 *   web/app/mu-plugins/wc-products-list-demo.php
 *
 *     <?php
 *     add_action('wc_products_list/enqueue', function (string $handle) {
 *         wp_enqueue_script(
 *             'wc-products-list-demo',
 *             WPMU_PLUGIN_URL . '/wc-products-list-demo/extension-demo.js',
 *             [$handle, 'wp-hooks'],
 *             '1.0.0',
 *             true
 *         );
 *     });
 *
 *   web/app/mu-plugins/wc-products-list-demo/extension-demo.js  (this file)
 *
 * The script runs after the app's module code and before it mounts, so
 * `window.wcProductsList` already exists; the `wcProductsList.ready` action
 * covers the case where it does not (a script enqueued without the handle
 * as a dependency, or loaded later).
 */
( function () {
	'use strict';

	var NOTE_KEY = '_wc_products_list_note';

	function readMeta( item, key ) {
		var list = Array.isArray( item.meta_data ) ? item.meta_data : [];

		for ( var i = 0; i < list.length; i++ ) {
			if ( list[ i ].key === key ) {
				return list[ i ].value;
			}
		}

		return '';
	}

	function setup( api ) {
		var __ = wp.i18n.__;

		// 1. A column. `rest.fields` tells the list which wc/v3 keys to ask
		//    for (`_fields`) when the column is visible.
		api.registerField( {
			id: 'total_sales',
			label: __( 'Total sales', 'wc-products-list-demo' ),
			type: 'integer',
			readOnly: true,
			enableSorting: false,
			rest: { fields: [ 'total_sales' ], applies: { product: true, variation: false } },
			productTypes: 'all',
			edit: false,
			source: 'demo',
		} );

		// 2. A filter. No column: `filterOnly`, no value. `rest.toParams`
		//    turns the picked option into wc/v3 params.
		var ranges = {
			'under-50': { max_price: '50' },
			'50-150': { min_price: '50', max_price: '150' },
			'over-150': { min_price: '150' },
		};

		api.registerField( {
			id: 'demo_price_range',
			label: __( 'Price range', 'wc-products-list-demo' ),
			elements: [
				{ value: 'under-50', label: __( 'Under 50', 'wc-products-list-demo' ) },
				{ value: '50-150', label: __( '50 – 150', 'wc-products-list-demo' ) },
				{ value: 'over-150', label: __( 'Over 150', 'wc-products-list-demo' ) },
			],
			filterBy: { operators: [ 'is' ], isPrimary: false },
			filterOnly: true,
			readOnly: true,
			enableSorting: false,
			getValue: function () {
				return undefined;
			},
			render: function () {
				return null;
			},
			rest: {
				fields: [],
				applies: { product: true, variation: false },
				toParams: function ( value ) {
					return ranges[ value ] || {};
				},
			},
			productTypes: 'all',
			edit: false,
			source: 'demo',
		} );

		// 3. A quick-edit tab and an editable field on it. The value lives in
		//    wc/v3 `meta_data`; `rest.write` builds the request fragment.
		api.registerQuickEditTab( { id: 'notes', label: __( 'Notes', 'wc-products-list-demo' ), order: 300 } );

		api.registerField( {
			id: 'demo_note',
			label: __( 'Internal note', 'wc-products-list-demo' ),
			type: 'text',
			Edit: { control: 'textarea', rows: 3 },
			enableSorting: false,
			getValue: function ( args ) {
				return readMeta( args.item, NOTE_KEY );
			},
			setValue: function ( args ) {
				return { meta_data: [ { key: NOTE_KEY, value: args.value } ] };
			},
			rest: {
				fields: [ 'meta_data' ],
				read: function ( item ) {
					return readMeta( item, NOTE_KEY );
				},
				write: function ( value ) {
					return { meta_data: [ { key: NOTE_KEY, value: value } ] };
				},
				applies: { product: true, variation: true },
			},
			productTypes: 'all',
			edit: { group: 'notes', tab: 'notes', bulk: 'default' },
			source: 'demo',
		} );

		// 4. A bulk action. `batchUpdate` saves variations first (per
		//    parent), then parents, under one batch id, so the History
		//    screen can revert it as a unit.
		api.registerAction( {
			id: 'demo_clear_sale',
			label: __( 'Clear sale price', 'wc-products-list-demo' ),
			supportsBulk: true,
			source: 'demo',
			isEligible: function ( item ) {
				return ! item._placeholder && !! item.sale_price;
			},
			callback: function ( items, context ) {
				var update = { products: [], variations: {} };

				items.forEach( function ( item ) {
					if ( item._kind === 'variation' ) {
						update.variations[ item._parentId ] = update.variations[ item._parentId ] || [];
						update.variations[ item._parentId ].push( { id: item.id, sale_price: '' } );
					} else {
						update.products.push( { id: item.id, sale_price: '' } );
					}
				} );

				api.batchUpdate( update, { source: 'extension' } ).then( function ( result ) {
					if ( result.errors.length ) {
						api.notices.error(
							wp.i18n.sprintf(
								/* translators: %d: number of rows that failed */
								__( '%d rows could not be updated.', 'wc-products-list-demo' ),
								result.errors.length
							)
						);
					} else {
						api.notices.success(
							wp.i18n.sprintf(
								/* translators: %d: number of rows updated */
								__( 'Sale price cleared on %d rows.', 'wc-products-list-demo' ),
								result.updated.length
							)
						);
					}

					if ( context && context.onActionPerformed ) {
						context.onActionPerformed( result.updated );
					}
				} );
			},
		} );

		// 5. Extra list params. Here: only in-stock items on the Published tab.
		api.addQueryParams( function ( params, context ) {
			if ( context.tab !== 'publish' ) {
				return params;
			}

			return Object.assign( {}, params, { stock_status: 'instock' } );
		} );

		// The same api is reachable through wp.hooks; for instance to drop a
		// core column you do not want:
		//
		// api.hooks.addFilter( api.hooks.filters.fields, 'demo/wc-products-list', function ( fields ) {
		//     return fields.filter( function ( field ) { return field.id !== 'date_created'; } );
		// } );
	}

	if ( window.wcProductsList ) {
		setup( window.wcProductsList );
	} else {
		wp.hooks.addAction( 'wcProductsList.ready', 'demo/wc-products-list', setup );
	}
} )();
