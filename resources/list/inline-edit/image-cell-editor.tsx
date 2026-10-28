/**
 * The table's thumbnail as a button: it opens the row's images in a popover
 * (main image and gallery, or a variation's own image), changed there with
 * the media library or by dropping files, and saved with Save as a quick
 * edit is (Undo in the snackbar). Nothing is written until Save.
 */
import { Popover } from '@wordpress/components';
import { useContext, useEffect, useState } from '@wordpress/element';
import { decodeEntities } from '@wordpress/html-entities';
import { __, sprintf } from '@wordpress/i18n';
import { Icon, pencil } from '@wordpress/icons';
import type { MouseEvent as ReactMouseEvent, SyntheticEvent } from 'react';
import { loadMedia } from '../../edit/description-modal/load-block-editor';
import { isVariation, parentIdOf } from '../../edit/field-value';
import { hydrateItems } from '../../edit/hydrate';
import { itemLabel } from '../../edit/item-label';
import { ImageCell } from '../../fields/components/image-cell';
import { ImagesEditor } from '../../fields/components/images-editor';
import { ownImages } from '../../fields/images';
import { isMediaFrameOpen } from '../../media/media-frame';
import type { ProductListItem, RawImage } from '../../types';
import { Button, Spinner } from '../../ui';
import { InlineEditContext } from './mode';
import { saveRow } from './save-row';

function sameImages( a: RawImage[], b: RawImage[] ): boolean {
	return a.length === b.length && a.every( ( image, index ) => image.id === b[ index ]?.id );
}

/** Whether the row's images can be changed from the list: a real row the user may edit. */
export function canEditImages( item: ProductListItem, canEdit: boolean ): boolean {
	return canEdit && ! item._placeholder && item.wc_products_list?.can_edit !== false && item.status !== 'trash';
}

const stop = ( event: SyntheticEvent ) => event.stopPropagation();

/**
 * Focus back on the row's thumbnail once its save is done, unless the user
 * moved on: the row is locked while it saves (the button disabled, which
 * drops the focus) and may be drawn anew, so the button is looked up again
 * until it can take the focus (a second at most).
 */
function refocus( rowId: number, known: HTMLButtonElement | null, tries = 20 ): void {
	window.setTimeout( () => {
		const active = document.activeElement;

		if ( active && active !== document.body ) {
			return;
		}

		const target = known?.isConnected ? known : document.querySelector< HTMLButtonElement >( `[data-wcpl-image-button="${ rowId }"]` );

		if ( target && ! target.disabled ) {
			target.focus();
		} else if ( tries > 0 ) {
			refocus( rowId, known, tries - 1 );
		}
	}, 50 );
}

export function EditableImageCell( { item }: { item: ProductListItem } ) {
	const context = useContext( InlineEditContext );

	if ( ! context || ! canEditImages( item, context.settings.caps.edit ) ) {
		return <ImageCell item={ item } />;
	}

	// While the row saves, the row lock (hierarchy/row-lock.ts) disables the button; a `disabled` prop of ours would
	// race the lock's restore and could leave it disabled.
	return <ImageButton item={ item } />;
}

function ImageButton( { item }: { item: ProductListItem } ) {
	const context = useContext( InlineEditContext )!;
	const [ open, setOpen ] = useState( false );
	const [ button, setButton ] = useState< HTMLButtonElement | null >( null );
	const variation = isVariation( item );
	const name = decodeEntities( itemLabel( item ) );
	const label = variation
		? sprintf( /* translators: %s: variation name */ __( 'Change the image of %s', 'wp-woocommerce-products-list' ), name )
		: sprintf( /* translators: %s: product name */ __( 'Change the images of %s', 'wp-woocommerce-products-list' ), name );

	const close = ( focus = true ) => {
		setOpen( false );

		if ( focus ) {
			window.requestAnimationFrame( () => button?.focus() );
		}
	};

	return (
		<>
			<button
				ref={ setButton }
				type="button"
				className="wc-products-list__image-button"
				data-wcpl-image-button={ item.id }
				aria-label={ label }
				aria-haspopup="dialog"
				aria-expanded={ open }
				// The media library's scripts start loading when the pointer is on the way (they take a moment the first time).
				onPointerEnter={ () => void loadMedia().catch( () => {} ) }
				onClick={ ( event: ReactMouseEvent ) => {
					event.stopPropagation();
					setOpen( ( current ) => ! current );
				} }
			>
				<ImageCell item={ item } />
				<span className="wc-products-list__image-edit" aria-hidden="true">
					<Icon icon={ pencil } size={ 16 } />
				</span>
			</button>
			{ open && button && (
				<ImagesPopover
					anchor={ button }
					item={ item }
					name={ name }
					onClose={ close }
					onSave={ ( base, images ) => {
						close();
						// The row is locked while it saves (its button disabled), which drops the focus: it comes back here after.
						void saveRow( base, { images }, context.fields ).then( () => refocus( item.id, button ) );
					} }
				/>
			) }
		</>
	);
}

interface ImagesPopoverProps {
	anchor: HTMLElement;
	item: ProductListItem;
	name: string;
	onClose: ( focus?: boolean ) => void;
	onSave: ( base: ProductListItem, images: RawImage[] ) => void;
}

function ImagesPopover( { anchor, item, name, onClose, onSave }: ImagesPopoverProps ) {
	const variation = isVariation( item );
	// Loaded first: a product's row carries its main image only (list reads drop the gallery), and a variation's row
	// shows its parent's image when it has none of its own (hydrate.ts reads it in the edit context).
	const [ base, setBase ] = useState< ProductListItem | null >( null );
	const [ error, setError ] = useState< string | null >( null );
	const [ images, setImages ] = useState< RawImage[] >( [] );
	const [ busy, setBusy ] = useState( false );
	const loaded = base ? ownImages( base ) : null;
	const dirty = loaded !== null && ! sameImages( loaded, images );
	useEffect( () => {
		let live = true;

		hydrateItems( [ item ], [ 'id', 'images', 'date_modified_gmt' ] )
			.then( ( [ row ] ) => {
				if ( live && row ) {
					setBase( row );
					setImages( ownImages( row ) );
				}
			} )
			.catch( ( caught: unknown ) => {
				if ( live ) {
					setError( caught instanceof Error ? caught.message : __( 'The images could not be loaded.', 'wp-woocommerce-products-list' ) );
				}
			} );

		return () => {
			live = false;
		};
		// Loaded once per opening.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [] );

	const title = variation ? __( 'Variation image', 'wp-woocommerce-products-list' ) : __( 'Product images', 'wp-woocommerce-products-list' );
	const fallback = variation && images.length === 0 && ( item as { images?: RawImage[] } ).images?.length ? __( 'Until one is set, the variation shows the product’s main image.', 'wp-woocommerce-products-list' ) : null;

	return (
		<Popover
			anchor={ anchor }
			placement="right-start"
			offset={ 8 }
			className="wc-pl-images-popover"
			focusOnMount="firstElement"
			// Escape closes and discards; a click elsewhere closes only when nothing changed, and never while the media library is open over it.
			onClose={ () => {
				if ( ! isMediaFrameOpen() ) {
					onClose();
				}
			} }
			onFocusOutside={ () => {
				if ( ! isMediaFrameOpen() && ! dirty && ! busy ) {
					onClose( false );
				}
			} }
		>
			{ /* Clicks and keys stay here: the row under the popover in the React tree would take them for its own. */ }
			<div className="wc-pl-images-popover__body" role="dialog" aria-label={ `${ title }: ${ name }` } onClick={ stop } onMouseDown={ stop } onKeyDown={ ( event ) => event.key !== 'Escape' && stop( event ) }>
				<div className="wc-pl-images-popover__header">
					<h2 className="wc-pl-images-popover__title">{ title }</h2>
					<span className="wc-pl-images-popover__name">{ name }</span>
				</div>
				{ error && (
					<p className="wc-pl-images__error" role="alert">
						{ error }
					</p>
				) }
				{ ! base && ! error ? (
					<div className="wc-pl-images-popover__loading">
						<Spinner />
						<span className="screen-reader-text">{ __( 'Loading the images…', 'wp-woocommerce-products-list' ) }</span>
					</div>
				) : null }
				{ base && (
					<ImagesEditor value={ images } onChange={ setImages } single={ variation } postId={ variation ? parentIdOf( item ) || item.id : item.id } itemName={ name } onBusyChange={ setBusy } />
				) }
				{ fallback && <p className="wc-pl-images__hint">{ fallback }</p> }
				<div className="wc-pl-images-popover__footer">
					<Button variant="tertiary" size="compact" onClick={ () => onClose() }>
						{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
					</Button>
					<Button variant="primary" size="compact" disabled={ ! dirty || busy } accessibleWhenDisabled onClick={ () => base && onSave( base, images ) }>
						{ __( 'Save', 'wp-woocommerce-products-list' ) }
					</Button>
				</div>
			</div>
		</Popover>
	);
}
