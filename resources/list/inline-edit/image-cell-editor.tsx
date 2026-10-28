/**
 * The table's thumbnail as a button: it opens the row's images in a popover
 * (main image and gallery, or a variation's own image), changed there with
 * the media library or by dropping files, and saved with Save as a quick
 * edit is (Undo in the snackbar). Nothing is written until Save.
 */
import { Popover } from '@wordpress/components';
import { useViewportMatch } from '@wordpress/compose';
import { useContext, useEffect, useRef, useState } from '@wordpress/element';
import { decodeEntities } from '@wordpress/html-entities';
import { speak } from '@wordpress/a11y';
import { __, sprintf } from '@wordpress/i18n';
import { Icon, pencil } from '@wordpress/icons';
import type { MouseEvent as ReactMouseEvent, SyntheticEvent } from 'react';
import { loadMedia } from '../../edit/description-modal/load-block-editor';
import { isVariation, parentIdOf } from '../../edit/field-value';
import { itemLabel } from '../../edit/item-label';
import { ImageCell } from '../../fields/components/image-cell';
import { ImagesEditor } from '../../fields/components/images-editor';
import { ownImages } from '../../fields/images';
import { isMediaFrameOpen } from '../../media/media-frame';
import type { ProductListItem, RawImage } from '../../types';
import { Button, Spinner } from '../../ui';
import { InlineEditContext } from './mode';
import { forgetImagesRows, loadImagesRow } from './gallery-cache';
import { saveRow } from './save-row';
import type { RowSaveOutcome } from './save-row';

function sameImages( a: RawImage[], b: RawImage[] ): boolean {
	return a.length === b.length && a.every( ( image, index ) => image.id === b[ index ]?.id );
}

/** Whether the row's images can be changed from the list: a real row the user may edit. */
export function canEditImages( item: ProductListItem, canEdit: boolean ): boolean {
	return canEdit && ! item._placeholder && item.wc_products_list?.can_edit !== false && item.status !== 'trash';
}

const stop = ( event: SyntheticEvent ) => event.stopPropagation();

/** How long the pointer rests on a thumbnail before the media library and the row's images start loading. */
const HOVER_INTENT_MS = 150;

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

	const intentRef = useRef< number | undefined >( undefined );
	const prepare = () => {
		void loadMedia().catch( () => {} );
		void loadImagesRow( item ).catch( () => {} );
	};

	useEffect( () => () => window.clearTimeout( intentRef.current ), [] );

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
				// The media library's scripts and the row's images start loading when the pointer rests on the thumbnail
				// (or the keyboard reaches it), not when it passes over the table.
				onPointerEnter={ () => {
					window.clearTimeout( intentRef.current );
					intentRef.current = window.setTimeout( prepare, HOVER_INTENT_MS );
				} }
				onPointerLeave={ () => window.clearTimeout( intentRef.current ) }
				onFocus={ prepare }
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
					onSave={ async ( base, images ) => {
						// The popover stays (Save busy) until the save is in: a refused one keeps the images as arranged.
						const outcome = await saveRow( base, { images }, context.fields, false );

						forgetImagesRows();

						if ( outcome.ok ) {
							close( false );
							refocus( item.id, button );
						}

						return outcome;
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
	onSave: ( base: ProductListItem, images: RawImage[] ) => Promise< RowSaveOutcome >;
}

function ImagesPopover( { anchor, item, name, onClose, onSave }: ImagesPopoverProps ) {
	const variation = isVariation( item );
	// Loaded first: a product's row carries its main image only (list reads drop the gallery), and a variation's row
	// shows its parent's image when it has none of its own (hydrate.ts reads it in the edit context).
	const [ base, setBase ] = useState< ProductListItem | null >( null );
	const [ error, setError ] = useState< string | null >( null );
	const [ images, setImages ] = useState< RawImage[] >( [] );
	const [ busy, setBusy ] = useState( false );
	const [ saving, setSaving ] = useState( false );
	// Escape with changes asks first (as quick edit does); Escape again, or Discard, throws them away.
	const [ askDiscard, setAskDiscard ] = useState( false );
	const keepRef = useRef< HTMLButtonElement | null >( null );

	// The question takes the focus when it is asked ("Keep editing", the safe answer).
	useEffect( () => {
		if ( askDiscard ) {
			keepRef.current?.focus();
		}
	}, [ askDiscard ] );
	const loaded = base ? ownImages( base ) : null;
	const dirty = loaded !== null && ! sameImages( loaded, images );
	// `keep`: a reload after a refused save keeps the images as the user arranged them.
	const load = ( keep = false ) =>
		loadImagesRow( item, true ).then( ( row ) => {
			if ( row ) {
				setBase( row );

				if ( ! keep ) {
					setImages( ownImages( row ) );
				}
			}

			return row;
		} );

	const save = async () => {
		if ( ! base ) {
			return;
		}

		setSaving( true );
		setError( null );

		const outcome = await onSave( base, images );

		if ( ! outcome.ok ) {
			setSaving( false );
			setError( outcome.message ?? __( 'The images were not saved.', 'wp-woocommerce-products-list' ) );

			// Someone else saved the product meanwhile: its images now are the base, what was arranged here stays.
			if ( outcome.code === 'wc_products_list_conflict' ) {
				await load( true ).catch( () => {} );
			}
		}
	};

	useEffect( () => {
		let live = true;

		loadImagesRow( item )
			.then( ( row ) => {
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
	// Beside the thumbnail where there is room; under it on a phone, kept on screen and scrolled if need be.
	const narrow = useViewportMatch( 'medium', '<' );
	const bodyRef = useRef< HTMLDivElement | null >( null );

	// The dialog takes the focus at once (Cancel would be the only button while the images load), then its first
	// image (or "Add images") once they are there.
	useEffect( () => {
		bodyRef.current?.focus();
	}, [] );

	useEffect( () => {
		if ( base && bodyRef.current?.contains( document.activeElement ) && document.activeElement === bodyRef.current ) {
			bodyRef.current.querySelector< HTMLElement >( '.wc-pl-images__tool, .wc-pl-images__add' )?.focus();
		}
	}, [ base ] );

	return (
		<Popover
			anchor={ anchor }
			placement={ narrow ? 'bottom' : 'right-start' }
			offset={ 8 }
			shift
			resize
			className="wc-pl-images-popover"
			focusOnMount={ false }
			// Escape closes and discards; a click elsewhere closes only when nothing changed, and never while the media library is open over it.
			onClose={ () => {
				if ( isMediaFrameOpen() || saving ) {
					return;
				}

				if ( dirty && ! askDiscard ) {
					setAskDiscard( true );
					speak( __( 'Discard the changes to the images? Press Escape again to discard them.', 'wp-woocommerce-products-list' ), 'assertive' );

					return;
				}

				onClose();
			} }
			onFocusOutside={ () => {
				if ( ! isMediaFrameOpen() && ! dirty && ! busy && ! saving ) {
					onClose( false );
				}
			} }
		>
			{ /* Clicks and keys stay here: the row under the popover in the React tree would take them for its own. */ }
			<div ref={ bodyRef } tabIndex={ -1 } className="wc-pl-images-popover__body" role="dialog" aria-label={ `${ title }: ${ name }` } onClick={ stop } onMouseDown={ stop } onKeyDown={ ( event ) => event.key !== 'Escape' && stop( event ) }>
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
					<ImagesEditor value={ images } onChange={ setImages } disabled={ saving } single={ variation } postId={ variation ? parentIdOf( item ) || item.id : item.id } itemName={ name } onBusyChange={ setBusy } />
				) }
				{ askDiscard && dirty && (
					<div className="wc-pl-images-popover__confirm" role="alert">
						<span>{ __( 'Discard the changes to the images?', 'wp-woocommerce-products-list' ) }</span>
						<Button
							ref={ keepRef }
							variant="link"
							onClick={ () => {
								setAskDiscard( false );
								// Back into the images (this button goes away with the question).
								window.requestAnimationFrame( () => bodyRef.current?.querySelector< HTMLElement >( '.wc-pl-images__tool, .wc-pl-images__add' )?.focus() );
							} }
						>
							{ __( 'Keep editing', 'wp-woocommerce-products-list' ) }
						</Button>
						<Button variant="link" isDestructive onClick={ () => onClose() }>
							{ __( 'Discard', 'wp-woocommerce-products-list' ) }
						</Button>
					</div>
				) }
				<div className="wc-pl-images-popover__footer">
					<Button variant="tertiary" size="compact" disabled={ saving } accessibleWhenDisabled onClick={ () => onClose() }>
						{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
					</Button>
					<Button variant="primary" size="compact" isBusy={ saving } disabled={ ! dirty || busy || saving } accessibleWhenDisabled onClick={ () => void save() }>
						{ __( 'Save', 'wp-woocommerce-products-list' ) }
					</Button>
				</div>
			</div>
		</Popover>
	);
}
