/**
 * The one place '@wordpress/dataviews/wp' is imported from.
 *
 * The `/wp` entry inlines its own @wordpress/components, ui and theme, so it
 * never clashes with the wp-components WordPress ships; everything that
 * renders inside DataViews (fields, DataForm controls) imports from here.
 * Our own chrome around it uses core wp-components through resources/ui/.
 */
export { DataViews, DataForm, DataViewsPicker, filterSortAndPaginate, useFormValidity, VIEW_LAYOUTS } from '@wordpress/dataviews/wp';
export type * from '@wordpress/dataviews/wp';
