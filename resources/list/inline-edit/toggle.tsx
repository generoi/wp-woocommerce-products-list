/**
 * The toolbar's "Edit in table" switch, and while it is on, a line above
 * the table on how the table saves (a typed change saves on Enter or when
 * leaving the row).
 */
import { __ } from '@wordpress/i18n';
import { pencil } from '@wordpress/icons';
import { Button } from '../../ui';
import { setInlineEditing, useInlineEditing } from './mode';

export const INLINE_HINT_ID = 'wc-products-list-inline-hint';

export function InlineEditToggle() {
	const enabled = useInlineEditing();

	return (
		<Button
			size="compact"
			variant="tertiary"
			icon={ pencil }
			isPressed={ enabled }
			aria-describedby={ enabled ? INLINE_HINT_ID : undefined }
			className="wc-products-list__inline-toggle"
			onClick={ () => setInlineEditing( ! enabled ) }
		>
			{ __( 'Edit in table', 'wp-woocommerce-products-list' ) }
		</Button>
	);
}

export function InlineEditHint() {
	return (
		<p className="wc-products-list__inline-hint" id={ INLINE_HINT_ID }>
			<strong>{ __( 'Editing in the table.', 'wp-woocommerce-products-list' ) }</strong>{ ' ' }
			{ __( 'A change saves when you press Enter or leave the row; a choice in a menu saves at once. Esc takes a change back.', 'wp-woocommerce-products-list' ) }{ ' ' }
			<Button variant="link" onClick={ () => setInlineEditing( false ) }>
				{ __( 'Done', 'wp-woocommerce-products-list' ) }
			</Button>
		</p>
	);
}
