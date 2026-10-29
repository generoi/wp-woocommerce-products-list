/**
 * The "Edit in table" switch beside the status tabs, and while it is on,
 * how the table saves (a typed change saves on Enter or when leaving the
 * row) before it, in the same row: nothing above the table moves when the
 * mode is switched.
 */
import { ToggleControl } from '@wordpress/components';
import { __ } from '@wordpress/i18n';
import { setInlineEditing, useInlineEditing } from './mode';

export const INLINE_HINT_ID = 'wc-products-list-inline-hint';

const HINT = () => __( 'Saves on Enter or when you leave the row. Esc takes a change back.', 'wp-woocommerce-products-list' );

/** A mode, so a switch (beside the status tabs, where the crowded toolbar never pushes it out of view). */
export function InlineEditToggle() {
	const enabled = useInlineEditing();

	return (
		<div className="wc-products-list__inline-toggle">
			{ enabled && (
				<p className="wc-products-list__inline-hint" id={ INLINE_HINT_ID } title={ HINT() }>
					{ HINT() }
				</p>
			) }
			<ToggleControl
				__nextHasNoMarginBottom
				label={ __( 'Edit in table', 'wp-woocommerce-products-list' ) }
				checked={ enabled }
				aria-describedby={ enabled ? INLINE_HINT_ID : undefined }
				onChange={ ( next: boolean ) => setInlineEditing( next ) }
			/>
		</div>
	);
}
